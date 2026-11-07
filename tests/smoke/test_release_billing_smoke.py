"""Exports fail closed and remove only the synthetic fixtures, including on lost replies."""
import contextlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('release_billing_smoke', ROOT / 'tools/release_billing_smoke.py')
billing = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(billing)


class BillingExportSmokeTests(unittest.TestCase):
    def run_smoke(self, failure=None, payloads=None, packages=True, insert_failure=False, context=None):
        self.conn = Mock()
        self.conn.transaction.side_effect = lambda: contextlib.nullcontext()
        self.conn.execute.return_value.fetchone.return_value = {'remaining': False}
        if insert_failure:
            def execute(query, params):
                if query.startswith('insert into pulse.client'):
                    raise RuntimeError('Fixture insert failed')
                return self.conn.execute.return_value
            self.conn.execute.side_effect = execute
        self.calls, self.receipt = [], {}
        self.client = None
        item = {'id': 'package-id', 'kind': 'package', 'status': 'draft', 'name': 'Private package',
                'description': 'Private scope', 'price': 12000, 'gstRate': 18, 'unit': 'package'}

        def call(path, role, body=None):
            self.assertEqual(role, 'leadership')
            self.calls.append((path, body))
            if failure == path:
                raise TimeoutError('Lost response')
            if path == '/api/v0/erp/items':
                return 200, {'items': [item] if packages else []}, {}, b''
            if '/parties/' in path:
                self.client = path.rsplit('/', 1)[1]
            if path == '/api/v0/erp/documents':
                self.assertEqual(body, {'docType': 'quotation', 'clientId': self.client})
                return 200, {'id': 'draft-id'}, {}, b''
            if path.endswith('/draft-id') and body is None:
                return 200, {'document': {'status': 'draft', 'issueDate': '2026-10-19'}}, {}, b''
            if path.endswith(('/pdf', '/docx')):
                kind = path.rsplit('/', 1)[1]
                status, raw = (payloads or {}).get(kind, (200, b'%PDF-private' if kind == 'pdf' else b'PK-private'))
                return status, None, {}, raw
            return 200, {'ok': True}, {}, b''

        def check(label, passed):
            if not passed:
                raise AssertionError(label)

        billing.billing_exports(self.conn, call, check, 'org-id', 'synthetic-viewer', self.receipt, context=context)

    def assert_cleanup(self):
        sql = [(args[0], args[1]) for args, _ in self.conn.execute.call_args_list]
        for table in ('pulse.erp_event', 'pulse.erp_document', 'pulse.erp_party', 'pulse.client'):
            deletes = [(query, params) for query, params in sql if query.startswith('delete from ' + table + ' ')]
            self.assertTrue(deletes, table)
            for query, params in deletes:
                self.assertIn('org_id=%s', query)
                self.assertIn('org-id', params)
            if table != 'pulse.erp_event':
                self.assertTrue(any(self.client in params for _, params in deletes))
        doc_delete = next(q for q, _ in sql if q.startswith('delete from pulse.erp_document '))
        self.assertIn("status='draft'", doc_delete)
        self.assertIn('created_by=%s', doc_delete)
        self.assertTrue(self.receipt['cleanup']['passed'])

    def test_exports_the_real_package_without_issuing_and_records_only_sizes_and_verdicts(self):
        self.run_smoke()
        self.assert_cleanup()
        self.assertTrue(self.receipt['passed'])
        self.assertEqual(self.receipt['pdf'], {'bytes': 12, 'passed': True})
        self.assertEqual(self.receipt['docx'], {'bytes': 10, 'passed': True})
        saved = next(body for path, body in self.calls if path.endswith('/draft-id') and body)
        self.assertEqual(saved['lines'][0]['itemId'], 'package-id')
        self.assertEqual(saved['lines'][0]['rate'], 12000)
        self.assertTrue(self.calls[-1][0].endswith('/delete'))
        self.assertFalse(any('/issue' in path for path, _ in self.calls))
        for secret in ('Private', 'package-id', 'draft-id', self.client):
            self.assertNotIn(secret, json.dumps(self.receipt))

    def test_rejects_empty_bad_magic_and_failed_downloads_and_cleans_up(self):
        for kind in ('pdf', 'docx'):
            for payload in ((200, b''), (200, b'<html>error</html>'), (503, b'%PDF-error'), (200, b'%PDF' if kind == 'pdf' else b'PK')):
                with self.subTest(kind=kind, payload=payload):
                    with self.assertRaisesRegex(AssertionError, kind + ' export'):
                        self.run_smoke(payloads={kind: payload})
                    self.assert_cleanup()
                    self.assertFalse(self.receipt['passed'])

    def test_lost_creation_export_and_delete_replies_still_clean_up(self):
        for path in ('/api/v0/erp/documents', '/api/v0/erp/documents/draft-id/pdf',
                     '/api/v0/erp/documents/draft-id/docx', '/api/v0/erp/documents/draft-id/delete'):
            with self.subTest(path=path), self.assertRaises(TimeoutError):
                try:
                    self.run_smoke(failure=path)
                finally:
                    self.assert_cleanup()

    def test_empty_catalogue_fails_before_writing_anything(self):
        with self.assertRaisesRegex(AssertionError, 'real catalogue'):
            self.run_smoke(packages=False)
        self.conn.execute.assert_not_called()
        self.assertFalse(self.receipt['passed'])

    def test_failed_fixture_insert_never_deletes_a_preexisting_client(self):
        with self.assertRaisesRegex(RuntimeError, 'Fixture insert failed'):
            self.run_smoke(insert_failure=True)
        self.assertFalse(any(args[0].startswith('delete ') for args, _ in self.conn.execute.call_args_list))
        self.assertFalse(self.receipt['passed'])

    def test_quote_line_failure_still_cleans_the_export_pass_draft_and_party(self):
        with patch.object(billing, 'quote_lines', side_effect=TimeoutError('browser stopped')):
            with self.assertRaises(TimeoutError):
                self.run_smoke(context={'synthetic': True})
        self.assert_cleanup()
        self.assertFalse(self.receipt['passed'])


class QuoteLineSmokeTests(unittest.TestCase):
    def run_hook(self, broken=None, feature=True):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder)
            if feature:
                (source / 'db/migrations').mkdir(parents=True)
                (source / 'db/migrations/0545_quote_lines.sql').touch()
            ctx = {'source': str(source), 'environment': 'staging', 'port': 4102,
                   'origin': 'https://pulse-staging.estateautopilots.com', 'session': 'synthetic-secret'}
            self.conn = Mock()
            self.conn.transaction.side_effect = lambda: contextlib.nullcontext()
            self.conn.execute.return_value.rowcount = 1
            self.conn.execute.return_value.fetchone.return_value = {'ok': broken != 'migration', 'catalogue_rate': 100000}
            self.browser = Mock(return_value={'passed': True, 'screenshot': 'staging-quote-lines-synthetic.png'})
            self.posts, self.receipt = [], {}
            reads = 0

            def call(path, role=None, body=None):
                nonlocal reads
                if path == '/healthz':
                    return 200, {'release': 'stale' if broken == 'source' else 'a' * 40}, {}, b''
                if body is not None:
                    self.posts.append((path, body))
                    return (200 if broken == 'issue' else 400, {'error': 'Fill each open amount or mark it not needed'}, {}, b'') if path.endswith('/issue') else (200, {}, {}, b'')
                excluded = reads == 1
                flags = [False, False, False] if reads == 0 else [True, True, True] if excluded else [False, False, True]
                rows = [{'id': str(i), 'parentIndex': 0 if i == 1 else None, 'parentLineId': '0' if i == 1 else None,
                         'open': i == 2, 'notNeeded': flags[i]} for i in range(3)]
                if broken == 'parent':
                    rows[1]['parentLineId'] = 'wrong'
                reads += 1
                return 200, {'lines': rows, 'document': {'status': 'draft', 'taxable': 0 if excluded else 110000,
                    'total': 1 if excluded and broken == 'total' else 0 if excluded else 129800}}, {}, b''

            def check(label, ok):
                if not ok:
                    raise AssertionError(label)

            with patch.object(billing.subprocess, 'check_output', return_value='a' * 40):
                billing.quote_lines(self.conn, call, check, 'org-id', 'synthetic-viewer', 'synthetic-client',
                    '/api/v0/erp/documents/synthetic-draft', {'issueDate': '2026-10-20'}, {'id': 'private-catalogue-id'},
                    self.receipt, ctx, browser=self.browser)

    def test_receipt_is_source_bound_and_contains_only_verdicts_and_synthetic_screenshot(self):
        self.run_hook()
        self.assertTrue(self.receipt['passed'])
        self.assertTrue(self.receipt['catalogueRateRetained'])
        issue = next(body for path, body in self.posts if path.endswith('/issue'))
        self.assertNotIn('name', issue['draft']['buyer'])  # database fallback prevents accidental issuance
        self.assertTrue(all(line['itemId'] is None for line in self.posts[-1][1]['lines']))
        for private in ('synthetic-secret', 'private-catalogue-id', 'synthetic-client', 'synthetic-draft'):
            self.assertNotIn(private, json.dumps(self.receipt))

    def test_wrong_source_migration_parent_issue_or_total_never_reaches_screenshot(self):
        for broken in ('source', 'migration', 'parent', 'issue', 'total'):
            with self.subTest(broken=broken), self.assertRaises(AssertionError):
                try:
                    self.run_hook(broken=broken)
                finally:
                    self.browser.assert_not_called()
                    self.assertFalse(self.receipt['passed'])
                    if broken in ('source', 'migration'):
                        self.assertEqual(self.posts, [])

    def test_hook_before_feature_merge_is_unavailable_and_never_passes(self):
        self.run_hook(feature=False)
        self.assertFalse(self.receipt['available'])
        self.assertFalse(self.receipt['passed'])
        self.conn.execute.assert_not_called()
        self.browser.assert_not_called()
