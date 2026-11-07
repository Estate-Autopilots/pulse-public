from __future__ import annotations

import os
import subprocess
import sys
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "tools" / "smoke"


class StubHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.server.seen.append((self.path, self.headers.get("CF-Access-Client-Id"), self.headers.get("CF-Access-Client-Secret")))
        target = self.server.redirects.get(self.path)
        if target:
            self.send_response(302)
            self.send_header("Location", target)
            self.end_headers()
            return
        delay = self.server.delays.get(self.path, 0)
        if delay:
            time.sleep(delay)
        status = self.server.statuses.get(self.path, 200)
        self.send_response(status)
        self.end_headers()
        self.wfile.write(b"ok")

    def log_message(self, *_args):
        pass


class SmokeTests(unittest.TestCase):
    def run_smoke(self, *, statuses=None, delays=None, redirects=None, env=None):
        server = ThreadingHTTPServer(("127.0.0.1", 0), StubHandler)
        server.statuses = statuses or {}
        server.delays = delays or {}
        server.redirects = redirects or {}
        server.seen = []
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base_url = f"http://127.0.0.1:{server.server_port}"
        process_env = os.environ.copy()
        process_env.pop("PULSE_SMOKE_CF_ACCESS_CLIENT_ID", None)
        process_env.pop("PULSE_SMOKE_CF_ACCESS_CLIENT_SECRET", None)
        process_env.pop("PULSE_SMOKE_MAX_SECONDS", None)
        if env:
            process_env.update(env)
        try:
            result = subprocess.run(
                [sys.executable, str(SCRIPT), base_url],
                cwd=ROOT,
                env=process_env,
                capture_output=True,
                text=True,
                timeout=5,
                check=False,
            )
        finally:
            server.shutdown()
            thread.join(timeout=2)
            server.server_close()
        return result, server.seen

    def test_api_only_passes(self):
        result, seen = self.run_smoke(statuses={"/healthz": 200, "/": 404})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("API only", result.stdout)
        self.assertEqual([path for path, *_ in seen], ["/healthz", "/"])

    def test_api_only_without_health_fails(self):
        result, _ = self.run_smoke(statuses={"/healthz": 404, "/": 404})
        self.assertEqual(result.returncode, 1)
        self.assertIn("API-only mode requires HTTP 200", result.stderr)

    def test_web_only_passes_without_health_endpoint(self):
        result, seen = self.run_smoke(statuses={"/healthz": 404})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Pulse web smoke", result.stdout)
        self.assertEqual({path for path, *_ in seen}, {"/healthz", "/", "/my-week", "/pod", "/leadership"})

    def test_staging_checks_all_shell_routes_and_fails_broken_route(self):
        result, _ = self.run_smoke(statuses={"/healthz": 200, "/pod": 500})
        self.assertEqual(result.returncode, 1)
        self.assertIn("FAIL /pod: HTTP 500", result.stdout)

    def test_route_over_budget_fails(self):
        result, _ = self.run_smoke(delays={"/my-week": 0.05}, env={"PULSE_SMOKE_MAX_SECONDS": "0.01"})
        self.assertEqual(result.returncode, 1)
        self.assertIn("FAIL /my-week", result.stdout)

    def test_off_origin_redirect_fails_and_names_host(self):
        result, _ = self.run_smoke(redirects={"/": "https://login.example.test/sign-in"})
        self.assertEqual(result.returncode, 1)
        self.assertIn("login.example.test", result.stdout + result.stderr)

    def test_cloudflare_access_headers_are_sent(self):
        result, seen = self.run_smoke(
            statuses={"/healthz": 200, "/": 404},
            env={"PULSE_SMOKE_CF_ACCESS_CLIENT_ID": "synthetic-id", "PULSE_SMOKE_CF_ACCESS_CLIENT_SECRET": "synthetic-secret"},
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(seen)
        self.assertTrue(all(client_id == "synthetic-id" and secret == "synthetic-secret" for _, client_id, secret in seen))
        self.assertNotIn("synthetic-secret", result.stdout + result.stderr)

    def test_bad_budget_exits_two_without_traceback(self):
        result, _ = self.run_smoke(env={"PULSE_SMOKE_MAX_SECONDS": "invalid"})
        self.assertEqual(result.returncode, 2)
        self.assertIn("PULSE_SMOKE_MAX_SECONDS", result.stderr)
        self.assertNotIn("Traceback", result.stderr)


if __name__ == "__main__":
    unittest.main()
