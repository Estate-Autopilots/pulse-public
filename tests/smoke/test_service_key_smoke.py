"""Service refusal probes must reject open routes and unfollowed edge redirects."""
import importlib.util
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch
from urllib.parse import urlsplit

spec = importlib.util.spec_from_file_location('service_key_smoke', Path(__file__).resolve().parents[2] / 'tools/service_key_smoke.py')
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.server.seen.append((self.path, dict(self.headers)))
        self.send_response(self.server.status if self.server.status is not None else 403 if self.path == '/api/v0/me' else 401)
        self.send_header('Location', '/must-not-follow')
        self.end_headers()

    def log_message(self, *_args):
        pass


class ServiceKeySmokeTests(unittest.TestCase):
    def release_checks(self, credentials, failed_loopback=False, envname='staging', public_status=None):
        source = (Path(__file__).resolve().parents[2] / 'tools/release-smoke.py').read_text()
        start = source.index('for target, base, host, access in [')
        block = source[start:source.index("# Owner's public-auth release policy", start)]
        report, calls = {'checks': []}, []

        def probes(base, host, access):
            calls.append((base, host, access))
            return [{'check': label, 'status': public_status if not host and public_status is not None else status, 'expected': status,
                     'passed': not (failed_loopback and host) and (host is not None or public_status in (None, status))}
                    for label, status in [('no key', 401), ('malformed key', 401), ('staff boundary', 403)]]

        def check(label, passed):
            self.assertTrue(passed, label)
            report['checks'].append({'check': label, 'passed': passed})

        with patch.dict(smoke.os.environ, credentials, clear=True):
            exec(block, {'public': 'https://synthetic.example', 'port': 4002 if envname == 'production' else 4102,
                         'report': report, 'envname': envname,
                         'access_headers': smoke.access_headers, 'service_key_probes': probes,
                         'urlsplit': urlsplit, 'check': check})
        return report, calls

    def test_release_skips_only_public_without_both_access_values(self):
        for credentials in [{}, {'PULSE_SMOKE_CF_ACCESS_CLIENT_ID': 'synthetic-id'},
                            {'PULSE_SMOKE_CF_ACCESS_CLIENT_SECRET': 'synthetic-secret'}]:
            with self.subTest(configured=list(credentials)):
                report, calls = self.release_checks(credentials)
                self.assertEqual(calls, [('http://127.0.0.1:4102', 'synthetic.example', {})])
                self.assertEqual(report['checks'][0], {'check': 'service key public', 'skipped': True,
                                                       'reason': 'Staging Access credentials unavailable; contract adjusted in EST-1901'})
                self.assertEqual(len(report['checks']), 4)
                self.assertTrue(all(c['passed'] for c in report['checks'][1:]))

    def test_release_runs_public_with_both_values_without_exposing_them(self):
        report, calls = self.release_checks({'PULSE_SMOKE_CF_ACCESS_CLIENT_ID': 'synthetic-id',
                                             'PULSE_SMOKE_CF_ACCESS_CLIENT_SECRET': 'synthetic-secret'})
        self.assertEqual(calls, [('https://synthetic.example', None,
                                 {'CF-Access-Client-Id': 'synthetic-id', 'CF-Access-Client-Secret': 'synthetic-secret'}),
                                ('http://127.0.0.1:4102', 'synthetic.example', {})])
        self.assertEqual(len(report['checks']), 6)
        self.assertTrue(all(c['passed'] for c in report['checks']))
        self.assertNotIn('synthetic-secret', json.dumps(report))

    def test_release_loopback_remains_mandatory_when_public_skips(self):
        with self.assertRaisesRegex(AssertionError, 'service key loopback'):
            self.release_checks({}, failed_loopback=True)

    def test_production_public_is_mandatory_without_access_credentials(self):
        for credentials in [{}, {'PULSE_SMOKE_CF_ACCESS_CLIENT_ID': 'synthetic-id'},
                            {'PULSE_SMOKE_CF_ACCESS_CLIENT_ID': 'synthetic-id',
                             'PULSE_SMOKE_CF_ACCESS_CLIENT_SECRET': 'synthetic-secret'}]:
            with self.subTest(configured=list(credentials)):
                report, calls = self.release_checks(credentials, envname='production')
                self.assertEqual(calls, [('https://synthetic.example', None, {}),
                                        ('http://127.0.0.1:4002', 'synthetic.example', {})])
                self.assertEqual(len(report['checks']), 6)
                self.assertTrue(all(c['passed'] for c in report['checks']))
                self.assertFalse(any(c.get('skipped') for c in report['checks']))
                self.assertNotIn('synthetic-secret', json.dumps(report))

    def test_production_public_redirect_or_open_route_fails(self):
        for status in [200, 302]:
            with self.subTest(status=status), self.assertRaisesRegex(AssertionError, 'service key public'):
                self.release_checks({}, envname='production', public_status=status)

    def probe(self, status=None):
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        server.seen, server.status = [], status
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            checks = smoke.service_key_probes(f'http://127.0.0.1:{server.server_port}', 'synthetic.example')
        finally:
            server.shutdown()
            thread.join()
            server.server_close()
        return checks, server.seen

    def test_exact_refusals_with_only_synthetic_headers(self):
        checks, seen = self.probe()
        self.assertTrue(all(c['passed'] for c in checks))
        self.assertEqual([c['status'] for c in checks], [401, 401, 403])
        self.assertEqual([h.get('Authorization') for _, h in seen], [None, 'Bearer psvc_smoke_invalid', 'Bearer psvc_smoke_invalid'])
        self.assertTrue(all(h['Host'] == 'synthetic.example' and 'Cookie' not in h for _, h in seen))

    def test_open_error_and_redirect_responses_fail(self):
        for status in [200, 302, 404, 429, 500]:
            with self.subTest(status=status):
                checks, seen = self.probe(status)
                self.assertTrue(all(not c['passed'] for c in checks))
                self.assertEqual(len(seen), 3, 'redirects never get followed')


if __name__ == '__main__':
    unittest.main()
