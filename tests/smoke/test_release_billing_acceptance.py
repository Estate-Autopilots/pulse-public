"""EST-1964: the issued-quotation pass runs only on request, never fails the train for a product step, and leaves only
what an issued document must keep: drafts and the party go, open documents are cancelled, the issuer cannot sign in."""
import contextlib
import importlib.util
import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'tools'))
SPEC = importlib.util.spec_from_file_location('release_billing_acceptance', ROOT / 'tools/release_billing_acceptance.py')
acceptance = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(acceptance)
CTX = {'org': 'org-id', 'prefix': 'release.abcd1234', 'password': 'synthetic-password', 'personSession': 'person-session',
       'origin': 'https://pulse-staging.example', 'port': 4102, 'out': '/nowhere', 'source': '/nowhere', 'environment': 'staging'}
PACKAGE = {'id': 'package-id', 'kind': 'package', 'status': 'active', 'name': 'Private package', 'description': 'Private scope',
           'sac': '998361', 'unit': 'package', 'price': 1180000, 'gstRate': 18}
CHAIN = [{'id': 'quote-id', 'doc_type': 'quotation', 'status': 'converted', 'source': None},
         {'id': 'proforma-id', 'doc_type': 'proforma', 'status': 'issued', 'source': 'quote-id'},
         {'id': 'invoice-id', 'doc_type': 'invoice', 'status': 'draft', 'source': 'proforma-id'}]


class FakeConn:
    def __init__(self, documents=True, fail=None):
        self.sql, self.documents, self.fail, self.cancelled = [], documents, fail, False

    def transaction(self):
        return contextlib.nullcontext()

    def execute(self, query, params=()):
        self.sql.append((query, params))
        if self.fail and query.lstrip().startswith(self.fail):
            raise RuntimeError('Injected SQL failure')
        result = Mock()
        result.rowcount = 1
        if 'source_id::text source' in query:
            result.fetchall.return_value = CHAIN
        elif 'status=any(' in query:
            result.fetchall.return_value = [{'id': 'proforma-id', 'doc_type': 'proforma'}] if self.documents and not self.cancelled else []
        elif ') kept' in query:
            result.fetchone.return_value = {'kept': self.documents}
        elif query.startswith('select status from pulse.person'):
            result.fetchone.return_value = {'status': 'inactive'}
        return result


class BillingAcceptanceTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.request = Path(self.dir.name) / 'billing-acceptance.request'
        self.calls, self.checks, self.removed = [], [], []
        self.revoked = False

    def tearDown(self):
        self.dir.cleanup()

    def run_pass(self, requested=True, lost=None, browser_passed=True, revocation_holds=True, mark=200, fail_sql=None):
        if requested:
            self.request.write_text('')
        self.conn = FakeConn(documents=lost is None or lost.endswith('/mark'), fail=fail_sql)
        issued = {'done': False}

        def call(path, role=None, body=None, headers=None):
            self.calls.append((path, role, body, headers))
            if lost == path:
                raise TimeoutError('Lost response')
            if path.endswith('/mark'):
                self.conn.cancelled = self.conn.cancelled or mark == 200
                return mark, None, {}, b''
            if path == '/api/v0/auth/sign-in':
                if self.revoked and revocation_holds:
                    return 401, None, {}, b''
                return 200, {}, {'Set-Cookie': 'pulse_session=issuer-session; Path=/; HttpOnly'}, b''
            if path == '/api/v0/me':
                return 401, None, {}, b''
            if path == '/api/v0/erp/items':
                return 200, {'items': [PACKAGE]}, {}, b''
            if path == '/api/v0/erp/settings':
                return 200, {'company': {'legalName': 'Synthetic Co', 'stateCode': '27'}}, {}, b''
            if path == '/api/v0/erp/documents':
                return 200, {'id': 'quote-id'}, {}, b''
            if path == '/api/v0/erp/documents/quote-id' and body is None:
                if not issued['done']:
                    return 200, {'document': {'status': 'draft', 'issueDate': '2026-10-19', 'validUntil': '2026-11-18'}}, {}, b''
                return 200, {'document': {'status': 'issued', 'number': 'QT/26-27/0001', 'buyer': {'name': acceptance.PARTY}},
                             'lines': [{'itemId': 'package-id', 'qty': 1, 'gstRate': 18}]}, {}, b''
            if path.endswith('/issue'):
                issued['done'] = True
                return 200, {'number': 'QT/26-27/0001'}, {}, b''
            return 200, {'ok': True}, {}, b''

        def check(label, passed):
            self.checks.append((label, passed))
            if not passed:
                raise AssertionError(label)

        def browser(ctx, payload):
            self.payload = payload
            return {'passed': browser_passed, 'step': None if browser_passed else 'share 390-light', 'checks': [], 'screenshots': ['a.png']}

        original = self.conn.execute

        def execute(query, params=()):
            if query.startswith('delete from pulse.login_credential'):
                self.revoked = True
            return original(query, params)
        self.conn.execute = execute
        ctx = {**CTX, 'out': self.dir.name, 'cleanup': self.removed.append}
        return acceptance.billing_acceptance(self.conn, call, check, ctx, browser=browser, request=self.request)

    def deletes(self, table):
        return [(q, p) for q, p in self.conn.sql if q.lstrip().startswith('delete from ' + table + ' ')]

    def test_without_a_request_nothing_is_touched(self):
        receipt = self.run_pass(requested=False)
        self.assertEqual(receipt, {'requested': False})
        self.assertEqual(self.calls, [])
        self.assertEqual(self.conn.sql, [])

    def test_issues_a_real_package_quotation_and_tidies_up_without_secrets_in_the_receipt(self):
        receipt = self.run_pass()
        self.assertFalse(self.request.exists(), 'the request is consumed')
        self.assertTrue(receipt['passed'], receipt)
        self.assertEqual(receipt['quote']['number'], 'QT/26-27/0001')
        saved = next(body for path, _, body, _ in self.calls if path == '/api/v0/erp/documents/quote-id' and body)
        self.assertEqual(saved['lines'][0]['itemId'], 'package-id')
        self.assertNotIn('phone', saved['buyer'])
        self.assertNotIn('email', saved['buyer'])
        self.assertEqual(self.payload['issuer'], 'issuer-session')
        self.assertEqual(self.payload['person'], 'person-session')
        # Every API write went as the issuer, never as a release person whose cleanup() an issued document would block.
        for path, role, body, headers in self.calls:
            if body is not None and path != '/api/v0/auth/sign-in':
                self.assertIsNone(role, path)
                self.assertEqual(headers, {'Cookie': 'pulse_session=issuer-session'})
        cancel = [body for path, _, body, _ in self.calls if path == '/api/v0/erp/documents/proforma-id/mark']
        self.assertEqual(cancel, [{'action': 'cancel', 'note': acceptance.NOTE}])
        self.assertIn('Release validation', acceptance.NOTE)
        for query, params in self.deletes('pulse.erp_document'):
            self.assertIn("status='draft'", query)
            self.assertIn('client_id=%s', query)
            self.assertIn('created_by=%s', query)
        self.assertEqual(self.deletes('pulse.client'), [], 'an issued document keeps its client until the nightly refresh')
        for table in ('pulse.login_session', 'pulse.login_credential', 'pulse.role_assignment'):
            self.assertEqual(len(self.deletes(table)), 1, table)
        self.assertEqual(self.removed, [], 'an issuer an issued document refers to stays until the refresh')
        self.assertEqual(receipt['cleanup'], {'passed': True, 'cancelled': ['proforma'], 'stillOpen': 0, 'draftsDeleted': 1, 'partyDeleted': True,
                                              'clientKept': True, 'issuerKept': True, 'issuerInactive': True, 'errors': []})
        update = [(q, p) for q, p in self.conn.sql if q.startswith('update pulse.person')]
        self.assertEqual(update, [("update pulse.person set status='inactive' where org_id=%s and id=%s", ('org-id', update[0][1][1]))])
        moving = [i for i, (q, _) in enumerate(self.conn.sql) if 'pulse.lifecycle_moving' in q]
        self.assertTrue(moving and moving[0] < self.conn.sql.index(update[0]), 'kept out of the HR lifecycle history')
        self.assertEqual([label for label, _ in self.checks], ['Billing acceptance issuer can no longer sign in', 'Billing acceptance issuer session revoked',
                                                               'Billing acceptance issuer credential, sessions and role removed'])
        text = json.dumps(receipt)
        for secret in ('Private', 'package-id', 'quote-id', 'proforma-id', 'issuer-session', 'synthetic-password', '1180000'):
            self.assertNotIn(secret, text)

    def test_a_product_failure_is_recorded_and_still_tidied(self):
        receipt = self.run_pass(browser_passed=False)
        self.assertFalse(receipt['passed'])
        self.assertEqual(receipt['failed'], 'browser: share 390-light')
        self.assertTrue(receipt['cleanup']['passed'])
        self.assertEqual(len(self.deletes('pulse.login_credential')), 1)

    def test_a_lost_reply_before_issuing_removes_everything(self):
        receipt = self.run_pass(lost='/api/v0/erp/documents/quote-id/issue')
        self.assertFalse(receipt['passed'])
        self.assertEqual(receipt['failed'], 'after quotation saved from a real package: TimeoutError')
        self.assertEqual(len(self.deletes('pulse.client')), 1)
        self.assertEqual(len(self.removed), 1, 'nothing issued refers to the issuer: removed like the release people')
        self.assertFalse(receipt['cleanup']['clientKept'])
        self.assertFalse(receipt['cleanup']['issuerKept'])

    def saved(self):
        path = Path(self.dir.name) / 'staging-billing-acceptance.json'
        self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)
        return json.loads(path.read_text())

    def assertRevoked(self):
        for table in ('pulse.login_session', 'pulse.login_credential', 'pulse.role_assignment'):
            self.assertEqual(len(self.deletes(table)), 1, table)
        self.assertIn(('Billing acceptance issuer can no longer sign in', True), self.checks)

    def test_the_combined_receipt_is_private_and_matches_the_return(self):
        receipt = self.run_pass()
        self.assertEqual(self.saved(), json.loads(json.dumps(receipt)))
        failed = self.run_pass(browser_passed=False)
        self.assertEqual(self.saved()['failed'], failed['failed'])

    def test_a_failed_cancel_fails_the_receipt_and_still_revokes(self):
        receipt = self.run_pass(mark=500)
        self.assertFalse(receipt['passed'])
        self.assertFalse(receipt['cleanup']['passed'])
        self.assertEqual(receipt['cleanup']['errors'], ['cancel proforma: HTTP 500', '1 synthetic documents still open'])
        self.assertEqual(receipt['failed'], 'cleanup: cancel proforma: HTTP 500; 1 synthetic documents still open')
        self.assertRevoked()
        self.assertFalse(self.saved()['passed'])

    def test_a_lost_cancel_reply_still_tidies_and_revokes(self):
        receipt = self.run_pass(lost='/api/v0/erp/documents/proforma-id/mark')
        self.assertFalse(receipt['passed'])
        self.assertIn('cancel proforma: TimeoutError', receipt['cleanup']['errors'])
        self.assertEqual(len(self.deletes('pulse.erp_document')), 1, 'drafts still go')
        self.assertRevoked()

    def test_a_cleanup_sql_failure_still_revokes(self):
        receipt = self.run_pass(fail_sql='delete from pulse.erp_party')
        self.assertFalse(receipt['passed'])
        self.assertEqual(receipt['cleanup']['errors'], ['documents: RuntimeError'])
        self.assertRevoked()
        self.assertFalse(self.saved()['cleanup']['passed'])

    def test_a_revocation_sql_failure_fails_the_smoke_and_keeps_a_receipt(self):
        with self.assertRaisesRegex(AssertionError, 'can no longer sign in'):
            self.run_pass(fail_sql='delete from pulse.login_session')
        self.assertIn('revocation: RuntimeError', self.saved()['cleanup']['errors'])

    def test_an_issuer_that_can_still_sign_in_fails_the_smoke(self):
        with self.assertRaisesRegex(AssertionError, 'can no longer sign in'):
            self.run_pass(revocation_holds=False)


if __name__ == '__main__':
    unittest.main()
