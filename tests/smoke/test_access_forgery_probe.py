from __future__ import annotations

import base64
import json
import subprocess
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "tools" / "qa" / "access-forgery-probe.py"
EMAIL = "qa-forged@example.invalid"


class StubHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.server.seen.append((self.path, self.headers))  # case-insensitive: urllib capitalises header names
        status, location = self.server.answers[self.path.split("?")[0]]
        self.send_response(status)
        if location:
            self.send_header("Location", location)
        self.end_headers()
        self.wfile.write(b'{"role":"admin"}' if status == 200 else b"{}")

    def log_message(self, *_args):
        pass


def claims(assertion):
    part = assertion.split(".")[1]
    return json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))


class AccessForgeryProbeTests(unittest.TestCase):
    def run_probe(self, answers):
        server = ThreadingHTTPServer(("127.0.0.1", 0), StubHandler)
        server.answers, server.seen = answers, []
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            result = subprocess.run([sys.executable, str(SCRIPT), "staging", "--port", str(server.server_port)],
                                    cwd=ROOT, capture_output=True, text=True, timeout=30, check=False)
        finally:
            server.shutdown()
            thread.join(timeout=2)
            server.server_close()
        return result, server.seen

    def test_denied_probes_exit_zero_and_print_codes_only(self):
        result, seen = self.run_probe({"/api/v0/me": (401, None), "/people": (307, "/login?next=%2Fpeople")})
        self.assertEqual(result.returncode, 0, result.stderr)
        receipt = json.loads(result.stdout)
        self.assertEqual([r["probe"] for r in receipt], ["a-email-only api", "a-email-only page", "b-malformed-jwt api",
                                                         "b-malformed-jwt page", "c-forged-jwt api", "c-forged-jwt page"])
        self.assertEqual([r["status"] for r in receipt], [401, 307] * 3)
        self.assertTrue(all(set(r) == {"probe", "status"} for r in receipt))
        self.assertNotIn(EMAIL, result.stdout)
        self.assertTrue(all(h.get("Cf-Access-Authenticated-User-Email") == EMAIL for _, h in seen))
        self.assertEqual(seen[0][1].get("Host"), "pulse-staging.estateautopilots.com")
        assertion = seen[4][1].get("Cf-Access-Jwt-Assertion")
        self.assertEqual(len(assertion.split(".")), 3)
        self.assertEqual(claims(assertion)["email"], EMAIL)
        self.assertNotIn(assertion, result.stdout)

    def test_a_2xx_exits_one(self):
        result, _ = self.run_probe({"/api/v0/me": (200, None), "/people": (200, None)})
        self.assertEqual(result.returncode, 1)
        self.assertEqual({r["status"] for r in json.loads(result.stdout)}, {200})
        self.assertIn("not denied: a-email-only api", result.stderr)

    def test_page_redirect_away_from_sign_in_exits_one(self):
        result, _ = self.run_probe({"/api/v0/me": (401, None), "/people": (307, "/dashboard")})
        self.assertEqual(result.returncode, 1)
        self.assertIn("a-email-only page", result.stderr)
        self.assertNotIn("api", result.stderr.split("not denied:")[1])


if __name__ == "__main__":
    unittest.main()
