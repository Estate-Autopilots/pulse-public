"""FEATURES-1024: an organisation's handle is reserved once (db/migrations/0984_org_handle_once.sql).

An "insert … on conflict" of an organisation that already exists (the Drive collector upserts its organisation row on
every run) used to reserve a fresh handle each time (estateautopilots2 … 185 on dev)."""
from __future__ import annotations

import uuid

from helpers import new_code
from pulse_sdk.db import set_tenant


def handles(owner, org):
    rows = owner.execute("select handle from pulse_priv.handle_name where kind='org' and ref=%s order by created_at", (org,)).fetchall()
    return [r["handle"] if isinstance(r, dict) else r[0] for r in rows]


def org_handle(worker, org):
    with worker.transaction():
        set_tenant(worker, org)
        r = worker.execute("select handle from pulse.org where id=%s", (org,)).fetchone()
    return r["handle"] if isinstance(r, dict) else r[0]


def test_org_upsert_reserves_its_handle_once(worker, owner):
    org, code = uuid.uuid4(), new_code()
    for _ in range(3):
        with worker.transaction():
            set_tenant(worker, org)
            worker.execute("insert into pulse.org(id,slug,name,code) values (%s,%s,'Handle Once Agency',%s) on conflict(id) do nothing", (org, f"org-{org}", code))
    got = handles(owner, org)
    assert len(got) == 1, got
    assert got == [org_handle(worker, org)]


def test_a_new_organisation_still_gets_a_handle_and_a_taken_one_is_not_reused(worker, owner):
    a, b = uuid.uuid4(), uuid.uuid4()
    for org in (a, b):
        with worker.transaction():
            set_tenant(worker, org)
            worker.execute("insert into pulse.org(id,slug,name,code) values (%s,%s,'Same Name Studio',%s)", (org, f"org-{org}", new_code()))
    ha, hb = handles(owner, a), handles(owner, b)
    assert len(ha) == 1 and len(hb) == 1 and ha != hb
