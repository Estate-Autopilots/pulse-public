"""Staging only, on request (EST-1964): an issued synthetic quotation on the real catalogue, for EST-1237's acceptance.

The staging smoke runs this pass only while ~/.local/state/pulse-release/billing-acceptance.request exists, and consumes
the file. An issued document is kept as it was (erp_document_guard, erp_file_fixed), so the pass issues as its own
synthetic leadership issuer, never as the release people that cleanup() deletes. The issued quotation and proforma keep
that issuer and their synthetic client until the nightly refresh (21:30Z) restores staging from production. Drafts and
the billing party are deleted, every issued document still open is cancelled with a "Release validation" note, and the
issuer loses its password, sessions and role. A product failure is recorded with its step and the train stays green; a
revocation that does not hold fails the smoke. The receipt keeps verdicts and the staging number, never catalogue names,
amounts, PDF bytes or ids.
"""
import json
import os
import subprocess
import uuid
from pathlib import Path

from release_smoke_paths import browser_runtime

REQUEST = Path(os.environ.get('PULSE_RELEASE_STATE', '/home/eadev/.local/state/pulse-release')) / 'billing-acceptance.request'
PARTY = 'Release validation Billing party (synthetic)'
ISSUER = 'Release validation Billing issuer (synthetic)'
EVIDENCE = 'Release verification; Billing issuer kept until the nightly staging refresh'
NOTE = 'Release validation: synthetic staging document, cancelled after the EST-1964 check'
OPEN = ('issued', 'sent', 'accepted')


class Step(Exception):
    """A product or fixture step that did not hold: recorded with its name, never raised to the train."""


def run_browser(ctx, payload):
    """tools/release-billing-acceptance.mjs; its receipt file is read even when it failed part way."""
    out = Path(ctx['out'])
    receipt = out / (ctx['environment'] + '-billing-acceptance-browser.json')
    receipt.unlink(missing_ok=True)
    with browser_runtime(out, payload) as (browser_input, env):
        result = subprocess.run(['node', 'tools/release-billing-acceptance.mjs', str(browser_input)], cwd=ctx['source'],
                                capture_output=True, text=True, timeout=600, env=env)
    if result.returncode:
        safe = result.stderr[-8000:]
        for secret in (ctx['password'], payload['issuer'], payload['person']):
            safe = safe.replace(secret, '[credential omitted]')
        diagnostic = out / (ctx['environment'] + '-billing-acceptance-diagnostic.private.log')
        diagnostic.write_text(safe)
        diagnostic.chmod(0o600)
    return json.loads(receipt.read_text()) if receipt.exists() else {'passed': False, 'step': 'browser receipt missing'}


def billing_acceptance(conn, call, check, ctx, browser=run_browser, request=REQUEST):
    receipt = {'requested': request.exists()}
    if not receipt['requested']:
        return receipt
    request.unlink(missing_ok=True)  # one request, one pass: a failure does not repeat on every train
    org, issuer, client = ctx['org'], str(uuid.uuid4()), str(uuid.uuid4())
    made = {'issuer': False, 'client': False}
    session = {}
    receipt.update(passed=False, step=None, cleanup={'passed': False})

    def as_issuer(path, body=None):
        return call(path, None, body, {'Cookie': 'pulse_session=' + session['token']})

    def step(name, passed):
        receipt['step'] = name
        if not passed:
            raise Step(name)

    try:
        status, catalogue, _, _ = call('/api/v0/erp/items', 'leadership')
        packages = [i for i in (catalogue or {}).get('items', []) if i.get('kind') == 'package' and i.get('status') != 'archived']
        step('real catalogue package', status == 200 and bool(packages))
        package = packages[0]
        status, setup, _, _ = call('/api/v0/erp/settings', 'leadership')
        company = (setup or {}).get('company') or {}
        step('company profile for issuing', status == 200 and bool(company.get('legalName')) and bool(company.get('stateCode')))
        with conn.transaction():
            conn.execute("select set_config('pulse.org_id',%s,true)", (org,))
            conn.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,%s,'staff')", (issuer, org, ISSUER))
            conn.execute("insert into pulse.people_profile(org_id,person_id,role,pod,username,evidence,accounts) values(%s,%s,'leadership','Pod 1',%s,%s,'{}')",
                         (org, issuer, ctx['prefix'] + '.billing', EVIDENCE))
            conn.execute("insert into pulse.role_assignment(org_id,person_id,role_key,unit_id,valid_from) values(%s,%s,'leadership',null,'2020-01-01')", (org, issuer))
            conn.execute("insert into pulse.login_credential(org_id,person_id,password_hash,must_change,status) values(%s,%s,crypt(%s,gen_salt('bf',10)),false,'active')",
                         (org, issuer, ctx['password']))
        made['issuer'] = True
        status, _, headers, _ = call('/api/v0/auth/sign-in', body={'username': ctx['prefix'] + '.billing', 'password': ctx['password']})
        cookie = headers.get('Set-Cookie', headers.get('set-cookie', '')) if status == 200 else ''
        step('issuer password sign-in', 'pulse_session=' in cookie)
        session['token'] = cookie.split('pulse_session=', 1)[1].split(';', 1)[0]
        with conn.transaction():
            conn.execute("select set_config('pulse.org_id',%s,true)", (org,))
            conn.execute("insert into pulse.client(id,org_id,display_name) values(%s,%s,%s)", (client, org, PARTY))
        made['client'] = True
        buyer = {'name': PARTY, 'stateCode': '27'}  # no phone or e-mail: nothing can reach a real person
        status, _, _, _ = as_issuer('/api/v0/erp/parties/' + client, buyer)
        step('synthetic party saved', status == 200)
        status, draft, _, _ = as_issuer('/api/v0/erp/documents', {'docType': 'quotation', 'clientId': client})
        step('quotation draft created', status == 200 and bool((draft or {}).get('id')))
        quote = draft['id']
        path = '/api/v0/erp/documents/' + quote
        status, detail, _, _ = as_issuer(path)
        step('quotation draft read', status == 200 and detail['document']['status'] == 'draft')
        doc = detail['document']
        body = {'issueDate': doc['issueDate'], 'validUntil': doc.get('validUntil'), 'buyer': buyer, 'placeOfSupply': buyer['stateCode'],
                'templateId': doc.get('templateId'), 'lines': [{
                    'itemId': package['id'], 'description': package['name'], 'details': (package.get('description') or '')[:1000],
                    'sac': package.get('sac'), 'unit': package.get('unit'), 'qty': 1, 'rate': package['price'], 'gstRate': package['gstRate']}]}
        status, _, _, _ = as_issuer(path, body)
        step('quotation saved from a real package', status == 200)
        status, issued, _, _ = as_issuer(path + '/issue', {'draft': body})
        step('quotation issued', status == 200 and bool((issued or {}).get('number')))
        status, detail, _, _ = as_issuer(path)
        d, lines = detail['document'], detail['lines']
        step('issued quotation reads back', status == 200 and d['status'] == 'issued' and d['number'] == issued['number'] and d['buyer']['name'] == PARTY
             and len(lines) == 1 and lines[0]['itemId'] == package['id'] and lines[0]['qty'] == 1)
        receipt['quote'] = {'number': d['number'], 'status': d['status'], 'buyer': PARTY, 'catalogueLine': True, 'qty': 1, 'gstRate': lines[0]['gstRate']}
        receipt['step'] = 'browser'
        result = browser(ctx, {'origin': ctx['origin'], 'port': ctx['port'], 'out': ctx['out'], 'environment': ctx['environment'],
                               'issuer': session['token'], 'person': ctx['personSession'],
                               'quote': {'id': quote, 'number': d['number'], 'buyer': PARTY, 'itemId': package['id'], 'gstRate': lines[0]['gstRate']}})
        receipt['browser'] = {key: result.get(key) for key in ('passed', 'step', 'checks', 'screenshots')}
        step('browser: ' + str(result.get('step')), result.get('passed') is True)
        with conn.transaction():
            conn.execute("select set_config('pulse.org_id',%s,true)", (org,))
            chain = conn.execute("select id::text id,doc_type,status,source_id::text source from pulse.erp_document where org_id=%s and client_id=%s",
                                 (org, client)).fetchall()
        kinds = {kind: [r for r in chain if r['doc_type'] == kind] for kind in ('quotation', 'proforma', 'invoice')}
        step('one proforma from the quotation, issued; the quotation converted',
             len(kinds['proforma']) == 1 and kinds['proforma'][0]['source'] == quote and kinds['proforma'][0]['status'] == 'issued'
             and [r['status'] for r in kinds['quotation']] == ['converted'])
        step('one tax invoice draft from the proforma',
             len(kinds['invoice']) == 1 and kinds['invoice'][0]['status'] == 'draft' and kinds['invoice'][0]['source'] == kinds['proforma'][0]['id'])
        receipt.update(passed=True, step=None)
    except Step as failure:
        receipt['failed'] = str(failure)
    except Exception as error:  # a lost reply or a changed API shape is recorded the same way
        receipt['failed'] = 'after ' + (receipt.get('step') or 'the request') + ': ' + type(error).__name__
    finally:
        receipt['cleanup'] = done = {'passed': False}
        try:
            tidy(conn, call, check, ctx, org, issuer, client, made, session.get('token'), done)
        finally:
            if receipt['passed'] and not done['passed']:
                receipt.update(passed=False, failed='cleanup: ' + ('; '.join(done.get('errors') or []) or 'revocation'))
            save(ctx, receipt)
    return receipt


def save(ctx, receipt):
    """The combined setup, browser and cleanup receipt, private to the train's report dir; written on failure too."""
    path = Path(ctx['out']) / (ctx['environment'] + '-billing-acceptance.json')
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as handle:
        json.dump(receipt, handle, indent=2, sort_keys=True)
    path.chmod(0o600)


def tidy(conn, call, check, ctx, org, issuer, client, made, token, done):
    """Drafts and the party go; documents still open are cancelled with the note; the client and the issuer stay only while
    an issued document refers to them. Whatever fails before it, the issuer always loses its access: a revocation that does
    not hold fails the smoke, while any other cleanup failure is recorded in `errors` and fails only this receipt."""
    done.update(cancelled=[], stillOpen=0, draftsDeleted=0, partyDeleted=False, clientKept=False, issuerKept=False,
                issuerInactive=False, errors=[])
    errors = done['errors']

    def scoped(query, params=()):
        conn.execute("select set_config('pulse.org_id',%s,true)", (org,))
        return conn.execute(query, params)
    open_docs = "select id::text id,doc_type from pulse.erp_document where org_id=%s and client_id=%s and status=any(%s) order by created_at"
    try:
        if made['client']:
            if token:
                with conn.transaction():
                    still_open = scoped(open_docs, (org, client, list(OPEN))).fetchall()
                for doc in still_open:
                    try:
                        status = call('/api/v0/erp/documents/' + doc['id'] + '/mark', None, {'action': 'cancel', 'note': NOTE},
                                      {'Cookie': 'pulse_session=' + token})[0]
                    except Exception as error:
                        errors.append('cancel ' + doc['doc_type'] + ': ' + type(error).__name__)
                        continue
                    if status == 200:
                        done['cancelled'].append(doc['doc_type'])
                    else:
                        errors.append('cancel ' + doc['doc_type'] + ': HTTP ' + str(status))
            with conn.transaction():
                done['stillOpen'] = len(scoped(open_docs, (org, client, list(OPEN))).fetchall())
                # Every predicate is scoped to this run's random client and issuer; an issued document is never deleted.
                conn.execute("""delete from pulse.erp_event where org_id=%s and actor=%s and subject_type='document' and subject_id in
                  (select id from pulse.erp_document where org_id=%s and client_id=%s and created_by=%s and status='draft')""", (org, issuer, org, client, issuer))
                done['draftsDeleted'] = conn.execute("delete from pulse.erp_document where org_id=%s and client_id=%s and created_by=%s and status='draft'",
                                                     (org, client, issuer)).rowcount
                done['partyDeleted'] = conn.execute('delete from pulse.erp_party where org_id=%s and client_id=%s', (org, client)).rowcount == 1
                done['clientKept'] = conn.execute('select exists(select 1 from pulse.erp_document where org_id=%s and client_id=%s) kept', (org, client)).fetchone()['kept']
                if not done['clientKept']:
                    conn.execute('delete from pulse.client where org_id=%s and id=%s', (org, client))
            if done['stillOpen']:
                errors.append(str(done['stillOpen']) + ' synthetic documents still open')
    except Exception as error:
        errors.append('documents: ' + type(error).__name__)
    finally:
        if made['issuer']:
            revoke(conn, call, check, ctx, org, issuer, token, done, scoped)
    done['passed'] = not errors
    return done


def revoke(conn, call, check, ctx, org, issuer, token, done, scoped):
    errors = done['errors']
    revoked = True
    try:
        with conn.transaction():
            for table in ('pulse.login_session', 'pulse.login_credential', 'pulse.role_assignment'):
                scoped('delete from ' + table + ' where person_id=%s', (issuer,))
    except Exception as error:
        revoked = False
        errors.append('revocation: ' + type(error).__name__)
    try:
        with conn.transaction():
            done['issuerKept'] = scoped("""select exists(select 1 from pulse.erp_document where org_id=%s and (issued_by=%s or created_by=%s)) kept""",
                                        (org, issuer, issuer)).fetchone()['kept']
        if done['issuerKept']:
            # Off the current staff lists until the refresh; lifecycle_moving keeps it out of the HR lifecycle history.
            with conn.transaction():
                conn.execute("select set_config('pulse.lifecycle_moving','1',true)")
                scoped("update pulse.person set status='inactive' where org_id=%s and id=%s", (org, issuer))
                done['issuerInactive'] = scoped('select status from pulse.person where org_id=%s and id=%s',
                                                (org, issuer)).fetchone()['status'] == 'inactive'
            if not done['issuerInactive']:
                errors.append('issuer still active')
        else:
            ctx['cleanup']([issuer])  # nothing issued refers to it: removed like the release people
    except Exception as error:
        errors.append('issuer: ' + type(error).__name__)
    status = call('/api/v0/auth/sign-in', body={'username': ctx['prefix'] + '.billing', 'password': ctx['password']})[0]
    check('Billing acceptance issuer can no longer sign in', status == 401)
    if token:
        check('Billing acceptance issuer session revoked', call('/api/v0/me', None, None, {'Cookie': 'pulse_session=' + token})[0] == 401)
    check('Billing acceptance issuer credential, sessions and role removed', revoked)
