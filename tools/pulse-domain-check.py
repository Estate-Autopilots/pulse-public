#!/usr/bin/env python3
"""VITALS-HOSTS (owner, 4 Nov 2026: "move Pulse to vitalsos.ai"): check every Pulse host does its job, before and after DNS.

A port of Sales X-Ray's scripts/ops/salesxray-domain-check.py. Each family host (app, api, mcp, id) and each permanent
alias (the install's old address) is asked for what it must answer, and where it must send everything else:

  app     /login is the sign-in page; discovery names the family's one issuer; /api/v0/brand answers
  api     /api/v0/brand answers; its metadata names the family's MCP host and issuer; any other GET goes 302 to the app
  mcp     the RFC 9728 metadata names https://mcp.../mcp and the issuer; an unsigned /mcp call gets the 401 challenge
          that leads there; any other GET goes 302 to the app host
  id      the RFC 8414 metadata: issuer https://id..., endpoints on id, PKCE S256 and `iss` in the response; /login
  alias   its own issuer and MCP resource, unchanged (existing MCP connections), and /login
and no response anywhere sets a cookie with Domain= (cookies stay host-only on every host).

  # dark launch: Host headers straight to the local Pulse, no DNS needed
  python3 tools/pulse-domain-check.py --edge http://127.0.0.1:4002
  # the public hosts, once DNS exists; --watch repeats and prints ALERT / RECOVERED lines when the state changes
  python3 tools/pulse-domain-check.py
  python3 tools/pulse-domain-check.py --watch 300

Read-only: GET, HEAD and one unsigned POST /mcp (refused with 401 before it reaches any data). Nothing is registered,
nobody is signed in, nothing is sent. Exit 0 when every check passes, 1 otherwise.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timezone

HOST = re.compile(r"^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$")
ROLES = ("app", "api", "mcp", "id")


@dataclass
class Family:
    name: str
    app: str
    api: str | None = None
    mcp: str | None = None
    id: str | None = None

    def hosts(self) -> list[tuple[str, str]]:
        return [(role, getattr(self, role)) for role in ROLES if getattr(self, role)]


@dataclass
class Answer:
    status: int
    headers: dict[str, list[str]] = field(default_factory=dict)
    body: bytes = b""
    error: str | None = None

    def header(self, name: str) -> str:
        return ", ".join(self.headers.get(name.lower(), []))

    def json(self):
        try:
            return json.loads(self.body.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return None


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):  # every 3xx is an answer to check, never followed
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)


def local(host: str) -> bool:
    return host in ("localhost", "127.0.0.1") or host.endswith(".localhost")


def origin(host: str, port: str | None) -> str:
    """What Pulse names a host (apps/web/app/lib/host-families.mjs hostOrigin): https, or http with the port locally."""
    return f"http://{host}{':' + port if port else ''}" if local(host) else f"https://{host}"


def fetch(edge: str | None, host: str, path: str, method: str = "GET", body: bytes | None = None, headers: dict | None = None, timeout: float = 15) -> Answer:
    if edge:
        url = edge.rstrip("/") + path
        port = urllib.parse.urlsplit(edge).port
        send_host = f"{host}:{port}" if local(host) and port else host
    else:
        url = f"https://{host}{path}"
        send_host = host
    request = urllib.request.Request(url, data=body, method=method, headers={"Host": send_host, "User-Agent": "pulse-domain-check/1", **(headers or {})})
    try:
        with _OPENER.open(request, timeout=timeout) as response:
            return _answer(response.status, response.headers, response.read(200_000))
    except urllib.error.HTTPError as error:
        return _answer(error.code, error.headers, error.read(200_000) if error.fp else b"")
    except (urllib.error.URLError, OSError, TimeoutError) as error:
        return Answer(0, error=str(getattr(error, "reason", error)))


def _answer(status, headers, body) -> Answer:
    out: dict[str, list[str]] = {}
    for key, value in headers.items():
        out.setdefault(key.lower(), []).append(value)
    return Answer(status, out, body)


@dataclass
class Result:
    host: str
    check: str
    ok: bool
    detail: str = ""


class Checker:
    def __init__(self, edge: str | None):
        self.edge = edge
        self.port = str(urllib.parse.urlsplit(edge).port) if edge and urllib.parse.urlsplit(edge).port else None
        self.results: list[Result] = []

    def o(self, host: str) -> str:
        return origin(host, self.port if self.edge else None)

    def get(self, host: str, path: str, **kw) -> Answer:
        answer = fetch(self.edge, host, path, **kw)
        for cookie in answer.headers.get("set-cookie", []):
            if re.search(r";\s*domain=", cookie, re.I):
                self.add(host, f"{path}: cookies are host-only", False, f"Set-Cookie with Domain=: {cookie.split('=')[0]}")
        return answer

    def add(self, host: str, check: str, ok: bool, detail: str = "") -> None:
        self.results.append(Result(host, check, ok, detail))

    def expect_status(self, host: str, path: str, status: int, what: str, method: str = "GET") -> Answer:
        a = self.get(host, path, method=method)
        self.add(host, f"{method} {path} {what}", a.status == status, a.error or f"HTTP {a.status}, want {status}")
        return a

    def expect_redirect(self, host: str, path: str, to: str) -> None:
        a = self.get(host, path)
        where = a.header("location")
        self.add(host, f"GET {path} goes to the app", a.status in (301, 302, 307, 308) and where == to, a.error or f"HTTP {a.status} -> {where or 'nowhere'}, want {to}")

    def expect_login(self, host: str) -> None:
        a = self.get(host, "/login")
        ok = a.status == 200 and "text/html" in a.header("content-type")
        self.add(host, "GET /login is the sign-in page", ok, a.error or f"HTTP {a.status} {a.header('content-type')}")

    def expect_brand_api(self, host: str) -> None:
        a = self.get(host, "/api/v0/brand")
        self.add(host, "GET /api/v0/brand answers", a.status == 200 and isinstance(a.json(), dict), a.error or f"HTTP {a.status}")

    def expect_resource(self, host: str, path: str, resource: str, issuer: str) -> None:
        a = self.get(host, path)
        doc = a.json() if a.status == 200 else None
        ok = isinstance(doc, dict) and doc.get("resource") == resource and doc.get("authorization_servers") == [issuer]
        got = f"resource={doc.get('resource')} servers={doc.get('authorization_servers')}" if isinstance(doc, dict) else (a.error or f"HTTP {a.status}")
        self.add(host, f"{path} names {resource} and issuer {issuer}", ok, got)

    def expect_issuer(self, host: str, issuer: str) -> None:
        a = self.get(host, "/.well-known/oauth-authorization-server")
        doc = a.json() if a.status == 200 else None
        ok = isinstance(doc, dict) and doc.get("issuer") == issuer and doc.get("authorization_endpoint") == f"{issuer}/oauth/mcp/authorize" \
            and doc.get("token_endpoint") == f"{issuer}/oauth/mcp/token" and doc.get("registration_endpoint") == f"{issuer}/oauth/mcp/register" \
            and doc.get("code_challenge_methods_supported") == ["S256"] and doc.get("authorization_response_iss_parameter_supported") is True
        got = f"issuer={doc.get('issuer')} authorize={doc.get('authorization_endpoint')}" if isinstance(doc, dict) else (a.error or f"HTTP {a.status}")
        self.add(host, f"authorization server metadata: issuer {issuer}", ok, got)

    def expect_challenge(self, host: str, metadata: str) -> None:
        body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                           "clientInfo": {"name": "pulse-domain-check", "version": "1"}}}).encode()
        a = self.get(host, "/mcp", method="POST", body=body, headers={"content-type": "application/json", "accept": "application/json, text/event-stream"})
        challenge = a.header("www-authenticate")
        ok = a.status == 401 and f'resource_metadata="{metadata}"' in challenge
        self.add(host, "unsigned POST /mcp gets the challenge", ok, a.error or f"HTTP {a.status} {challenge or 'no WWW-Authenticate'}")

    def family(self, f: Family) -> None:
        app = self.o(f.app)
        issuer = self.o(f.id or f.app)
        mcp = self.o(f.mcp or f.app)
        self.expect_login(f.app)
        self.expect_brand_api(f.app)
        self.expect_issuer(f.app, issuer)
        self.expect_resource(f.app, "/.well-known/oauth-protected-resource", f"{app}/mcp", issuer)
        if f.api:
            self.expect_brand_api(f.api)
            self.expect_resource(f.api, "/.well-known/oauth-protected-resource", f"{mcp}/mcp", issuer)
            self.expect_redirect(f.api, "/", f"{app}/")
            self.expect_redirect(f.api, "/dashboard?from=check", f"{app}/dashboard?from=check")
            self.expect_status(f.api, "/login", 404, "is refused (not a sign-in host)", method="POST")
        if f.mcp:
            self.expect_resource(f.mcp, "/.well-known/oauth-protected-resource/mcp", f"{mcp}/mcp", issuer)
            self.expect_resource(f.mcp, "/.well-known/oauth-protected-resource", f"{mcp}/mcp", issuer)
            self.expect_challenge(f.mcp, f"{mcp}/.well-known/oauth-protected-resource/mcp")
            self.expect_redirect(f.mcp, "/", f"{app}/")
            self.expect_redirect(f.mcp, "/login", f"{app}/login")
        if f.id:
            self.expect_issuer(f.id, issuer)
            self.expect_login(f.id)
            self.expect_status(f.id, "/oauth/mcp/register", 405, "is the registration endpoint (POST only)")
            self.expect_redirect(f.id, "/", f"{app}/")
            self.expect_redirect(f.id, "/dashboard", f"{app}/dashboard")

    def alias(self, host: str) -> None:
        own = self.o(host)
        self.expect_login(host)
        self.expect_brand_api(host)
        self.expect_issuer(host, own)
        self.expect_resource(host, "/.well-known/oauth-protected-resource/mcp", f"{own}/mcp", own)
        self.expect_challenge(host, f"{own}/.well-known/oauth-protected-resource/mcp")


def families_from(args) -> list[Family]:
    if args.families:
        raw = json.loads(args.families)
        out = []
        for i, f in enumerate(raw if isinstance(raw, list) else []):
            if isinstance(f, dict) and isinstance(f.get("app"), str):
                out.append(Family(f.get("name") or f"family-{i + 1}", **{r: f[r].lower() for r in ROLES if isinstance(f.get(r), str)}))
        return out
    d = args.domain.lower().strip(".")
    if not HOST.match(d):
        raise SystemExit(f"--domain {args.domain!r} is not a domain")
    return [Family("vitals", f"app.{d}", f"api.{d}", f"mcp.{d}", f"id.{d}")]


def run(args) -> list[Result]:
    checker = Checker(args.edge)
    for f in families_from(args):
        if not args.only or any(h in args.only for _, h in f.hosts()):
            checker.family(f)
    for host in args.alias:
        if not args.only or host in args.only:
            checker.alias(host.lower())
    if args.only:
        checker.results = [r for r in checker.results if r.host in args.only]
    return checker.results


def report(results: list[Result], quiet: bool) -> bool:
    ok = all(r.ok for r in results)
    for r in results:
        if not r.ok or not quiet:
            print(f"{'PASS' if r.ok else 'FAIL'}  {r.host:<34} {r.check}" + ("" if r.ok else f"  ({r.detail})"))
    print(f"{'OK' if ok else 'FAILED'}: {sum(r.ok for r in results)}/{len(results)} checks passed")
    return ok


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0], formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--domain", default="vitalsos.ai", help="the family's domain: app., api., mcp. and id. under it (default vitalsos.ai)")
    p.add_argument("--families", help="PULSE_HOST_FAMILIES JSON instead of --domain (the server's own setting)")
    p.add_argument("--alias", action="append", default=None, help="a permanent alias that is its own issuer (repeatable; default pulse.estateautopilots.com)")
    p.add_argument("--no-alias", action="store_true", help="check no alias")
    p.add_argument("--edge", help="send Host headers to this local Pulse (e.g. http://127.0.0.1:4002) instead of DNS")
    p.add_argument("--only", action="append", help="check these hosts only (repeatable)")
    p.add_argument("--watch", type=int, metavar="SECONDS", help="repeat every SECONDS; print ALERT / RECOVERED when the state changes")
    p.add_argument("--quiet", action="store_true", help="print failures and the summary only")
    args = p.parse_args(argv)
    args.alias = [] if args.no_alias else (args.alias or ["pulse.estateautopilots.com"])
    if not args.watch:
        return 0 if report(run(args), args.quiet) else 1
    failing: set[tuple[str, str]] = set()
    while True:
        results = run(args)
        now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        bad = {(r.host, r.check) for r in results if not r.ok}
        for r in results:
            key = (r.host, r.check)
            if not r.ok and key not in failing:
                print(f"{now} ALERT {r.host} {r.check} ({r.detail})", flush=True)
            elif r.ok and key in failing:
                print(f"{now} RECOVERED {r.host} {r.check}", flush=True)
        failing = bad
        if not bad:
            print(f"{now} ok {len(results)} checks", flush=True)
        time.sleep(args.watch)


if __name__ == "__main__":
    sys.exit(main())
