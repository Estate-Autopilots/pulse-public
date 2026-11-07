"""Exercise the actual release route loop without a database or live sessions."""
import ast
import importlib.util
import unittest
import uuid
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("release_smoke_paths", ROOT / "tools" / "release_smoke_paths.py")
paths = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(paths)
ROLES = ("person", "manager", "pgs", "hr", "leadership", "admin")
AGENT_ME = "/api/v0/agent/me"
ITEMS = "/api/v1/catalog/items"
OFFERS = "/api/v1/catalog/offers/:token"
INVALID_OFFER = "/api/v1/catalog/offers/release-smoke-invalid-token"
SERVICE_READS = ("/api/v1/service/clients", "/api/v1/service/leads",
                 "/api/v1/service/tasks/mine", "/api/v1/service/people",
                 "/api/v1/service/update-requests")
SERVICE_CHAT = "/api/v1/service/chats/:chatId/messages"


def route(url, denied=False, method="GET", module=None):
    return {"url": url, "method": method, "module": module, "denied": dict.fromkeys(ROLES, denied)}


class CatalogueReleaseSmokeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        source = ROOT / "tools" / "release-smoke.py"
        tree = ast.parse(source.read_text())
        loop, = [node for node in ast.walk(tree) if isinstance(node, ast.For)
                 and isinstance(node.target, ast.Name) and node.target.id == "route"
                 and isinstance(node.iter, ast.Name) and node.iter.id == "routes"]
        cls.loop = compile(ast.Module(body=[loop], type_ignores=[]), str(source), "exec")

    def run_matrix(self, routes, response):
        calls, checks = [], []

        def call(path, role=None, body=None):
            calls.append((path, role, body))
            return response(path, role), {}, {}, b""

        def check(label, condition):
            checks.append(label)
            self.assertTrue(condition, label)

        scope = {"routes": routes, "roles": ROLES, "modules_off": {"money"}, "uuid": uuid,
                 "real_person": "synthetic-person", "real_project": "synthetic-project",
                 "envname": "staging", "PUBLIC_ROUTES": set(), "call": call, "check": check,
                 "catalogue_credential_probe": paths.catalogue_credential_probe,
                 "sealed_elsewhere": paths.sealed_elsewhere}
        exec(self.loop, scope)
        return calls, checks

    def test_catalogue_refuses_anonymous_and_all_six_staff_roles(self):
        # Includes a disabled staff module: catalogue credentials are independent of staff modules.
        for denied, module in ((False, None), (True, None), (False, "money")):
            with self.subTest(generic_staff_denied=denied, module=module):
                calls, checks = self.run_matrix(
                    [route(ITEMS, denied=denied, method=["GET"], module=module), route(OFFERS, denied=denied)],
                    lambda path, role: 401 if path == ITEMS else 404)
                self.assertEqual(calls, [(path, role, None) for path in (ITEMS, INVALID_OFFER)
                                         for role in (None, *ROLES)])
                self.assertEqual(len(checks), 14)
                self.assertTrue(all("HTTP 404" in label for label in checks[7:]))
        token = INVALID_OFFER.rsplit("/", 1)[1]
        self.assertNotEqual(len(token), 43)  # guaranteed malformed, never a real public link

    def test_agent_me_refuses_anonymous_and_all_six_staff_roles(self):
        self.assertEqual(paths.catalogue_credential_probe("GET", AGENT_ME), (AGENT_ME, 401))
        calls, checks = self.run_matrix([route(AGENT_ME)], lambda path, role: 401)
        self.assertEqual(calls, [(AGENT_ME, role, None) for role in (None, *ROLES)])
        self.assertEqual(len(checks), 7)

    def test_credential_checks_reject_every_incorrect_status_for_each_identity(self):
        for url, expected in ((ITEMS, 401), (OFFERS, 404), (AGENT_ME, 401), *((url, 401) for url in SERVICE_READS)):
            for role in (None, *ROLES):
                for status in (200, 201, 204, 302, 400, 401, 403, 404, 429, 500, 503):
                    if status == expected:
                        continue
                    with self.subTest(url=url, role=role, status=status):
                        with self.assertRaisesRegex(AssertionError, "HTTP " + str(status)):
                            self.run_matrix([route(url)], lambda path, who: status if who == role else expected)

    def test_unrelated_routes_keep_anonymous_401_and_staff_rules(self):
        for url in ("/api/v0/me", "/api/v0/agents", "/api/v1/catalog/items/extra",
                    "/api/v1/catalog/offers/:token/extra", "/api/v1/service/tasks",
                    *(url + suffix for url in SERVICE_READS for suffix in ("/", "?anything", "/extra"))):
            with self.subTest(url=url):
                calls, checks = self.run_matrix([route(url)], lambda path, role: 401 if role is None else 200)
                self.assertEqual(len(calls), 7)
                self.assertEqual(len(checks), 7)
                for role in ROLES:
                    with self.subTest(role=role), self.assertRaisesRegex(AssertionError, "HTTP 401"):
                        self.run_matrix([route(url)], lambda path, who: 401 if who in (None, role) else 200)
                for anonymous_status in (200, 403, 404, 500):
                    with self.subTest(anonymous_status=anonymous_status), self.assertRaises(AssertionError):
                        self.run_matrix([route(url)], lambda path, role: anonymous_status if role is None else 200)
                self.run_matrix([route(url, denied=True)], lambda path, role: 401 if role is None else 403)
                with self.assertRaisesRegex(AssertionError, "HTTP 200"):
                    self.run_matrix([route(url, denied=True)], lambda path, role: 401 if role is None else 200)

    def test_service_reads_refuse_anonymous_and_all_six_staff_roles(self):
        # EST-1715/EST-2186: staff sessions never replace service credentials (or the tasks person token).
        for url in SERVICE_READS:
            for denied, module, method in ((False, None, "GET"), (True, None, ["GET"]), (False, "money", "GET")):
                with self.subTest(url=url, generic_staff_denied=denied, module=module, method=method):
                    self.assertEqual(paths.catalogue_credential_probe("GET", url), (url, 401))
                    calls, checks = self.run_matrix([route(url, denied=denied, module=module, method=method)],
                                                    lambda path, role: 401)
                    self.assertEqual(calls, [(url, role, None) for role in (None, *ROLES)])
                    self.assertEqual(len(checks), 7)

    def test_service_chat_post_keeps_the_anonymous_401(self):
        # EST-1715: the literal :chatId is probed as is; only 401 passes, the proxy's old 403 still fails.
        calls, checks = self.run_matrix([route(SERVICE_CHAT, method="POST")], lambda path, role: 401)
        self.assertEqual((calls, len(checks)), ([(SERVICE_CHAT, None, {})], 1))
        for status in (200, 201, 400, 403, 404, 500):
            with self.subTest(status=status), self.assertRaisesRegex(AssertionError, "HTTP " + str(status)):
                self.run_matrix([route(SERVICE_CHAT, method="POST")], lambda path, role: status)

    def test_exception_matches_only_the_exact_get_templates(self):
        for method in ("POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"):
            for url in (ITEMS, OFFERS, AGENT_ME, *SERVICE_READS):
                with self.subTest(method=method, url=url):
                    self.assertIsNone(paths.catalogue_credential_probe(method, url))
        for url in (ITEMS + "/", ITEMS + "?anything", INVALID_OFFER, "/api/v1/operator/catalog",
                    AGENT_ME + "/", AGENT_ME + "?anything", "/api/v0/agents", "/api/v0/agent/other",
                    "/api/v1/service/quotes", SERVICE_CHAT,
                    *(url + suffix for url in SERVICE_READS for suffix in ("/", "?anything", "/extra"))):
            self.assertIsNone(paths.catalogue_credential_probe("GET", url))
        for url in (ITEMS, OFFERS, AGENT_ME, *SERVICE_READS):
            calls, checks = self.run_matrix([route(url, method="POST")], lambda path, role: 401)
            self.assertEqual(len(checks), 1)
            self.assertEqual(calls, [(url, None, {})])
