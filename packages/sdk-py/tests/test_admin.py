"""pulse-admin against a fake operator API: bearer token, request bodies, one-time password output, error mapping."""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from pulse_sdk import admin

TOKEN = "synthetic-operator-token-0123456789abcdef"
INIT = ["init", "--name", "Northwind Studio", "--slug", "northwind", "--code", "NWS", "--time-zone", "Europe/London",
        "--admin-email", "Admin@Northwind.example", "--admin-name", "Admin"]


@pytest.fixture
def api():
    state = {"requests": [], "installed": False}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def answer(self, status, body):
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def handle_any(self):
            length = int(self.headers.get("content-length") or 0)
            body = json.loads(self.rfile.read(length)) if length else None
            state["requests"].append({"method": self.command, "path": self.path, "body": body,
                                      "authorization": self.headers.get("authorization")})
            if self.headers.get("authorization") != f"Bearer {TOKEN}":
                return self.answer(401, {"error": "Operator token required"})
            if self.path == "/api/v1/operator/init":
                if state["installed"]:
                    return self.answer(409, {"error": "Pulse is already initialised"})
                state["installed"] = True
                return self.answer(201, {"orgId": "org-1", "personId": "person-1", "username": "admin.admin",
                                         "temporaryPassword": "synthetic-temp-pass"})
            if self.path == "/api/v1/operator/status":
                org = {"name": "Northwind Studio", "slug": "northwind", "code": "NWS", "time_zone": "Europe/London"}
                return self.answer(200, {"initialised": state["installed"], "org": org if state["installed"] else None,
                                         "version": "dev"})
            if self.path == "/api/v1/operator/org":
                return self.answer(200, {"ok": True})
            if self.path == "/api/v1/operator/roles" and self.command == "GET":
                return self.answer(200, {"roles": [
                    {"role": "admin", "email": "admin@northwind.example", "name": "Admin", "active": True,
                     "since": "2026-10-10"},
                    {"role": "hr", "email": None, "name": "Former HR", "active": False, "since": "2026-10-01"}]})
            if self.path == "/api/v1/operator/roles":
                if body["role"] == "admin" and body["action"] == "revoke":
                    return self.answer(409, {"error": "This is the last admin; grant admin to someone else first"})
                return self.answer(200, {"ok": True, "personId": "person-2", "name": "Second Account"})
            return self.answer(404, {"error": "Not found"})

        do_GET = do_POST = handle_any

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    state["url"] = f"http://127.0.0.1:{server.server_address[1]}"
    yield state
    server.shutdown()
    server.server_close()


def test_init_sends_the_token_and_prints_the_temporary_password_once(api, monkeypatch, capsys):
    monkeypatch.setenv("PULSE_OPERATOR_TOKEN", TOKEN)
    assert admin.main(["--url", api["url"], *INIT]) == 0
    out, err = capsys.readouterr()
    assert out.count("synthetic-temp-pass") == 1 and "Username:    admin.admin" in out
    assert TOKEN not in out + err
    request = api["requests"][0]
    assert request["method"] == "POST" and request["authorization"] == f"Bearer {TOKEN}"
    assert request["body"] == {"name": "Northwind Studio", "slug": "northwind", "code": "NWS",
                               "timeZone": "Europe/London", "adminEmail": "Admin@Northwind.example",
                               "adminName": "Admin"}

    assert admin.main([*INIT, "--url", api["url"]]) == 1          # --url after the command works too
    out, err = capsys.readouterr()
    assert "409: Pulse is already initialised" in err and "synthetic-temp-pass" not in out + err


def test_status_and_org_set(api, monkeypatch, capsys):
    monkeypatch.setenv("PULSE_OPERATOR_TOKEN", TOKEN)
    assert admin.main(["--url", api["url"], "status"]) == 0
    assert "Not initialised" in capsys.readouterr().out
    api["installed"] = True
    assert admin.main(["--url", api["url"], "status", "--json"]) == 0
    assert json.loads(capsys.readouterr().out)["org"]["code"] == "NWS"
    assert admin.main(["org", "set", "--name", "Northwind Studio Ltd", "--url", api["url"]]) == 0
    assert api["requests"][-1]["body"] == {"name": "Northwind Studio Ltd"}


def test_grant_revoke_and_roles(api, monkeypatch, capsys):
    monkeypatch.setenv("PULSE_OPERATOR_TOKEN", TOKEN)
    assert admin.main(["--url", api["url"], "grant", "--email", "Second@Northwind.example", "--role", "hr"]) == 0
    assert capsys.readouterr().out == "Granted hr to Second Account <second@northwind.example>.\n"
    assert api["requests"][-1]["body"] == {"email": "Second@Northwind.example", "role": "hr", "action": "grant"}
    assert admin.main(["revoke", "--email", "second@northwind.example", "--role", "hr", "--url", api["url"]]) == 0
    assert capsys.readouterr().out.startswith("Revoked hr from Second Account")
    assert api["requests"][-1]["body"]["action"] == "revoke"

    assert admin.main(["--url", api["url"], "revoke", "--email", "admin@northwind.example", "--role", "admin"]) == 1
    assert "409: This is the last admin" in capsys.readouterr().err

    assert admin.main(["--url", api["url"], "roles"]) == 0
    out = capsys.readouterr().out.splitlines()
    assert out[0].split() == ["admin", "Admin", "<admin@northwind.example>", "since", "2026-10-10"]
    assert out[1].endswith("<-> since 2026-10-01 (not active)")
    assert admin.main(["--url", api["url"], "roles", "--json"]) == 0
    assert json.loads(capsys.readouterr().out)[0]["role"] == "admin"

    sent = len(api["requests"])
    with pytest.raises(SystemExit) as usage:
        admin.main(["--url", api["url"], "grant", "--email", "x@northwind.example", "--role", "manager"])
    assert usage.value.code == 2 and len(api["requests"]) == sent


def test_token_errors(api, monkeypatch, capsys):
    monkeypatch.delenv("PULSE_OPERATOR_TOKEN", raising=False)
    assert admin.main(["--url", api["url"], "status"]) == 2
    assert "PULSE_OPERATOR_TOKEN is not set" in capsys.readouterr().err
    assert api["requests"] == []
    monkeypatch.setenv("PULSE_OPERATOR_TOKEN", "wrong-token")
    assert admin.main(["--url", api["url"], "status"]) == 1
    err = capsys.readouterr().err
    assert "401" in err and "wrong-token" not in err


def test_unreachable_api_and_default_url(monkeypatch, capsys):
    monkeypatch.setenv("PULSE_OPERATOR_TOKEN", TOKEN)
    assert admin.parser().parse_args(["status"]).url == "http://127.0.0.1:8081"
    assert admin.main(["--url", "http://127.0.0.1:9", "status"]) == 1
    assert "cannot reach the Pulse API" in capsys.readouterr().err
