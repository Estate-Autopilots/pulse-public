"""Staging-only Billing export check. Never persist catalogue, buyer or exported bytes."""
import json
import subprocess
import uuid
from pathlib import Path


def billing_exports(conn, call, check, org, viewer, receipt, context=None):
    receipt.update({'passed': False, 'pdf': {'bytes': 0, 'passed': False},
                    'docx': {'bytes': 0, 'passed': False}, 'cleanup': {'passed': False}})
    status, catalogue, _, _ = call('/api/v0/erp/items', 'leadership')
    packages = [i for i in (catalogue or {}).get('items', [])
                if i.get('kind') == 'package' and i.get('status') != 'archived']
    check('Billing real catalogue has a package', status == 200 and bool(packages))
    package = packages[0]
    client = str(uuid.uuid4())
    buyer = {'name': 'Release validation Billing party (synthetic)', 'stateCode': '27'}
    draft = None
    # Enter cleanup only after our insert committed; an insertion failure must not
    # remove a pre-existing row, even if the random ID happened to collide.
    with conn.transaction():
        conn.execute("select set_config('pulse.org_id',%s,true)", (org,))
        conn.execute("insert into pulse.client(id,org_id,display_name) values(%s,%s,%s)",
                     (client, org, buyer['name']))
    try:
        status, _, _, _ = call('/api/v0/erp/parties/' + client, 'leadership', buyer)
        check('Billing synthetic party saved', status == 200)
        status, draft, _, _ = call('/api/v0/erp/documents', 'leadership',
                                   {'docType': 'quotation', 'clientId': client})
        check('Billing synthetic quotation created', status == 200 and bool((draft or {}).get('id')))
        path = '/api/v0/erp/documents/' + draft['id']
        status, detail, _, _ = call(path, 'leadership')
        check('Billing quotation remains a draft', status == 200 and detail['document']['status'] == 'draft')
        doc = detail['document']
        status, _, _, _ = call(path, 'leadership', {
            'issueDate': doc['issueDate'], 'buyer': buyer, 'placeOfSupply': buyer['stateCode'],
            'templateId': doc.get('templateId'), 'lines': [{
                'itemId': package['id'], 'description': package['name'],
                'details': package.get('description', '')[:1000], 'sac': package.get('sac'),
                'unit': package.get('unit'), 'qty': 1, 'rate': package['price'],
                'gstRate': package['gstRate'],
            }],
        })
        check('Billing quotation saved from catalogue package', status == 200)
        for kind, signature in [('pdf', b'%PDF'), ('docx', b'PK')]:
            status, _, _, raw = call(path + '/' + kind, 'leadership')
            receipt[kind] = {'bytes': len(raw), 'passed': status == 200 and len(raw) > len(signature)
                             and raw.startswith(signature)}
            check('Billing quotation ' + kind + ' export', receipt[kind]['passed'])
        if context is not None:
            quote_lines(conn, call, check, org, viewer, client, path, doc, package,
                        receipt.setdefault('quoteLines', {}), context)
        status, _, _, _ = call(path + '/delete', 'leadership', {})
        check('Billing synthetic draft deleted', status == 200)
    finally:
        # Also covers a lost HTTP response after creation. Every predicate is scoped to our
        # random client and synthetic writer; never delete an issued document or a real party.
        with conn.transaction():
            conn.execute("select set_config('pulse.org_id',%s,true)", (org,))
            conn.execute("""delete from pulse.erp_event where org_id=%s and actor=%s
              and ((subject_type='party' and subject_id=%s) or
                   (subject_type='document' and subject_id in
                    (select id from pulse.erp_document where org_id=%s and client_id=%s
                     and created_by=%s and status='draft')))""", (org, viewer, client, org, client, viewer))
            # Draft deletion keeps its event log, so clear only this synthetic writer's log.
            if isinstance(draft, dict) and draft.get('id'):
                conn.execute("delete from pulse.erp_event where org_id=%s and actor=%s and subject_type='document' and subject_id=%s",
                             (org, viewer, draft['id']))
            conn.execute("delete from pulse.erp_document where org_id=%s and client_id=%s and created_by=%s and status='draft'",
                         (org, client, viewer))
            conn.execute("delete from pulse.erp_party where org_id=%s and client_id=%s", (org, client))
            conn.execute("delete from pulse.client where org_id=%s and id=%s", (org, client))
            left = conn.execute("""select exists(select 1 from pulse.client where org_id=%s and id=%s)
              or exists(select 1 from pulse.erp_party where org_id=%s and client_id=%s)
              or exists(select 1 from pulse.erp_document where org_id=%s and client_id=%s) remaining""",
                                (org, client, org, client, org, client)).fetchone()['remaining']
            check('Billing synthetic draft and party removed', not left)
            receipt['cleanup']['passed'] = not left
    receipt['passed'] = True
    return receipt


def quote_lines(conn, call, check, org, viewer, client, path, doc, package, receipt, ctx, browser=None):
    """Only the export pass's random synthetic draft; its enclosing finally always cleans up."""
    check('Quote-lines staging context', ctx['environment'] == 'staging'
          and ctx['origin'] == 'https://pulse-staging.estateautopilots.com' and ctx['port'] == 4102)
    available = (Path(ctx['source']) / 'db/migrations/0545_quote_lines.sql').is_file()
    receipt.update(available=available, passed=False, syntheticOnly=True)
    if not available:
        return  # The hook may merge before the separately reviewed API fold; never claim acceptance.
    sha = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ctx['source'], text=True).strip()
    status, health, _, _ = call('/healthz')
    check('Quote-lines deployed source matches smoke checkout', status == 200 and health.get('release') == sha)
    with conn.transaction():
        check('Quote-lines migration 0545 applied', conn.execute(
            "select exists(select 1 from public.schema_migrations where version='0545') ok").fetchone()['ok'])
        conn.execute("select set_config('pulse.org_id',%s,true)", (org,))
        changed = conn.execute("""update pulse.erp_line l set catalogue_rate=100000
          from pulse.erp_document d where l.document_id=d.id and l.org_id=%s and d.org_id=%s
          and d.id=%s and d.client_id=%s and d.created_by=%s and d.status='draft'
          and l.position=0 and l.item_id=%s""", (org, org, path.rsplit('/', 1)[1], client, viewer, package['id']))
        check('Quote-lines baseline seeded only on synthetic draft', changed.rowcount == 1)
    rows = [
        {'itemId': package['id'], 'description': 'Synthetic base', 'rate': 100000, 'gstRate': 18},
        {'description': 'Synthetic add-on', 'rate': 10000, 'gstRate': 18, 'parentIndex': 0},
        {'description': 'Synthetic open charge', 'rate': 0, 'gstRate': 18, 'open': True},
    ]
    body = {'issueDate': doc['issueDate'], 'buyer': {'name': 'Release validation Billing party (synthetic)',
            'stateCode': '27'}, 'placeOfSupply': '27', 'roundTotal': False, 'lines': rows}

    def save(lines):
        check('Quote-lines synthetic draft saved', call(path, 'leadership', {**body, 'lines': lines})[0] == 200)
        status, saved, _, _ = call(path, 'leadership')
        check('Quote-lines draft reads back', status == 200 and saved['document']['status'] == 'draft'
              and len(saved['lines']) == 3)
        return saved

    saved = save(rows)
    check('Quote-lines saved parent and open flag', saved['lines'][1]['parentIndex'] == 0
          and saved['lines'][1]['parentLineId'] == saved['lines'][0]['id'] and saved['lines'][2]['open'] is True
          and saved['document']['taxable'] == 110000)
    # Empty buyer is a second, database-level issuance refusal if the open-amount guard regresses.
    status, refused, _, _ = call(path + '/issue', 'leadership', {'draft': {**body, 'buyer': {'stateCode': '27'}}})
    check('Quote-lines unfilled open amount returns 400', status == 400
          and refused.get('error') == 'Fill each open amount or mark it not needed')
    saved = save([{**line, 'notNeeded': i != 1} for i, line in enumerate(rows)])
    check('Quote-lines parent exclusion propagates and total is zero',
          [line['notNeeded'] for line in saved['lines']] == [True, True, True] and saved['document']['total'] == 0)
    restored = [{**line, 'notNeeded': i == 2} for i, line in enumerate(rows)]
    saved = save(restored)
    check('Quote-lines restored total excludes open charge',
          [line['notNeeded'] for line in saved['lines']] == [False, False, True]
          and saved['document']['taxable'] == 110000 and saved['document']['total'] == 129800)
    with conn.transaction():
        conn.execute("select set_config('pulse.org_id',%s,true)", (org,))
        baseline = conn.execute("select catalogue_rate from pulse.erp_line where org_id=%s and document_id=%s and position=0",
                                (org, path.rsplit('/', 1)[1])).fetchone()
        check('Quote-lines catalogue baseline retained through saves', baseline['catalogue_rate'] == 100000)
    # Unbind the real catalogue reference before the screenshot: all visible line data is synthetic.
    save([{**line, 'itemId': None} for line in restored])
    capture = browser or quote_lines_browser
    shot = capture(ctx, {'document': path.rsplit('/', 1)[1], 'sourceSha': sha})
    check('Quote-lines synthetic screenshot captured', shot.get('passed') is True)
    receipt.update(passed=True, sourceSha=sha, openAmount400=True, parentPersisted=True,
                   exclusions=True, restoredTotal=True, catalogueRateRetained=True, screenshot=shot['screenshot'])


def quote_lines_browser(ctx, document):
    from release_smoke_paths import browser_runtime

    payload = {key: ctx[key] for key in ('environment', 'origin', 'port', 'out', 'session')}
    with browser_runtime(Path(ctx['out']), {**payload, **document}) as (private, env):
        result = subprocess.run(['node', 'tools/release-quote-lines.mjs', str(private)], cwd=ctx['source'],
                                capture_output=True, text=True, timeout=120, env=env)
    if result.returncode:
        raise AssertionError('Quote-lines browser failed; private session and response details withheld')
    return json.loads(result.stdout)
