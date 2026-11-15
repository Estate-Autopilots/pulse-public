"""VITALS-HOSTS (owner, 4 Nov 2026): tools/pulse-domain-check.py passes a host family that does its jobs and names
every way one can go wrong (a wrong issuer, a cookie with Domain=, a stray page served on mcp.). It runs against a
small stand-in server here, by Host header, exactly as `--edge` runs against the local Pulse. No database, no network."""
import importlib.util
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "tools/pulse-domain-check.py"
spec = importlib.util.spec_from_file_location("pulse_domain_check", SCRIPT)
check = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = check  # dataclasses look their module up while the script loads
spec.loader.exec_module(check)

D = "vitals.test"
APP, API, MCP, ID, ALIAS = f"app.{D}", f"api.{D}", f"mcp.{D}", f"id.{D}", "pulse.legacy.test"


def stand_in(broken: set[str]):
    """Answers like Pulse with PULSE_HOST_FAMILIES = app/api/mcp/id under vitals.test, plus the old address ALIAS."""

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def send(self, status, body=b"", kind="application/json", extra=()):
            self.send_response(status)
            self.send_header("content-type", kind)
            for k, v in extra:
                self.send_header(k, v)
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def answer(self, method):
            host = self.headers.get("Host", "").split(":")[0]
            path = self.path.split("?")[0]
            issuer = f"https://{ALIAS}" if host == ALIAS else ("https://wrong.test" if "issuer" in broken else f"https://{ID}")
            mcp = f"https://{host}" if host in (APP, MCP, ALIAS) else f"https://{MCP}"
            cookie = [("set-cookie", "pulse_session=x; Path=/; HttpOnly" + ("; Domain=.vitals.test" if "cookie" in broken else ""))]
            own = {APP: lambda p: True, ALIAS: lambda p: True, API: lambda p: p.startswith("/api/") or p.startswith("/.well-known/"),
                   MCP: lambda p: p == "/mcp" or p.startswith("/.well-known/oauth-"),
                   ID: lambda p: p.startswith("/.well-known/") or p.startswith("/oauth/") or p.startswith("/login")}
            if host not in own:
                return self.send(404, b"no", "text/plain")
            if not own[host](path) and not ("stray" in broken and host == MCP and path == "/"):
                if method == "GET":
                    return self.send(302, extra=[("location", f"https://{APP}{self.path}")])
                return self.send(404, b"Pulse is at https://app", "text/plain")
            if path == "/login":
                return self.send(200, b"<html>sign in</html>", "text/html; charset=utf-8", cookie)
            if path == "/" and host == MCP:
                return self.send(200, b"<html>stray</html>", "text/html")
            if path == "/api/v0/brand":
                return self.send(200, b'{"name":"Synthetic"}')
            if path == "/.well-known/oauth-authorization-server":
                return self.send(200, json.dumps({"issuer": issuer, "authorization_endpoint": f"{issuer}/oauth/mcp/authorize", "token_endpoint": f"{issuer}/oauth/mcp/token",
                                                  "registration_endpoint": f"{issuer}/oauth/mcp/register", "code_challenge_methods_supported": ["S256"],
                                                  "authorization_response_iss_parameter_supported": True}).encode())
            if path.startswith("/.well-known/oauth-protected-resource"):
                return self.send(200, json.dumps({"resource": f"{mcp}/mcp", "authorization_servers": [issuer]}).encode())
            if path == "/mcp" and method == "POST":
                self.rfile.read(int(self.headers.get("content-length", 0)))
                return self.send(401, b'{"error":"unauthorized"}', extra=[("www-authenticate", f'Bearer resource_metadata="{mcp}/.well-known/oauth-protected-resource/mcp"')])
            if path == "/oauth/mcp/register":
                return self.send(405, b"", extra=[("allow", "POST, OPTIONS")])
            return self.send(404, b"", "text/plain")

        def do_GET(self):
            self.answer("GET")

        def do_POST(self):
            self.answer("POST")

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


@pytest.fixture
def edge():
    servers = []

    def start(*broken):
        s = stand_in(set(broken))
        servers.append(s)
        return f"http://127.0.0.1:{s.server_address[1]}"

    yield start
    for s in servers:
        s.shutdown()


def results(edge_url, *extra):
    p = check.argparse.Namespace(domain=D, families=None, alias=[ALIAS], edge=edge_url, only=None)
    for k, v in extra:
        setattr(p, k, v)
    return check.run(p)


def test_a_family_that_does_its_jobs_passes(edge, capsys):
    rs = results(edge())
    assert rs and all(r.ok for r in rs), [(r.host, r.check, r.detail) for r in rs if not r.ok]
    assert {r.host for r in rs} == {APP, API, MCP, ID, ALIAS}
    assert check.report(rs, quiet=True) is True
    assert "OK:" in capsys.readouterr().out
    # The command line: --edge, the default alias replaced, exit 0.
    assert check.main(["--edge", edge(), "--domain", D, "--alias", ALIAS, "--quiet"]) == 0


def test_a_wrong_issuer_fails_on_every_host_that_names_it(edge):
    bad = [r for r in results(edge("issuer")) if not r.ok]
    assert {r.host for r in bad} == {APP, API, MCP, ID}
    assert any("issuer" in r.check and r.host == ID for r in bad)


def test_a_cookie_for_the_whole_domain_fails(edge):
    bad = [r for r in results(edge("cookie")) if not r.ok]
    assert bad and all("host-only" in r.check for r in bad)
    assert check.main(["--edge", edge("cookie"), "--domain", D, "--alias", ALIAS, "--quiet"]) == 1


def test_a_page_served_on_mcp_fails(edge):
    bad = [r for r in results(edge("stray")) if not r.ok]
    assert [(r.host, r.check) for r in bad] == [(MCP, "GET / goes to the app")]


def test_families_json_and_only(edge):
    fam = json.dumps([{"name": "vitals", "app": APP, "mcp": MCP, "id": ID}])
    rs = results(edge(), ("families", fam), ("only", [MCP]))
    assert rs and {r.host for r in rs} == {MCP} and all(r.ok for r in rs)


def test_a_host_that_does_not_answer_fails_cleanly():
    rs = results("http://127.0.0.1:9")
    assert rs and not any(r.ok for r in rs)
