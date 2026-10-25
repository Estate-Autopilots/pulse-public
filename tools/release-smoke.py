#!/usr/bin/env python3
"""Signed-out production checks; synthetic account and role validation on staging."""
import base64
import hashlib
import json
import os
import re
import secrets
import subprocess
import sys
import time
import uuid
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, build_opener, ProxyHandler, HTTPRedirectHandler
from urllib.parse import urlsplit, parse_qs

import psycopg
from psycopg import sql
from psycopg.rows import dict_row
from editor_week_smoke import aggregate_editor_week
from release_billing_smoke import billing_exports
from release_billing_acceptance import billing_acceptance
from release_smoke_paths import browser_runtime, catalogue_credential_probe, require_api_dist_in_checkout, sealed_elsewhere
from service_key_smoke import access_headers, service_key_probes

envname = sys.argv[1]
assert envname in ('production', 'staging')
source = Path(__file__).resolve().parents[1]
if envname == 'staging':
    require_api_dist_in_checkout(source)
out = Path(os.environ.get('PULSE_RELEASE_REPORT', '/home/eadev/ea-research/release-v0.3.0'))
out.mkdir(parents=True, exist_ok=True)
port = 4002 if envname == 'production' else 4102
public = 'https://' + ('pulse' if envname == 'production' else 'pulse-staging') + '.estateautopilots.com'
report = {'environment': envname, 'origin': public, 'checks': [], 'roles': {}, 'browser': None}

def check(label, condition):
    report['checks'].append({'check': label, 'passed': bool(condition)})
    if not condition:
        raise AssertionError(label)

for target, base, host, access in [
    ('public', public, None, access_headers() if envname == 'staging' else {}),
    ('loopback', f'http://127.0.0.1:{port}', urlsplit(public).netloc, {}),
]:
    if target == 'public' and envname == 'staging' and not access:
        report['checks'].append({'check': 'service key public', 'skipped': True,
                                 'reason': 'Staging Access credentials unavailable; contract adjusted in EST-1901'})
        continue
    for probe in service_key_probes(base, host, access):
        check(f'service key {target} {probe["check"]}: HTTP {probe["status"]} expected {probe["expected"]}', probe['passed'])

# Owner's public-auth release policy: production checks must never create accounts or send mail.
if envname == 'production':
    checks = report['checks']
    public_opener = build_opener(ProxyHandler({}))
    for path, expected in [('/healthz',200),('/login',200),('/login/set-password',200),('/login/confirm-email',200),('/portal/login',200),('/portal/set-password',200),('/portal/confirm-email',200),('/api/v0/me',401),('/api/v0/auth/account',401),('/api/v0/portal/auth/account',401),('/api/v0/admin/access',401),('/api/v0/admin/auth-policy',401),('/api/v0/companion/inbox',401),('/api/v0/companion/notification-settings',401),('/api/v0/notifications',401)]:
        req = Request(public+path, headers={'User-Agent':'Mozilla/5.0 Pulse signed-out release check'})
        try:
            with public_opener.open(req,timeout=30) as response:
                status=response.status; body=response.read()
        except HTTPError as error:
            status=error.code; body=error.read()
        passed=status==expected
        checks.append({'path':path,'expected':expected,'status':status,'passed':passed})
        if not passed: raise AssertionError('production signed-out check '+path+' HTTP '+str(status))
    for path in ['/api/v0/auth/forgot','/api/v0/auth/forgot-username','/api/v0/auth/sign-in','/api/v0/auth/set-password','/api/v0/auth/two-step','/api/v0/auth/confirm-email']:
        req=Request(public+path,data=b'{}',headers={'User-Agent':'Mozilla/5.0 Pulse signed-out release check','Content-Type':'application/json','Origin':'https://foreign.example'})
        try:
            with public_opener.open(req,timeout=30) as response:status=response.status
        except HTTPError as error:status=error.code
        passed=status==403;checks.append({'path':path,'foreignOrigin':True,'status':status,'passed':passed})
        if not passed:raise AssertionError('production CSRF '+path)
    (out/'production-public-check.json').write_text(json.dumps({'environment':'production','signedOutOnly':True,'checks':checks,'accountsTouched':0,'emailsSent':0},indent=2)+'\n')
    # Owner-authorized R18 read-only check of real production attendance; no production identity/session is created.
    # The root broker supplies its existing private connection; never print it or raw query rows.
    with psycopg.connect(os.environ['PULSE_RELEASE_TEST_URL'], row_factory=dict_row) as production_read:
        production_read.execute('set transaction read only')
        db_owner = production_read.execute('select pg_get_userbyid(datdba) owner from pg_database where datname=current_database()').fetchone()['owner']
        production_read.execute(sql.SQL('set local role {}').format(sql.Identifier(db_owner)))
        org = production_read.execute('select pulse.install_org() org').fetchone()['org']
        if not org: raise AssertionError('Production install is not initialised')
        production_read.execute("select set_config('pulse.org_id',%s,true)", (str(org),))
        period = production_read.execute("select date_trunc('month',now() at time zone 'Asia/Kolkata')::date::text f,(now() at time zone 'Asia/Kolkata')::date::text t").fetchone()
        rows = production_read.execute("""select jsonb_build_object('id',e.id,'personId',e.person_id,'date',e.work_date::text,'in',e.checked_in_at,'out',e.checked_out_at,'missedOut',e.missed_out,
          'pendingCorrection',exists(select 1 from pulse.attendance_regularisation r where r.org_id=e.org_id and r.person_id=e.person_id and r.work_date=e.work_date and r.kind='missed_punch' and r.status='pending'),
          'breaks',coalesce(b.rows,'[]'::jsonb),'worked',greatest(0,round(extract(epoch from coalesce(e.checked_out_at,now())-e.checked_in_at)/60)-coalesce(b.minutes,0))) data
          from pulse.attendance_effective e join pulse.person p on p.id=e.person_id and p.status='active' and p.side='staff'
          left join lateral (select jsonb_agg(jsonb_build_object('in',x.started_at,'out',x.ended_at)) rows,
            round(sum(extract(epoch from coalesce(x.ended_at,now())-x.started_at))/60)::int minutes
            from pulse.attendance_break x where x.org_id=e.org_id and x.entry_id=e.id) b on true
          where e.org_id=pulse.current_org() and (e.work_date between %s::date and %s::date or exists(select 1 from pulse.attendance_effective peer where peer.org_id=e.org_id and peer.person_id=e.person_id
            and peer.work_date between %s::date and %s::date and e.checked_in_at<coalesce(peer.checked_out_at,now()) and coalesce(e.checked_out_at,now())>peer.checked_in_at))""",
          (period['f'],period['t'],period['f'],period['t'])).fetchall()
        production_read.rollback()
    masked_run = subprocess.run(['node','tools/attendance-production-check.mjs'],cwd=source,
        input=json.dumps({'entries':[row['data'] for row in rows],'from':period['f'],'to':period['t']}),capture_output=True,text=True)
    if masked_run.returncode: raise AssertionError('Masked production attendance verification failed; private diagnostics withheld')
    masked = json.loads(masked_run.stdout)
    masked['sourceSha'] = subprocess.check_output(['git','rev-parse','HEAD'],cwd=source,text=True).strip()
    (out/'production-attendance-masked.json').write_text(json.dumps(masked,indent=2)+'\n')
    print(str(len(checks))+' production signed-out checks passed; no accounts touched or emails sent')
    raise SystemExit(0)

url = os.environ.get('PULSE_RELEASE_TEST_URL')
if not url:
    values = {}
    for line in Path('/etc/estate-autopilots/db/pulse.env').read_text().splitlines():
        if '=' in line and not line.startswith('#'):
            k, v = line.split('=', 1); values[k] = v.strip('"\'')
    url = values['PULSE_DATABASE_URL_MIGRATE']
    if envname == 'staging': raise SystemExit('Staging smoke uses the root broker for its owner connection')
roles = ['person', 'manager', 'pgs', 'hr', 'leadership', 'admin']
people = {role: str(uuid.uuid4()) for role in roles}
password = secrets.token_urlsafe(24)
prefix = 'release.' + secrets.token_hex(4)
test_ip = '198.51.100.' + str(secrets.randbelow(200)+20)
sessions = {}
modules_off = set()  # filled from each role's /api/v0/me (the company's off modules and the server's)
opener = build_opener(ProxyHandler({}))
class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs): return None
google_opener = build_opener(ProxyHandler({}), NoRedirect())

def public_branding_ok(status, data):
    # EST-1397: `google` tells the sign-in page whether to offer Continue with Google; a flag, nothing more.
    return (status == 200 and isinstance(data, dict) and set(data) == {'name', 'google'}
            and isinstance(data['name'], str) and bool(data['name'].strip()) and isinstance(data['google'], bool))

# Keep the public branding exception narrow even when the live response is valid.
check('anonymous branding contract self-test',
      public_branding_ok(200, {'name': 'Pulse', 'google': False})
      and public_branding_ok(200, {'name': 'Pulse', 'google': True})
      and not public_branding_ok(200, {'name': 'Pulse', 'google': 'yes'})
      and not public_branding_ok(200, {'name': 'Pulse', 'google': False, 'people': 3})
      and not public_branding_ok(401, {'name': 'Pulse', 'google': False}))

# Signed-out routes that answer on purpose (RELEASE-3), each held to a narrow contract; every other /api/ route still
# answers 401 signed out. LAYOUT-SWEEP's organisation name and logo flags (the sign-in page and e-mails show them; no
# people, no data); the literal ':kind' is no picture; PEOPLE-CONTACTS' one-time sign-in link refuses a malformed token.
# R51 (RELEASE-6): the company's time zone, so the web shows days and due times on the company's clock from the first
# page; a time-zone name or nothing, never more.
BRAND_KEYS = {'name', 'code', 'version', 'mark', 'logo', 'logoDark', 'logoPng', 'accent', 'timeZone'}
def brand_ok(data):
    zone = data.get('timeZone') if isinstance(data, dict) else None
    return isinstance(data, dict) and set(data) <= BRAND_KEYS and 'name' in data and (zone is None or (isinstance(zone, str) and bool(re.fullmatch(r'[A-Za-z_]+(/[A-Za-z0-9_+-]+)*', zone))))
PUBLIC_ROUTES = {('GET', '/api/v0/auth/branding'), ('GET', '/api/v0/brand'), ('GET', '/api/v0/brand/:kind'), ('POST', '/api/v0/auth/link-sign-in'), ('GET', '/api/v0/auth/google/start'), ('GET', '/api/v0/auth/google/callback'), ('GET', '/api/v1/openapi.json')}
GOOGLE_PATHS = {'/api/v0/auth/google/start', '/api/v0/auth/google/callback'}
OIDC_CLEAR = 'pulse_oidc=; Path=/api/v0/auth/google; HttpOnly; Secure; SameSite=Lax; Max-Age=0'
# EST-1611: the API v1 reference needs no key; it is exactly the committed openapi/v1.yaml (JSON) and sets no cookie.
V1_REFERENCE = json.loads(re.sub(r'(?m)^#.*\n', '', (source / 'services/api/openapi/v1.yaml').read_text()))
def public_route_ok(method, url, status, data, headers=None, raw=b''):
    if (method, url) == ('GET', '/api/v1/openapi.json'):
        h = {k.lower() for k in (headers or {})}
        return status == 200 and data == V1_REFERENCE and not h & {'set-cookie', 'x-pulse-session-token', 'x-pulse-two-step-challenge'}
    if (method, url) == ('GET', '/api/v0/auth/google/callback'):
        h = {k.lower(): v for k, v in (headers or {}).items()}
        cookies = [v for k, v in (headers or {}).items() if k.lower() == 'set-cookie']
        if status != 302 or data is not None or raw or any(k in h for k in ('x-pulse-session-token', 'x-pulse-two-step-challenge', 'authorization')): return False
        # No state: the API sends the attempt back to sign-in and the proxy clears pulse_oidc; an API error is the proxy fallback.
        return (h.get('location') == '/login?next=%2F&google=state_invalid' and cookies == [OIDC_CLEAR]) or (h.get('location') == '/login?google=provider_error' and not cookies)
    if (method, url) == ('GET', '/api/v0/auth/google/start'):
        h = {k.lower(): v for k, v in (headers or {}).items()}
        cookies = [v for k, v in (headers or {}).items() if k.lower() == 'set-cookie']
        if status != 302 or data is not None or raw or any(k in h for k in ('x-pulse-session-token', 'x-pulse-two-step-challenge', 'authorization')): return False
        location = h.get('location', '')
        # Staging's disabled provider returns here; inspect the first hop, never the followed HTML 200.
        if location == '/login?google=provider_error': return not cookies
        provider = urlsplit(location)
        query = parse_qs(provider.query, keep_blank_values=True)
        return (provider.scheme == 'https' and provider.netloc == 'accounts.google.com' and provider.path == '/o/oauth2/v2/auth' and not provider.fragment
                and set(query) <= {'client_id', 'redirect_uri', 'response_type', 'scope', 'state', 'nonce', 'code_challenge', 'code_challenge_method', 'prompt', 'hd', 'max_age'}
                and query.get('response_type') == ['code'] and query.get('code_challenge_method') == ['S256']
                and len(cookies) == 1 and re.fullmatch(r'pulse_oidc=[\w-]{16,256}; Path=/api/v0/auth/google; HttpOnly; Secure; SameSite=Lax; Max-Age=600', cookies[0]) is not None)
    if (method, url) == ('GET', '/api/v0/auth/branding'): return public_branding_ok(status, data)
    if (method, url) == ('GET', '/api/v0/brand'): return status == 200 and brand_ok(data)
    if (method, url) == ('GET', '/api/v0/brand/:kind'): return status == 404
    if (method, url) == ('POST', '/api/v0/auth/link-sign-in'): return status in (400, 429) and not (isinstance(data, dict) and 'token' in data)
    return False
check('anonymous public route contract self-test',
      public_route_ok('GET', '/api/v0/brand', 200, {'name': 'Pulse', 'mark': False})
      and public_route_ok('GET', '/api/v0/brand', 200, {'name': 'Pulse', 'timeZone': 'Asia/Kolkata'})
      and not public_route_ok('GET', '/api/v0/brand', 200, {'name': 'Pulse', 'timeZone': {'people': 3}})
      and not public_route_ok('GET', '/api/v0/brand', 200, {'name': 'Pulse', 'people': 3})
      and not public_route_ok('POST', '/api/v0/auth/link-sign-in', 200, {'token': 'x'})
      and public_route_ok('GET', '/api/v0/auth/google/start', 302, None, {'Location': '/login?google=provider_error'})
      and public_route_ok('GET', '/api/v0/auth/google/start', 302, None, {'Location': 'https://accounts.google.com/o/oauth2/v2/auth?response_type=code&code_challenge_method=S256', 'Set-Cookie': 'pulse_oidc=synthetic-attempt; Path=/api/v0/auth/google; HttpOnly; Secure; SameSite=Lax; Max-Age=600'})
      and not public_route_ok('GET', '/api/v0/auth/google/start', 200, {'token': 'x', 'person': {}})
      and not public_route_ok('GET', '/api/v0/auth/google/start', 302, None, {'Location': '/login?google=provider_error', 'Set-Cookie': 'pulse_session=x'})
      and not public_route_ok('GET', '/api/v0/auth/google/start', 302, None, {'Location': '/login?google=provider_error'}, b'{"token":"x"}')
      and public_route_ok('GET', '/api/v0/auth/google/callback', 302, None, {'Location': '/login?next=%2F&google=state_invalid', 'Set-Cookie': OIDC_CLEAR})
      and public_route_ok('GET', '/api/v0/auth/google/callback', 302, None, {'Location': '/login?google=provider_error'})
      and not public_route_ok('GET', '/api/v0/auth/google/callback', 200, None, {})
      and not public_route_ok('GET', '/api/v0/auth/google/callback', 302, None, {'Location': '/login?next=%2F&google=state_invalid', 'Set-Cookie': 'pulse_session=x'})
      and not public_route_ok('GET', '/api/v0/auth/google/callback', 302, None, {'Location': '/', 'Set-Cookie': OIDC_CLEAR, 'X-Pulse-Session-Token': 'x'})
      and public_route_ok('GET', '/api/v1/openapi.json', 200, V1_REFERENCE, {'Content-Type': 'application/json'})
      and not public_route_ok('GET', '/api/v1/openapi.json', 200, {**V1_REFERENCE, 'people': [{'name': 'x'}]})
      and not public_route_ok('GET', '/api/v1/openapi.json', 401, V1_REFERENCE)
      and not public_route_ok('GET', '/api/v1/openapi.json', 200, V1_REFERENCE, {'Set-Cookie': 'pulse_session=x'})
      and not public_route_ok('GET', '/api/v0/me', 200, {}))

def call(path, role=None, body=None, headers=None):
    h = {'Origin': public, 'Host': public.split('//')[1], 'Cf-Connecting-Ip': test_ip}
    if role in sessions: h['Cookie'] = 'pulse_session=' + sessions[role]
    h.update(headers or {})
    if body is not None: h['Content-Type'] = 'application/json'
    req = Request(f'http://127.0.0.1:{port}' + path, data=json.dumps(body).encode() if body is not None else None, headers=h)
    try:
        # Do not follow Google's redirect or lose cookies from an intermediate response.
        with (google_opener if path.split('?', 1)[0] in GOOGLE_PATHS else opener).open(req, timeout=55) as r:
            raw = r.read(); status = r.status; response_headers = r.headers
    except HTTPError as e:
        raw = e.read(); status = e.code; response_headers = e.headers
    try: data = json.loads(raw)
    except (ValueError, UnicodeDecodeError): data = None
    return status, data, response_headers, raw

conn = psycopg.connect(url, autocommit=True, row_factory=dict_row)
org = conn.execute('select pulse.install_org() org').fetchone()['org']
if not org: raise AssertionError('Pulse install is not initialised')
configured_org = os.environ.get('PULSE_ORG_ID')
if configured_org and configured_org.lower() != str(org).lower():
    raise AssertionError('PULSE_ORG_ID does not match pulse.install.org_id')
org = str(org)
created = False
browser_input = None

def purge(table, where, params, depth=0):
    """Deletes the rows of `table` matching `where`, first (recursively) every row that refers to them; cascades are
    the database's, set-null references are cleared (tools/tasks-p0-seed.mjs's purge). Pulse never deletes a task, so
    the review check's task and its notifications leave staging this way (PROMOTE-4B)."""
    if depth > 10: raise AssertionError('purge too deep at '+table)
    schema, name = table.split('.')
    refs = conn.execute("""select cl.relnamespace::regnamespace::text sch,cl.relname tbl,a.attname col,fa.attname fcol,c.confdeltype del
        from pg_constraint c join pg_class cl on cl.oid=c.conrelid join pg_class fc on fc.oid=c.confrelid
        join lateral unnest(c.conkey,c.confkey) k(attnum,fattnum) on true join pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.attnum
        join pg_attribute fa on fa.attrelid=c.confrelid and fa.attnum=k.fattnum
        where c.contype='f' and fc.relname=%s and fc.relnamespace::regnamespace::text=%s and array_length(c.conkey,1)=1""", (name, schema)).fetchall()
    for r in refs:
        if r['del'] == 'c': continue
        child = r['sch']+'.'+r['tbl']
        sub = '"'+r['col']+'" in (select "'+r['fcol']+'" from '+table+' where '+where+')'
        if not conn.execute('select 1 from '+child+' where '+sub+' limit 1', params).fetchone(): continue
        if r['del'] == 'n' or child == table: conn.execute('update '+child+' set "'+r['col']+'"=null where '+sub, params)
        else: purge(child, sub, params, depth+1)
    return conn.execute('delete from '+table+' where '+where, params).rowcount

def cleanup(ids):
    with conn.transaction():
        # PROMOTE-4B: the tasks they made (the review check's) and every notification they received or that is about them.
        tasks = [row['id'] for row in conn.execute('select id from pulse.task where created_by=any(%s::uuid[])', (ids,)).fetchall()]
        purge('pulse.notification', "person_id=any(%s::uuid[]) or (subject_type='task' and subject_id=any(%s::uuid[]))", (ids, tasks))
        if tasks: purge('pulse.task', 'id=any(%s::uuid[])', (tasks,))
        for table in ['auth_link','auth_challenge','auth_account','auth_seen_device','auth_event']:
            conn.execute('delete from pulse_priv.'+table+' where realm=\'staff\' and actor=any(%s::uuid[])',(ids,))
        for pid in ids:
            conn.execute("select set_config('pulse.viewer_id',%s,true)",(pid,))
            for table in ['insight_decision','role_brief','brief_preference','insight_receipt']:
                conn.execute('delete from pulse.'+table+' where viewer_id=%s',(pid,))
        conn.execute('update pulse_priv.staff_invitation set prepared_by=null where prepared_by=any(%s::uuid[])',(ids,))
        conn.execute("delete from pulse.record_change where org_id=pulse.current_org() and entity_type='person' and entity_id=any(%s::uuid[]) and changed_by=any(%s::uuid[])", (ids,ids))
        # 0144–0152 (UX-TASKS, CHATS-2, PRESENCE-ONBOARD): rows the validation people create by opening pages (chat
        # receipts, presence and a status with its do-not-disturb, onboarding state, attendance events); events before entries.
        for table,column in [('pulse.attendance_event','person_id'),('pulse.chat_receipt','person_id'),('pulse.person_status','person_id'),('pulse.companion_notification_settings','person_id'),('pulse.chat_task_follow','created_by'),
                             ('pulse.work_comment','author_id'),('pulse.work_ask','from_id'),('pulse.work_ask','to_id'),('pulse.task_member','person_id'),('pulse.project_member','person_id'),
                             # 0153 (UX-TASKS-2): domains proposed for or by them, and credit for work accepted from them.
                             ('pulse.work_credit','person_id'),('pulse.work_domain','person_id'),('pulse.work_domain','proposed_by'),
                             ('pulse_priv.identity_document','added_by'),('pulse_priv.identity_document','person_id'),('pulse_priv.profile_proposal','person_id'),('pulse_priv.person_onboarding','person_id'),
                             # The desktop smoke's one-day working pattern (tools/desktop-staging-smoke.py).
                             ('pulse.hr_work_pattern','person_id'),('pulse.hr_work_pattern','changed_by'),
                             # TASKS-3 (0185): reporting lines Pulse proposed for or to them.
                             ('pulse.org_line_proposal','person_id'),('pulse.org_line_proposal','manager_id'),
                             # PEOPLE-CONTACTS (0211): name or birth-date requests they made.
                             ('pulse.profile_change','person_id')]:
            conn.execute('delete from '+table+' where '+column+'=any(%s::uuid[])',(ids,))
        for table in ['companion_presence','attendance_break','attendance_entry','native_event']:
            conn.execute('delete from pulse.'+table+' where person_id=any(%s::uuid[])',(ids,))
        for table in ['native_token','native_pair']:
            conn.execute('delete from pulse_priv.'+table+' where person_id=any(%s::uuid[])',(ids,))
        conn.execute('delete from pulse.native_permission where person_id=any(%s::uuid[])',(ids,))
        conn.execute('delete from pulse.native_device where person_id=any(%s::uuid[])',(ids,))
        # LIFECYCLE: a role or pod change on a validation person is a dated event; cases and steps go with them.
        conn.execute('delete from pulse.lifecycle_step where case_id in (select id from pulse.lifecycle_case where person_id=any(%s::uuid[]))',(ids,))
        for table in ['lifecycle_case','person_lifecycle_event','person_lifecycle','lifecycle_review','lifecycle_signal','chat_former_member','seat_holding']:
            conn.execute('delete from pulse.'+table+' where person_id=any(%s::uuid[])',(ids,))
        conn.execute('delete from pulse.kudos where from_person=any(%s::uuid[]) or to_person=any(%s::uuid[])',(ids,ids))
        for table,column in [('pulse_priv.staff_invitation','person_id'),('pulse.login_session','person_id'),('pulse.login_credential','person_id'),('pulse.chat_member','person_id'),('pulse.money_permission','person_id'),('pulse.role_assignment','person_id'),('pulse.people_profile','person_id')]:
            conn.execute('delete from '+table+' where '+column+'=any(%s::uuid[])',(ids,))
        # Last, after every delete above (some match on optional columns such as native_pair.person_id): optional
        # references to them (created_by, updated_by…) are cleared, never deleted, so a new column cannot block this.
        for row in conn.execute("""select c.conrelid::regclass::text t,a.attname c from pg_constraint c join pg_attribute a on a.attrelid=c.conrelid and a.attnum=c.conkey[1]
            where c.contype='f' and c.confrelid='pulse.person'::regclass and cardinality(c.conkey)=1 and not a.attnotnull and c.confdeltype in ('a','r')""").fetchall():
            conn.execute(sql.SQL('update {} set {}=null where {}=any(%s::uuid[])').format(sql.SQL(row['t']),sql.Identifier(row['c']),sql.Identifier(row['c'])),(ids,))
        conn.execute('delete from pulse.person where id=any(%s::uuid[])',(ids,))

try:
    owner = conn.execute('select pg_get_userbyid(datdba) owner from pg_database where datname=current_database()').fetchone()['owner']
    # Staging fixture creation uses the root broker to obtain a narrow owner connection (stored 0600).
    conn.execute('set role ' + owner)
    conn.execute("select set_config('pulse.org_id',%s,false)", (org,))
    stale=conn.execute(r"select pp.person_id from pulse.people_profile pp join pulse.person p on p.id=pp.person_id where pp.evidence='Release verification; delete after validation' and pp.username ~ '^release\.[0-9a-f]{8}\.(person|manager|pgs|hr|leadership|admin)$' and p.display_name='Release validation '||pp.role").fetchall()
    if stale:cleanup([str(row['person_id']) for row in stale])
    pod = conn.execute("select id from pulse.unit where kind='pod' and valid_to is null order by name limit 1").fetchone()['id']
    with conn.transaction():
        for role, pid in people.items():
            conn.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,%s,'staff')", (pid,org,'Release validation '+role))
            conn.execute("insert into pulse.people_profile(org_id,person_id,role,pod,username,evidence,accounts) values(%s,%s,%s,'Pod 1',%s,'Release verification; delete after validation','{}')", (org,pid,role,prefix+'.'+role))
            if role != 'person':
                conn.execute("insert into pulse.role_assignment(org_id,person_id,role_key,unit_id,valid_from) values(%s,%s,%s,%s,'2020-01-01')", (org,pid,role,pod if role in ('manager','pgs') else None))
            conn.execute("insert into pulse.login_credential(org_id,person_id,password_hash,must_change,status) values(%s,%s,crypt(%s,gen_salt('bf',10)),false,'active')", (org,pid,password))
    created = True
    real_person = conn.execute("select person_id from pulse_priv.hr_compensation limit 1").fetchone()['person_id']
    for role in roles:
        status, data, h, _ = call('/api/v0/auth/sign-in', body={'username':prefix+'.'+role,'password':password})
        check(role+' password sign-in', status == 200)
        cookie = h.get('Set-Cookie', h.get('set-cookie', ''))
        check(role+' secure cookie', all(x in cookie for x in ('HttpOnly','Secure','SameSite=Lax','Max-Age=43200')))
        sessions[role] = cookie.split('pulse_session=',1)[1].split(';',1)[0]
        status, data, _, _ = call('/api/v0/me',role)
        check(role+' identity from session', status == 200 and data['role'] == role and data['via'] == 'password')
        # The company's switched-off modules (and those the server has not switched on: RELEASE-5's lane C rounds).
        if status == 200: modules_off.update((data.get('modules') or {}).get('off') or [])
        expected_money = 200 if role == 'leadership' else 403
        expected_salary = 200 if role in ('hr','leadership') else 403
        status, _, _, _ = call('/api/v0/money',role)
        check(role+' Money role/grants',status == expected_money)
        status, data, _, _ = call('/api/v0/people/'+str(real_person)+'/hr',role)
        check(role+' restricted HR salary/contact',status == expected_salary)
        status, data, _, _ = call('/api/v0/chats',role)
        check(role+' member-scoped Chats',status == 200)
        report['roles'][role] = 'passed'
    # R17 uses only the train's disposable synthetic identities and reserved test-sink addresses.
    target=people['person'];target_path='/api/v0/people/'+target+'/login'
    sink_work=prefix+'.work@example.test';sink_delivery=prefix+'.delivery@example.test'
    check('account drawer missing delivery state',call('/api/v0/admin/auth-history/'+target,'admin')[1]['delivery'] is None)
    check('account email ordinary staff edit denied',call(target_path,'person',{'action':'email-work-save','email':sink_work})[0]==403)
    check('account email HR cannot edit admin',call('/api/v0/people/'+people['admin']+'/login','hr',{'action':'email-work-save','email':sink_work})[0]==403)
    check('account email invalid address rejected',call(target_path,'admin',{'action':'email-work-save','email':'invalid'})[0]==400)
    check('account work email saved by HR',call(target_path,'hr',{'action':'email-work-save','email':sink_work})[0]==200)
    check('account duplicate email rejected',call('/api/v0/people/'+people['hr']+'/login','admin',{'action':'email-work-save','email':sink_work.upper()})[0]==400)
    links_before=conn.execute("select count(*) n from pulse_priv.auth_link where org_id=%s and realm='staff' and actor=%s",(org,target)).fetchone()['n']
    check('account delivery draft saved',call(target_path,'admin',{'action':'email-delivery-save','email':sink_delivery})[0]==200)
    state=call('/api/v0/admin/auth-history/'+target,'admin')[1]
    check('account draft preserves current delivery',state['draftDelivery']==sink_delivery and state['delivery']==sink_work and state['verifiedDelivery'] is None)
    check('account save creates no mail or invitation link',conn.execute("select count(*) n from pulse_priv.auth_link where org_id=%s and realm='staff' and actor=%s",(org,target)).fetchone()['n']==links_before)
    # Live staging must reject delivery to the reserved sink; CI separately tests successful sink transport.
    check('account staging mail gate reports retry error',call(target_path,'admin',{'action':'email-delivery-verify'})[0]==503)
    check('account failed delivery keeps draft',call('/api/v0/admin/auth-history/'+target,'admin')[1]['draftDelivery']==sink_delivery)
    # Supply a synthetic capability through the existing owner test connection, without delivering an email.
    conn.execute("select set_config('pulse.viewer_id',%s,false)",(people['admin'],))
    email_token=secrets.token_urlsafe(32)
    conn.execute("select pulse.auth_admin_email(%s,'email-delivery-verify',%s)",(target,json.dumps({'hash':hashlib.sha256(email_token.encode()).hexdigest()})))
    check('account existing email confirmation redeems synthetic capability',call('/api/v0/auth/confirm-email',body={'token':email_token})[0]==200)
    check('account confirmed delivery state',call('/api/v0/admin/auth-history/'+target,'admin')[1]['verifiedDelivery']==sink_delivery)
    check('account email confirmation is single-use',call('/api/v0/auth/confirm-email',body={'token':email_token})[0]==400)
    report['account_access']={'syntheticOnly':True,'emailsSent':0,'saveNeverInvites':True,'stagingTransport':'reserved sink rejected; 503 retry verified','confirmation':'synthetic capability via owner fixture; existing endpoint','successfulSinkTransport':'disposable CI receipt'}
    # Forged headers cannot override a staff session or provide an anonymous identity.
    for headers in [{'Cf-Access-Authenticated-User-Email':'admin@estateautopilots.com'}, {'Cf-Access-Jwt-Assertion':'forged','X-Dev-User':'admin','X-Pulse-Session':sessions['admin']}]:
        check('anonymous forged identity denied',call('/api/v0/me',headers=headers)[0] == 401)
        status, data, _, _ = call('/api/v0/me','person',headers=headers)
        check('forged identity cannot upgrade staff',status == 200 and data['role'] == 'person')
    # The synthetic release person follows the organisation gate. Keep attendance reads
    # conditional while running notification-outbox checks for both gate states.
    status, companion, _, _ = call('/api/v0/companion','person')
    check('companion reports attendance gate',status == 200 and isinstance(companion.get('attendanceEnabled'), bool))
    if not companion['attendanceEnabled']:
        status, team_stats, _, _ = call('/api/v0/hr/attendance','hr')
        check('attendance-off HR month is empty',status == 200 and team_stats.get('attendanceEnabled') is False and team_stats.get('people') == [])
        report['attendance_gate']={'passed':True,'attendanceEnabled':False,'hrPeople':0}
    else:
        # R18 is a read-only statistical view. Live staging uses the train's synthetic sessions;
        # regression punches live exclusively in disposable CI databases.
        status, own_stats, _, _ = call('/api/v0/hr/self','person')
        check('attendance synthetic self summary available',status == 200)
        reconciliation = own_stats['reconciliation']
        check('R19 closure gate remains off',reconciliation['automaticClosureEnabled'] is False and reconciliation['dryRun'] is True and reconciliation['policy']['mode']=='suggestion')
        check('R19 minimum ten comparable days',reconciliation['baseline']['minimumDays']>=10 and reconciliation['baseline']['sampleDays']==0 and reconciliation['baseline']['source']!='accepted_comparable_shifts')
        check('R19 historical monthly reports remain separate',reconciliation['historicalMonthly']['dailyPunchesDerived'] is False and not reconciliation['historicalMonthly']['rows'])
        report['attendance_reconciliation']={'passed':True,'syntheticSelfOnly':True,'attendanceWrites':0,'automaticClosureEnabled':False,'policyMode':'suggestion','E06':'OPEN','historicalMonthlySeparate':True}
        summary = own_stats['month']['summary']
        check('attendance empty is unknown',summary['averageMinutes'] is None and summary['coverage'] is None and summary['eligibleDays'] == 0)
        check('attendance provisional gate labelled',summary['filter']['provisional'] and summary['filter']['version']=='provisional-v1')
        status, team_stats, _, _ = call('/api/v0/hr/attendance','hr')
        check('attendance HR summary available',status == 200)
        for person_stats in team_stats['people']:
            accepted = [d['attendance'] for d in person_stats['days'] if d.get('attendance') and d['attendance']['eligible']]
            total = sum(d['minutes'] for d in accepted)
            stat = person_stats['summary']
            check('attendance matching accepted rows and denominator',stat['eligibleDays']==len(accepted) and stat['workedMinutes']==total)
            check('attendance average bounded or unknown',stat['averageMinutes'] is None if not accepted else 0<=stat['averageMinutes']<=720)
        check('attendance person cannot read HR dashboard',call('/api/v0/hr/desk','person')[0]==403)
        status, dashboard_stats, _, _ = call('/api/v0/hr/desk','hr')
        check('attendance dashboard uses same filter',status==200 and dashboard_stats['attendance']['filter']==summary['filter'])
        report['attendance_statistics']={'passed':True,'syntheticSelfOnly':True,'businessReadsMasked':True,'regressionPunches':'disposable CI only','originalPunchesUnmodified':True,'provisionalThresholdGate':'E06 OPEN','payrollUnchanged':True}
    # R27 staging uses the train's existing synthetic session. Reads and denied controls only;
    # mutation/retry/provider acceptance is separately exercised in disposable CI with sinks.
    status, preferences, _, _ = call('/api/v0/companion/notification-settings','person')
    check('R27 self channel preferences readable',status==200 and set(['local','web','native','telegram','email'])<=set(preferences['settings']['channels']))
    check('R27 done reminder is optional',status==200 and preferences['settings']['reminders']['done'] is False)
    check('R27 invalid global snooze rejected without write',call('/api/v0/companion/notification-settings','person',{'snoozedUntil':'2099-01-01T00:00:00Z'})[0]==400)
    status, inbox, _, _ = call('/api/v0/companion/inbox','person')
    check('R27 self inbox readable',status==200 and isinstance(inbox['rows'],list))
    check('R27 unknown event cannot be snoozed',call('/api/v0/companion/snooze','person',{'id':'00000000-0000-0000-0000-000000000000','minutes':60})[0]==403)
    check('R27 payroll processed activation remains closed',call('/api/v0/notifications/payroll-processed','person',{'personId':people['person'],'month':'2026-10-01','sourceKey':'synthetic-release','confirmation':'accounts_processed'})[0]==503)
    report['notification_outbox']={'passed':True,'syntheticSelfOnly':True,'preferenceWrites':0,'attendanceWrites':0,'payrollWrites':0,'emailsSent':0,'providerCalls':0,'attendanceActivation':'E06 OPEN','payrollActivation':'OPEN','contractVersion':1}
    # Check every registered route anonymously, including lane v1 APIs at the origin. Role expectations are read for
    # GET routes only, the ones checked per role below; CI's access matrix classifies every mutation.
    route_proc = subprocess.run(['node','--input-type=module','-e',"import {createApp} from './services/api/dist/app.js';import {moduleForRoute} from './services/api/dist/modules.js';import {denied} from './services/api/test/role-expectations.mjs';const rs=[];const pool={connect:async()=>{throw Error('must not query')}};const app=createApp({query:async()=>{}},pool,r=>rs.push({method:r.method,url:r.url}));await app.ready();console.log(JSON.stringify(rs.map(r=>({...r,module:moduleForRoute(r.url),denied:Object.fromEntries(['person','manager','pgs','hr','leadership','admin'].map(role=>[role,r.url==='/healthz'||(Array.isArray(r.method)?r.method[0]:r.method)!=='GET'?false:denied(role,'GET',r.url)]))}))));await app.close();"],cwd=source,capture_output=True,text=True,check=True)
    routes = json.loads(next(line for line in reversed(route_proc.stdout.splitlines()) if line.startswith('[')))
    real_project=str(conn.execute('select id from pulse.project limit 1').fetchone()['id'])
    for route in routes:
        if route['url']=='/healthz' or any(route['url']==prefix+name for prefix in ('/api/v0/auth/','/api/v0/portal/auth/') for name in ('sign-in','forgot','forgot-username','set-password','two-step','confirm-email')):continue
        methods = route['method'] if isinstance(route['method'],list) else [route['method']]
        for method in methods:
            if method=='HEAD':continue
            # Catalogue reads require a service key; public offers require a valid token.
            # Neither a staff cookie nor a module switch changes those credential realms.
            catalogue=catalogue_credential_probe(method,route['url'])
            if catalogue is not None:
                probe_path, expected=catalogue
                for role in (None,*roles):
                    status=call(probe_path,role)[0]
                    check((role or 'anonymous')+' '+method+' '+probe_path+' HTTP '+str(status),status==expected)
                continue
            path=route['url'].replace(':id',str(real_person)).replace(':account','unknown@example.test').replace(':entity','project').replace(':flag',str(uuid.uuid4())).replace(':file','missing')
            if route['url'] == '/api/v0/auth/google/start': path += '?mode=signin'
            # An unconfigured signed provider webhook stays disabled (404); it never takes a session (EST-325).
            # R44's Drive channel hook answers 404 while off and for any channel/token pair that is not live.
            signed='/acquisition/webhook/' in path or '/chats/whatsapp-webhook/' in path or path=='/api/v0/drive-changes/hook'
            # A switched-off module's routes answer as a missing route does (modules.ts): signed out the address's Access
            # gate answers first (401, as for any unknown /api/ path), signed in every role gets 404.
            if route.get('module') in modules_off:
                status=call(path,body={} if method=='POST' else None)[0]
                check('anonymous '+method+' '+route['url']+' HTTP '+str(status)+' (module '+route['module']+' off)',status in (401,404))
                if method=='GET':
                    for role in roles: check(role+' GET '+route['url']+' HTTP 404 (module '+route['module']+' off)',call(path,role)[0]==404)
                continue
            if (method, route['url']) in PUBLIC_ROUTES:
                status, data, headers, raw = call(path, body={} if method=='POST' else None)
                check('anonymous '+method+' '+route['url']+' HTTP '+str(status),public_route_ok(method,route['url'],status,data,headers,raw))
            else:
                expected={401,404} if signed else {401} if path.startswith('/api/') else {404}
                status=call(path,body={} if method=='POST' else None)[0]
                check('anonymous '+method+' '+route['url']+' HTTP '+str(status),status in expected)
            if method=='GET' and route['url'].startswith('/api/') and route['url']!='/api/v0/chats/events':
                for role in roles:
                    read_path=path.replace(str(real_person),real_project) if '/projects/' in path else path
                    status, data, _, _=call(read_path,role)
                    deny=route['denied'][role]
                    # Client portal routes accept only a client session: a staff session is anonymous there.
                    if (route['url']=='/api/v0/portal' or route['url'].startswith('/api/v0/portal/')):check(role+' GET '+route['url'],status==401);continue
                    elsewhere=sealed_elsewhere(envname,status,data)
                    check(role+' GET '+route['url']+' HTTP '+str(status)+(' (sealed with another environment key)' if elsewhere else ''),
                          status==403 if deny else (status<500 or elsewhere) and status not in (401,))
    report['modules_off'] = sorted(modules_off)
    if envname == 'staging':
        # EST-414: aggregate design delivery and modifier coverage counts only.
        status, design, _, _ = call('/api/v0/design-deliveries/summary','admin')
        attribution = design.get('attribution') if isinstance(design,dict) else None
        check('staging Designers aggregate API', status == 200 and isinstance(design,dict)
              and isinstance(design.get('types'),dict) and isinstance(attribution,dict)
              and isinstance(attribution.get('by_method'),dict))
        export = r"(lower(f.mime) like 'image/%%' or lower(f.mime)='application/pdf' or lower(f.name) ~ '\.(ai|bmp|gif|jpe?g|pdf|png|psd|svg|tiff?|webp)$')"
        modifier_rows = dict(conn.execute(r"""select
          count(*) filter(where a.purpose='Workspace account' and not a.is_shared
            and a.holder_person_id is not null and p.side='staff' and p.status='active')::int verified_staff,
          count(*) filter(where a.purpose='Workspace shared login' and a.is_shared
            and a.holder_person_id is null and a.is_company_owned)::int verified_internal_shared,
          count(*) filter(where not coalesce((a.purpose='Workspace account' and not a.is_shared
            and a.holder_person_id is not null and p.side='staff' and p.status='active'),false)
            and not coalesce((a.purpose='Workspace shared login' and a.is_shared
            and a.holder_person_id is null and a.is_company_owned),false))::int unknown_or_unmapped
          from pulse.index_file f
          left join pulse.account a on a.org_id=f.org_id and a.provider='google'
            and lower(a.handle)=lower(f.uploader_account)
          left join pulse.person p on p.org_id=a.org_id and p.id=a.holder_person_id
          where f.org_id=%(o)s and f.account_basis='last modifying account'
            and coalesce(f.modified_at,f.created_at)>=now()-interval '30 days'
            and coalesce(f.modified_at,f.created_at)<now() and """+export, {'o': org}).fetchone())
        report['designers'] = {
            'modifier_rows': modifier_rows,
            'design_total': int(design['total']),
            'types': {key: int(value) for key, value in design['types'].items()},
            'credit_status': {key: int(attribution[key]) for key in
                              ('credited_to_person','shared_login','unresolved')},
            'method_counts': {key: int(value) for key, value in attribution['by_method'].items()},
        }
        editor_week = '2026-W40'
        status, editor_list, _, _ = call('/api/v0/editors?week='+editor_week,'admin')
        check('staging Editors weekly list API', status == 200 and isinstance(editor_list,dict)
              and isinstance(editor_list.get('accounts'),list)
              and editor_list.get('period',{}).get('week') == editor_week)

        def load_editor_week(person_id):
            try:
                status, weekly, _, _ = call('/api/v1/editors/'+person_id+'/week?week='+editor_week,'admin')
            except Exception:
                check('staging Editors weekly detail API', False)
                return {}
            check('staging Editors weekly detail API', status == 200 and isinstance(weekly,dict))
            return weekly if isinstance(weekly,dict) else {}

        eligible=[row for row in editor_list['accounts'] if row.get('identityVerified') is True and row.get('sharedLogin') is False and row.get('holder_person_id')]
        report['editors_week'] = aggregate_editor_week(editor_list['accounts'],editor_week,load_editor_week) if eligible else {'week':editor_week,'accounts':len(editor_list['accounts']),'rows_compared':0,'rows_matched':0,'status':'not_applicable','reason':'No verified non-shared uploader accounts in staging; personal target comparison is unavailable'}
    for path in ('/api/v0/auth/sign-in','/api/v0/auth/forgot','/api/v0/auth/set-password','/api/v0/auth/sign-out','/api/v0/people/'+str(real_person)+'/photo'):
        check('foreign-origin CSRF '+path,call(path,'admin',{}, {'Origin':'https://wrong.example'})[0]==403)
        check('missing-origin CSRF '+path,call(path,'admin',{}, {'Origin':''})[0]==403)
    # Five incorrect credentials lock the account even when requests use new IP labels.
    for _ in range(5):check('generic failed sign-in',call('/api/v0/auth/sign-in',body={'username':prefix+'.person','password':'wrong'})[0]==401)
    check('credential lockout',call('/api/v0/auth/sign-in',body={'username':prefix+'.person','password':password})[0]==401)
    conn.execute('update pulse.login_credential set locked_until=null,failed_attempts=0 where person_id=%s',(people['person'],))
    # Persistent rate limits on sign-in, queue reset and link redemption; keys are hashes.
    for action,bucket,limit in [('sign-in','staff-login',30),('forgot','staff-recovery',10),('set-password','staff-redeem',10)]:
        key=hashlib.sha256((bucket+':'+test_ip).encode()).hexdigest()
        conn.execute("insert into pulse.auth_rate(org_id,key_hash,window_start,attempts) values(%s,%s,now(),%s) on conflict(org_id,key_hash) do update set attempts=excluded.attempts,window_start=now()",(org,key,limit))
        status, _, _, _ = call('/api/v0/auth/'+action,body={'username':'unknown','password':'wrong','token':'invalid'})
        check(action+' IP rate limit',status==(200 if action=='forgot' else 429))
        conn.execute('delete from pulse.auth_rate where org_id=%s and key_hash=%s',(org,key))
    # Twelve-hour expiry and explicit revocation are tested on the actual deployed DB.
    token=sessions['manager'];digest=hashlib.sha256(token.encode()).hexdigest()
    conn.execute("update pulse.login_session set expires_at=now()-interval '1 second' where token_hash=%s",(digest,))
    check('session expiry',call('/api/v0/me','manager')[0]==401)
    check('sign-out',call('/api/v0/auth/sign-out','pgs',{})[0]==200)
    check('session revocation',call('/api/v0/me','pgs')[0]==401)
    # Prepared setup links work through the deployed public endpoint, once, with expiry and revocation.
    conn.execute("select set_config('pulse.viewer_id',%s,false)",(people['admin'],))
    setup_batch=str(uuid.uuid4());setup_token=secrets.token_urlsafe(32)
    conn.execute("insert into pulse_priv.staff_invitation(org_id,person_id,batch_id,recipient,username,status,prepared_by) values(%s,%s,%s,'synthetic@example.test',%s,'prepared',%s)",(org,people['manager'],setup_batch,prefix+'.manager',people['admin']))
    conn.execute('select pulse.invitation_link(%s,%s,%s)',(people['manager'],setup_batch,hashlib.sha256(setup_token.encode()).hexdigest()))
    status, data, h, _=call('/api/v0/auth/set-password',body={'token':setup_token,'password':password})
    check('private setup link creates a session',status==200 and data['mustChange'] is False)
    sessions['manager']=h.get('Set-Cookie',h.get('set-cookie')).split('pulse_session=',1)[1].split(';',1)[0]
    check('setup link is single-use',call('/api/v0/auth/set-password',body={'token':setup_token,'password':password})[0]==400)
    expired_token=secrets.token_urlsafe(32)
    conn.execute("update pulse_priv.staff_invitation set status='prepared',token_hash=%s,expires_at=now()-interval '1 second',used_at=null where person_id=%s",(hashlib.sha256(expired_token.encode()).hexdigest(),people['manager']))
    check('setup link expiry',call('/api/v0/auth/set-password',body={'token':expired_token,'password':password})[0]==400)
    # API sessions expire/revoke even if the browser retains its cookie.
    # Dev-uploaded profile photos must be byte-for-byte identical to the DB snapshot copied to prod.
    photo=conn.execute("select person_id,mime,bytes from pulse.person_photo order by updated_at desc limit 1").fetchone()
    if photo:
        status, _, _, raw = call('/photo/'+str(photo['person_id']),'admin')
        check('dev photo served on '+envname,status==200 and hashlib.sha256(raw).digest()==hashlib.sha256(bytes(photo['bytes'])).digest())
        report['photo']={'verified':True,'sha256':hashlib.sha256(raw).hexdigest()}
    else:check('dev photo exists',False)
    stream_request=Request(f'http://127.0.0.1:{port}/api/v0/chats/events',headers={'Host':public.split('//')[1],'Origin':public,'Cookie':'pulse_session='+sessions['admin']})
    with opener.open(stream_request,timeout=15) as stream:
        check('live production-origin chat event stream',stream.status==200 and 'text/event-stream' in stream.headers.get('Content-Type','') and any(b'event: changed' in stream.readline() for _ in range(3)))
    # Allow metadata for a Money screenshot, without amounts. The matrix above proved admin without grants denied.
    conn.execute("insert into pulse.money_permission(org_id,person_id,permission) values(%s,%s,'money.read')",(org,people['admin']))
    # PROMOTE-4B: finished work waiting for the synthetic admin's review, so the browser walk opens the bell and "All
    # notifications" with a task.done card. Given to the synthetic person, reviewed by the admin only (set and checked
    # before anyone is told it is done); cleanup() removes the task and its notifications with the people.
    review = None
    if envname == 'staging':
        title = 'Release validation review '+prefix
        status, made, _, _ = call('/api/v0/work/tasks','admin',{'title':title,'assigneeId':people['person']})
        check('review task created', status == 200 and bool(made.get('id')))
        task_id = made['id']
        if made.get('asked'):
            check('review task taken by the synthetic person', call('/api/v0/work/asks/'+made['asked']['id']+'/accept','person',{})[0] == 200)
        check('review task reviewed by the synthetic admin', call('/api/v0/tasks/'+task_id,'admin',{'reviewerId':people['admin']})[0] == 200)
        status, detail, _, _ = call('/api/v0/tasks/'+task_id,'admin')
        check('review task belongs to synthetic people only', status == 200 and detail['task']['assigneeId'] == people['person'] and detail['task']['reviewerId'] == people['admin'])
        check('synthetic person finishes the review task', call('/api/v0/tasks/'+task_id+'/move','person',{'status':'done'})[0] == 200)
        status, notices, _, _ = call('/api/v0/work/notices?limit=30','admin')
        card = next((n for n in (notices or {}).get('rows', []) if n.get('eventType') == 'task.done' and (n.get('subject') or {}).get('id') == task_id), None)
        fields = [f for a in (card or {}).get('actions', []) for f in a.get('fields') or []]
        check('review card offers one quality rating, no effort or impact', card is not None and card['state'] == 'open' and [f['type'] for f in fields] == ['choice','flag']
              and fields[0]['key'] == 'quality' and not any(f['key'] in ('effort','impact') for f in fields))
        review = {'taskId':task_id,'title':title}
    # RELEASE-5 (UX-5B): a save in Office presence lights up the task companion on this build's database. Through the API
    # the synthetic HR person gives themself the owner's task and confirms its signal (Office Wi-Fi and IP saved); then,
    # in one transaction that is always rolled back, a synthetic office with Wi-Fi and an IP is saved as HR, and the
    # companion's attention for HR must name the task. Nothing of the office, the event or the hit remains; cleanup()
    # removes the task with the people.
    if envname == 'staging':
        title = 'Add the office Wi-Fi and IP in Office presence (release validation '+prefix+')'
        status, made, _, _ = call('/api/v0/work/tasks','hr',{'title':title,'assigneeId':people['hr']})
        check('companion task created', status == 200 and bool(made.get('id')))
        companion_task = made['id']
        status, state, _, _ = call('/api/v0/tasks/'+companion_task+'/companion','hr',{'signals':[{'event':'office.network.saved','label':'Office Wi-Fi and IP saved','need':1,'where':{'ip_count':{'gte':1}}}],'autoDone':False})
        check('companion signal confirmed (ask first)', status == 200 and [g['event'] for g in state['signals']] == ['office.network.saved'] and state['signals'][0]['metAt'] is None and state['autoDone'] is False)
        lit = None
        try:
            with conn.transaction():
                conn.execute("select set_config('pulse.org_id',%s,true),set_config('pulse.viewer_id',%s,true)", (org, people['hr']))
                conn.execute("""insert into pulse.presence_office(org_id,name,lat,lng,radius_m,wifi,active,updated_by,public_ip_ranges)
                  values(%s,'Release validation office (synthetic)',12.9716,77.5946,150,'[{"ssid":"Release-Validation"}]'::jsonb,true,%s,'{203.0.113.10/32}'::cidr[])""", (org, people['hr']))
                lit = conn.execute('select pulse.task_companion_attention() d').fetchone()['d']
                raise psycopg.Rollback()
        except psycopg.Rollback:
            pass
        hit = next((h for h in (lit or {}).get('hits', []) if h.get('task') == companion_task), None)
        check('saving Office presence lights the companion', hit is not None and hit['event'] == 'office.network.saved' and hit['mine'] is True and hit['met'] is True)
        status, after, _, _ = call('/api/v0/work/companion','hr')
        with conn.transaction():
            conn.execute("select set_config('pulse.org_id',%s,true)", (org,))
            left = conn.execute("select count(*) n from pulse.presence_office where org_id=%s and name='Release validation office (synthetic)'", (org,)).fetchone()['n']
        check('the companion check left nothing behind', status == 200 and not any(h.get('task') == companion_task for h in after.get('hits', [])) and left == 0)
        report['companion']={'syntheticOnly':True,'rolledBack':True,'event':hit and hit['event'],'lit':hit is not None}
    report['billing'] = {}
    billing_exports(conn, call, check, org, people['leadership'], report['billing'], context={
        'environment': envname, 'origin': public, 'port': port, 'source': str(source), 'out': str(out),
        'session': sessions['leadership']})
    if envname == 'staging':
        # EST-1964: on request only, an issued synthetic quotation through the browser (tools/release_billing_acceptance.py).
        report['billing_acceptance'] = billing_acceptance(conn, call, check, {'org': org, 'prefix': prefix, 'password': password,
            'personSession': sessions['person'], 'origin': public, 'port': port, 'out': str(out), 'source': str(source),
            'environment': envname, 'cleanup': cleanup})
    with browser_runtime(out, {'public':public,'port':port,'sessions':sessions,'people':people,'out':str(out),'environment':envname,'username':prefix+'.person','password':password,'review':review}) as (browser_input, browser_env):
        # 540 s: RELEASE-2 added Pip's island, 50 rounds at 1440 and 50 taps at 390 (about 1.5 minutes); 720 s since
        # PROMOTE-4B's review pass (the bell and /notifications at each width and theme, about a minute more).
        result=subprocess.run(['node','tools/release-browser.mjs',str(browser_input)],cwd=source,capture_output=True,text=True,timeout=720,env=browser_env)
    if result.returncode != 0:
        diagnostic=out/(envname+'-browser-diagnostic.private.log')
        safe=result.stderr[-8000:]
        for secret in [password,*sessions.values(),setup_token,expired_token]:safe=safe.replace(secret,'[credential omitted]')
        diagnostic.write_text(safe);diagnostic.chmod(0o600)
    check('production browser validation',result.returncode==0)
    report['browser']=json.loads((out/(envname+'-browser.json')).read_text())
    if review:
        # The browser accepted it from /notifications with the rating: rated, never effort × impact; nobody but the
        # synthetic people was told, and no notice left Pulse.
        status, detail, _, _ = call('/api/v0/tasks/'+review['taskId'],'admin')
        check('review accepted from /notifications with the rating', status == 200 and detail['task']['status'] == 'accepted' and detail['task']['reviewKind'] == 'rated')
        told = conn.execute("select count(*) filter(where not (person_id=any(%s::uuid[]))) others,count(*) n from pulse.notification where subject_type='task' and subject_id=%s", (list(people.values()), review['taskId'])).fetchone()
        check('review notices reached the synthetic people only', told['others'] == 0 and told['n'] >= 2)
        sent = conn.execute("select count(*) n from pulse.notification_delivery d join pulse.notification x on x.id=d.notification_id where x.subject_type='task' and x.subject_id=%s and d.accepted_at is not null", (review['taskId'],)).fetchone()['n']
        check('review notices sent nowhere outside Pulse', sent == 0)
        report['review']={'syntheticOnly':True,'bell':True,'notificationsPage':True,'effortImpact':False,'acceptedWith':'quality rating','notices':told['n'],'delivered':sent}
    # Every attempted sign-in is audited, including failure and throttling.
    audit=conn.execute("select count(*) n from pulse.audit_event where action in ('sign_in','sign_in_failed') and at>now()-interval '20 minutes'").fetchone()['n']
    check('sign-in audit',audit>=12)
    if envname=='production' and os.environ.get('PULSE_PREPARE_INITIAL_INVITATIONS')=='1':
        # Owner-authorized one-time preparation, never mail delivery. Private drafts are mode 0600.
        conn.execute("select set_config('pulse.viewer_id',%s,false)",(people['admin'],))
        conn.execute("insert into pulse.sensitive_permission(org_id,person_id,permission,granted_by) values(%s,%s,'hr.contact.read','Release invitation preparation')",(org,people['admin']))
        batch=conn.execute('select pulse.invitation_prepare() id').fetchone()['id']
        drafts=[]
        rows=conn.execute('select pulse.invitation_preview() rows').fetchone()['rows']
        for row in rows:
            if row['personId'] in people.values():continue
            link=None
            if row['status']=='prepared':
                token=secrets.token_urlsafe(32)
                conn.execute('select pulse.invitation_link(%s,%s,%s)',(row['personId'],row['batchId'],hashlib.sha256(token.encode()).hexdigest()))
                link=public+'/login/set-password#'+token
            drafts.append({'name':row['name'],'username':row['username'],'recipient':row['recipient'],'from':'hr@estateautopilots.com','subject':'Your Estate Autopilots Pulse account','link':link,'expiresInDays':7,'status':row['status'],'reason':row['reason']})
        private=out/'prepared-invitations.private.json';private.write_text(json.dumps(drafts,indent=2)+'\n');private.chmod(0o600)
        conn.execute('update pulse_priv.staff_invitation set prepared_by=null where prepared_by=%s',(people['admin'],))
        report['invitations']={'current_people':len(drafts),'ready':sum(row['status']=='prepared' for row in drafts),'blocked':sum(row['status']=='blocked' for row in drafts),'emails_sent':0,'private_drafts':str(private)}
    # R15: use the existing synthetic pgs fixture, after browser/statistics checks.
    # The earlier session-revocation assertion intentionally signed this fixture out.
    status, _, headers, _ = call('/api/v0/auth/sign-in', body={'username':prefix+'.pgs','password':password})
    check('desktop synthetic browser sign-in', status == 200)
    sessions['pgs'] = headers.get('Set-Cookie', headers.get('set-cookie', '')).split('pulse_session=',1)[1].split(';',1)[0]
    from importlib.util import spec_from_file_location, module_from_spec
    native_spec = spec_from_file_location('desktop_staging_smoke', source/'tools/desktop-staging-smoke.py')
    native_smoke = module_from_spec(native_spec); native_spec.loader.exec_module(native_smoke)
    report['desktop_native'] = native_smoke.verify(conn, call, check, people['pgs'])
    # R16: rejection-only checks on this existing synthetic session; no new punch or enrollment.
    attendance_enabled = report['desktop_native']['attendanceEnabled']
    attendance_off_message = 'Attendance is off for your organisation.'
    changed_account_message = 'Your sign-in changed. Reload My desk before retrying attendance.'
    stale_action_message = 'This action was saved offline more than 3 hours ago. Ask for a correction on My desk instead.'

    def attendance_counts(person_id):
        return conn.execute('select (select count(*) from pulse.attendance_entry where org_id=pulse.current_org() and person_id=%s) entries, (select count(*) from pulse.attendance_break where org_id=pulse.current_org() and person_id=%s) breaks', (person_id, person_id)).fetchone()

    for action in ['check-in', 'check-out', 'break']:
        if attendance_enabled:
            status, data, _, _ = call('/api/v0/attendance/'+action, 'pgs', {'expectedPersonId':people['person'],'action':'start'})
            check('R16 changed-account '+action+' refused', status == 403 and data == {'error': changed_account_message})
        else:
            before = attendance_counts(people['pgs'])
            status, data, _, _ = call('/api/v0/attendance/'+action, 'pgs', {'expectedPersonId':people['person'],'action':'start'})
            after = attendance_counts(people['pgs'])
            check('R16 attendance-off '+action+' refused', status == 403 and data == {'error': attendance_off_message})
            check('R16 attendance-off '+action+' writes no attendance', after == before)
    check('R16 changed-account shell enrollment refused', call('/api/v0/native/shell/enroll', 'pgs', {'expectedPersonId':people['person'],'code':'ABCD-EFGH'})[0] == 403)
    from datetime import datetime, timedelta, timezone
    old_tap = (datetime.now(timezone.utc)-timedelta(days=7)).isoformat()
    before_old_tap = attendance_counts(people['pgs'])
    old_status, old_refusal, _, _ = call('/api/v0/attendance/check-in', 'pgs', {'expectedPersonId':people['pgs'],'at':old_tap,'queueId':'r16-old-attendance'})
    if attendance_enabled:
        check('R16 seven-day metadata cannot backdate attendance', old_status == 409 and old_refusal == {'error': stale_action_message})
    else:
        check('R16 seven-day metadata cannot bypass attendance-off policy', old_status == 403 and old_refusal == {'error': attendance_off_message})
    check('R16 refused old tap writes no attendance row', attendance_counts(people['pgs']) == before_old_tap)

    report['passed']=True
except Exception as error:
    report['passed']=False;report['error']=type(error).__name__+': '+str(error)[:250]
    raise
finally:
    if browser_input is not None:browser_input.unlink(missing_ok=True)
    if created:
        cleanup(list(people.values()))
        report['test_users_deleted']=True
    conn.close()
    p=out/(envname+'-public-check.json');p.write_text(json.dumps(report,indent=2)+'\n');p.chmod(0o600)
    print(json.dumps({'environment':envname,'passed':report.get('passed',False),'checks':len(report['checks']),'test_users_deleted':report.get('test_users_deleted',False)}))
