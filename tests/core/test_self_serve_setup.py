"""SELF-SERVE (owner, 4 Nov 2026: "anyone can open Pulse, make an account and manage their life or work by their type";
db/migrations/1520_self_serve_setup.sql, services/api/src/self-serve-setup.ts, self-serve-space.ts). The HTTP journey
(services/api/test/self-serve-setup-runner.mjs, mail in the sink): every kind of space signs up with an e-mailed code and
opens set up for its type; a professional's client opens their space from the e-mailed link with one click and no
password and sees the appointment booked for them; Start another space; About you; the connector's app name. Here, on
top: what the database kept (each space's setup, its own client types, the account's types, no password, a proven
address), that a space reads only its own rows, and the browser journey for each type at 390 px and on a computer
(services/api/test/self-serve-browser-runner.mjs, with PULSE_AUTH_BROWSER=1). Synthetic people only."""
from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import psycopg
import pytest
from psycopg.conninfo import conninfo_to_dict

from conftest import dsn
from helpers import build_world
from pulse_sdk.db import set_tenant

ROOT = Path(__file__).resolve().parents[2]


def run_node(name, org, tmp_path, timeout=600, extra=None):
    config = conninfo_to_dict(dsn('api'))
    config['database'] = config.pop('dbname')
    env = {**os.environ, 'TEST_API_CONFIG': json.dumps(config), 'PULSE_ORG_ID': str(org), 'PULSE_CI': '1', 'PULSE_PUBLIC_LOGIN_ENABLED': '1',
           'PULSE_AUTH_MAIL_MODE': 'sink', 'TEST_REPORT': str(tmp_path / f'{name}.json'), **(extra or {})}
    p = subprocess.run(['node', f'test/{name}.mjs'], cwd=ROOT / 'services/api', env=env, capture_output=True, text=True, timeout=timeout, check=False)
    assert p.returncode == 0, (p.stdout[-4000:] + '\n' + p.stderr[-8000:])
    print(p.stdout[-2000:])
    return json.loads((tmp_path / f'{name}.json').read_text())


def test_sign_up_by_type_and_a_professionals_client(worker, owner, api, tmp_path):
    install = build_world(worker, owner, api)
    report = run_node('self-serve-setup-runner', install.org, tmp_path)
    assert report['checks'] >= 85
    spaces = report['spaces']
    assert sorted(spaces) == sorted(['student', 'practice', 'agency', 'shop', 'maker', 'real_estate', 'school', 'ngo', 'other', 'creator'])
    for key, s in spaces.items():
        with owner.transaction():
            set_tenant(owner, s['org'])
            row = owner.execute("select space, served, jsonb_array_length(cards) n, home from pulse.org_setup where org_id=%s", (s['org'],)).fetchone()
            assert row['space'] == s['space'] and row['n'] >= 3, key
            assert row['home'] == ('/my-day' if s['space'] == 'personal' else '/dashboard'), key
            # Its own client types (never the install's real-estate defaults), with Internal and Other kept.
            types = [r['key'] for r in owner.execute("select key from pulse.record_type where org_id=%s and entity='client' order by sort", (s['org'],)).fetchall()]
            assert 'developer' not in types and types[-2:] == ['internal', 'other'], (key, types)
            assert owner.execute("select count(*) n from pulse.work_project where org_id=%s and template_key like 'starter:%%'", (s['org'],)).fetchone()['n'] >= 1, key
            assert owner.execute("select activation from pulse.org where id=%s", (s['org'],)).fetchone()['activation'] == 'live', key
        with owner.transaction():
            acct = owner.execute("select password_hash is null nopw, email_verified_at is not null proven from pulse_priv.pulse_account where email=%s", (s['email'],)).fetchone()
            assert acct == {'nopw': True, 'proven': True}, key
    with owner.transaction():
        set_tenant(owner, spaces['practice']['org'])
        assert [r['key'] for r in owner.execute("select key from pulse.record_type where org_id=%s and entity='client' and not system order by sort", (spaces['practice']['org'],)).fetchall()] == ['individual', 'couple_family', 'organisation']
        assert owner.execute("select words->>'clients' w from pulse.org_pack where org_id=%s", (spaces['practice']['org'],)).fetchone()['w'] == 'Patients'
        # The client: a record of the practice, their appointment cancelled at the end, their own account with no password.
        c = report['client']
        assert owner.execute("select client_type from pulse.client where id=%s", (c['clientId'],)).fetchone()['client_type'] == 'individual'
        assert owner.execute("select status from pulse.client_appointment where client_id=%s", (c['clientId'],)).fetchone()['status'] == 'cancelled'
    with owner.transaction():
        acct = owner.execute("select a.password_hash is null nopw, a.email_verified_at is not null proven, m.kind from pulse_priv.pulse_account a "
                             "join pulse_priv.account_member m on m.account_id=a.id where a.email=%s", (report['client']['email'],)).fetchone()
        assert acct == {'nopw': True, 'proven': True, 'kind': 'client'}
        kinds = owner.execute("select p.kinds from pulse_priv.account_kinds p join pulse_priv.pulse_account a on a.id=p.account_id where a.email=%s", (report['studentEmail'],)).fetchone()['kinds']
        assert sorted(kinds) == ['other', 'professional'], 'About you saved'
    # A colleague who does not look after the client neither sees, books, moves nor cancels their appointments (review,
    # 5 Nov 2026: the same rule as the list), and the clients to book for are only their own.
    org = spaces['practice']['org']
    client_id = report['client']['clientId']
    with owner.transaction():
        set_tenant(owner, org)
        colleague = owner.execute("insert into pulse.person(org_id,display_name,side) values(%s,'Synthetic Colleague','staff') returning id", (org,)).fetchone()['id']
        lead = owner.execute("select relationship_owner_id o from pulse.client where id=%s", (client_id,)).fetchone()['o']
        appt = owner.execute("insert into pulse.client_appointment(org_id,client_id,starts_at,created_by) values(%s,%s,now()+interval '2 days',%s) returning id",
                             (org, client_id, lead)).fetchone()['id']
    with api.transaction():
        set_tenant(api, org, colleague)
        seen = api.execute("select pulse.appointment_list(null) l").fetchone()['l']
        assert seen['upcoming'] == [] and seen['past'] == [] and seen['clients'] == [], 'a colleague sees none of them'
    for sql, args in (("select pulse.appointment_save(%s::jsonb)", (json.dumps({'id': str(appt), 'startsAt': '2030-01-01T05:30:00Z'}),)),
                      ("select pulse.appointment_cancel(%s)", (appt,)),
                      ("select pulse.appointment_save(%s::jsonb)", (json.dumps({'clientId': str(client_id), 'startsAt': '2030-01-01T05:30:00Z'}),))):
        with pytest.raises(psycopg.Error):
            with api.transaction():
                set_tenant(api, org, colleague)
                api.execute(sql, args)
    with owner.transaction():
        set_tenant(owner, org)
        assert owner.execute("select status, starts_at > now() + interval '1 day' later from pulse.client_appointment where id=%s", (appt,)).fetchone() == {'status': 'booked', 'later': True}
    with api.transaction():
        set_tenant(api, org, lead)
        assert api.execute("select pulse.appointment_cancel(%s) a", (appt,)).fetchone()['a']['client'] == 'Synthetic Asha Rao', 'the one who looks after them can'
    # The connector's rows of every space stay out of reach unless the API turns the shared-address flag on for one oauth
    # call (oauth.ts and v1.ts turn it off straight after): from the shop's space, none of another space's are visible.
    with owner.transaction():
        set_tenant(owner, spaces['shop']['org'])
        for table in ('oauth_client', 'oauth_code', 'oauth_token', 'oauth_grant'):
            assert owner.execute(f"select count(*) n from pulse_priv.{table} where org_id<>%s", (spaces['shop']['org'],)).fetchone()['n'] == 0, table
        owner.execute("select set_config('pulse.shared_address','1',true)")
        assert owner.execute("select count(*) n from pulse_priv.oauth_token where org_id<>%s", (spaces['shop']['org'],)).fetchone()['n'] >= 1, 'the flag is what opens them'
    # Inside one new space, the API role reads only its own rows.
    org = spaces['practice']['org']
    with api.transaction():
        set_tenant(api, org)
        for table in ('person', 'client', 'task', 'record_type'):
            assert api.execute(f"select count(*) n from pulse.{table} where org_id<>%s", (org,)).fetchone()['n'] == 0, table
    with owner.transaction():
        set_tenant(owner, spaces['shop']['org'])
        assert owner.execute("select count(*) n from pulse.client_appointment").fetchone()['n'] == 0, 'another space sees no appointment'
        assert owner.execute("select count(*) n from pulse.org_setup").fetchone()['n'] == 1


@pytest.mark.skipif(os.environ.get("PULSE_AUTH_BROWSER") != "1", reason="browser checks run in CI with PULSE_AUTH_BROWSER=1")
def test_self_serve_journeys_in_the_browser(worker, owner, api, tmp_path):
    """Each type signs up in the browser (390 px and 1440 px): the two questions, the details, the e-mailed code, and the
    first useful screen with its cards, timed; the psychologist adds a client and books; the client's one click opens
    their space with the appointment; a new person signs up on the way to the ChatGPT/Claude connector and returns to its
    consent screen. Screenshots with PULSE_SS_SCREENSHOTS."""
    install = build_world(worker, owner, api)
    report = run_node('self-serve-browser-runner', install.org, tmp_path, timeout=1800)
    assert report['checks'] >= 60
    assert all(ms < 20000 for ms in report['firstUseful'].values()), report['firstUseful']
