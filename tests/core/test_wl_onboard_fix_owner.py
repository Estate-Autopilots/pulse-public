"""WL-ONBOARD-FIX (17 Nov 2026), problem 10: a company's owner already on its people list (admin and leadership, added for
their e-mail, never signed in, as an operator adds one) is invited by e-mail with the leadership seat and joins: the
account lands on that record (no second person), keeps its roles and opens Finance and payroll at once
(services/api/test/wl-onboard-fix-owner-runner.mjs, mail in the sink). Invented people only."""
from __future__ import annotations

import uuid

from pulse_sdk.db import set_tenant
from test_sop import demo_world, run_runner

OWNER_EMAIL = "owner.synthetic@example.test"


def test_an_invited_owner_joins_onto_their_own_record(worker, owner, api, tmp_path):
    w, p = demo_world(worker, owner, api)
    boss = uuid.uuid4()
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,'Synthetic Owner','staff')", (boss, w.org))
        worker.execute("insert into pulse.people_profile(org_id,person_id,role,evidence,email) values(%s,%s,'Owner','added for their e-mail, not yet signed in',%s)",
                       (w.org, boss, OWNER_EMAIL))
        for role in ("admin", "leadership"):
            worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,%s,'2026-11-16')", (w.org, boss, role))
    report = run_runner("wl-onboard-fix-owner-runner", w, p, tmp_path, extra={"TEST_OWNER_PERSON": str(boss), "TEST_OWNER_EMAIL": OWNER_EMAIL}, timeout=600)
    assert report["checks"] >= 8, report
    with owner.transaction():
        set_tenant(owner, w.org)
        n = owner.execute("select count(*) n from pulse.people_profile where org_id=%s and lower(email)=%s", (w.org, OWNER_EMAIL)).fetchone()["n"]
        assert n == 1, "one record for the owner's e-mail"
        roles = {r["role_key"] for r in owner.execute("select role_key from pulse.role_assignment where person_id=%s and (valid_to is null or valid_to >= current_date)", (boss,))}
        assert {"admin", "leadership"} <= roles, roles
