"""ONBOARD-SELF (owner, 2 Nov 2026): "start your company on Pulse", self-serve (db/migrations/1462_self_serve_onboarding.sql,
services/api/src/self-serve.ts, accounts.ts). The API acceptance (services/api/test/self-serve-runner.mjs, mail in the sink):
a founder with no account starts a company with an e-mailed code; it opens ready to use (never held in set-up) with its
starter projects; it and the agency cannot see each other; a proven e-mail is needed; three a day per account; invitations
by e-mail per seat into an existing account or a new one; the first-run guide. Here, on top: no address is claimed and the
database keeps no other company's rows in the new one."""
from __future__ import annotations

from pulse_sdk.db import set_tenant
from test_sop import demo_world, run_runner


def test_self_serve_company(worker, owner, api, tmp_path):
    w, p = demo_world(worker, owner, api)
    # ACCOUNT-SEATS: an earlier, inactive record of the agency's with the address that will be invited.
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.people_profile set email='sana.old@gmail.example' where person_id=%s", (p['sana'],))
        worker.execute("update pulse.person set status='inactive' where id=%s", (p['sana'],))
    report = run_runner('self-serve-runner', w, p, tmp_path, timeout=600)
    assert report['checks'] >= 90
    neeti = report['neeti']
    with owner.transaction():
        set_tenant(owner, neeti)
        org = owner.execute("select status, activation, time_zone from pulse.org where id=%s", (neeti,)).fetchone()
        assert (org['status'], org['activation'], org['time_zone']) == ('active', 'live', 'Asia/Kolkata')
        # Custom domains stay the operator's: a self-serve company claims no address.
        assert owner.execute("select count(*) n from pulse.org_domain where org_id=%s", (neeti,)).fetchone()['n'] == 0
        assert owner.execute("select work_days, shift_start::text s, shift_end::text e from pulse.hr_policy where org_id=%s", (neeti,)).fetchone() == \
            {'work_days': [1, 2, 3, 4, 5, 6], 's': '10:00:00', 'e': '19:00:00'}
        assert owner.execute("select templates from pulse.org_onboarding where org_id=%s", (neeti,)).fetchone()['templates'] == ['sales', 'software']
        # The code is stored hashed and is gone once used.
        assert owner.execute("select count(*) n from pulse_priv.email_code where email='founder@neeticrm.example'").fetchone()['n'] == 0
    # Inside the new company, the API role reads only its own rows, whatever the query asks for.
    with api.transaction():
        set_tenant(api, neeti)
        for table in ('person', 'project', 'task', 'people_profile', 'role_assignment'):
            assert api.execute(f"select count(*) n from pulse.{table} where org_id<>%s", (neeti,)).fetchone()['n'] == 0, table
        assert api.execute("select count(*) n from pulse.project where org_id=%s", (w.org,)).fetchone()['n'] == 0
    with owner.transaction():
        set_tenant(owner, w.org)
        # The invitation linked the earlier record: no second Sana, still inactive (HR decides).
        assert owner.execute("select count(*) n from pulse.person where org_id=%s and display_name='Sana Qipedot'", (w.org,)).fetchone()['n'] == 1
        assert owner.execute("select status from pulse.person where id=%s", (p['sana'],)).fetchone()['status'] == 'inactive'
        acct = owner.execute("select a.email from pulse_priv.account_member m join pulse_priv.pulse_account a on a.id=m.account_id where m.person_id=%s", (p['sana'],)).fetchone()
        assert acct['email'] == 'sana.old@gmail.example'
    with owner.transaction():
        set_tenant(owner, neeti)
        # Leavers: inactive in NeetiCRM, records kept, no longer on their accounts.
        rows = owner.execute("select pe.status, pp.email from pulse.person pe join pulse.people_profile pp on pp.person_id=pe.id where pe.org_id=%s and pp.email in (%s,%s)",
                             (neeti, report['repEmail'], f'kabir@{w.domain}')).fetchall()
        assert sorted(r['status'] for r in rows) == ['inactive', 'inactive']
        assert owner.execute("select count(*) n from pulse_priv.account_member where member_org=%s and person_id in (select person_id from pulse.people_profile where org_id=%s and email in (%s,%s))",
                             (neeti, neeti, report['repEmail'], f'kabir@{w.domain}')).fetchone()['n'] == 0
        assert owner.execute("select count(*) n from pulse_priv.pulse_account where email=%s", (report['repEmail'],)).fetchone()['n'] == 1
