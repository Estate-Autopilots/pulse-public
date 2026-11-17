"""AGREEMENTS (2081, owner 13 Nov 2026, T1.2.1/T1.2.3): a published policy version is accepted term by term; the
acceptance keeps the terms ticked and the exact text, never changes, and a newer version asks again; managers see who in
their team has not accepted, HR everyone, other companies nothing. Synthetic companies, people and policy text only."""
import hashlib
import json
import os
import subprocess
from pathlib import Path

import psycopg
import pytest
from conftest import dsn
from helpers import build_world
from psycopg.conninfo import conninfo_to_dict
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from test_erp_invoice import as_, one, person

API = Path(__file__).resolve().parents[2] / "services/api"
PAY = ("# Synthetic pay policy\n\nSynthetic Studio pays everyone the same way.\n\n## 1. Who approves pay\nLeadership approves every change.\n\n"
       "## 2. Notice\nThirty synthetic days.\n\n## What happens next\nAsk HR.")
TERMS = [{"key": "t1-who-approves-pay", "title": "Who approves pay"}, {"key": "t2-notice", "title": "Notice"}]


@pytest.fixture
def team(worker, owner, api):
    w = build_world(worker, owner, api)
    w.hr = person(worker, w, "Synthetic HR", "hr")
    w.mgr = person(worker, w, "Synthetic Manager")
    w.alice, w.bob = (person(worker, w, n) for n in ("Synthetic Alice", "Synthetic Bob"))
    with worker.transaction():
        set_tenant(worker, w.org)
        for p, u in ((w.alice, "synthetic.alice"), (w.bob, "synthetic.bob"), (w.mgr, "synthetic.mgr"), (w.hr, "synthetic.hr")):
            worker.execute("insert into pulse.people_profile(org_id,person_id,role,username,evidence,manager_id) values(%s,%s,'Editor',%s,'{}',%s)",
                           (w.org, p, u, w.mgr if p == w.alice else None))
    return w


def publish(worker, w, version=1, body=PAY, kind="pay"):
    with worker.transaction():
        set_tenant(worker, w.org)
        return worker.execute("""insert into pulse.policy_document(org_id,kind,version,title,body,status,created_by,published_at,published_by)
            values(%s,%s,%s,'Synthetic pay policy',%s,'published',%s,now(),%s) returning id""", (w.org, kind, version, body, w.hr, w.hr)).fetchone()["id"]


def accept(api, w, who, doc, terms=None):
    return one(api, w, who, "select pulse.policy_accept(%s,%s) r", (doc, Jsonb(TERMS if terms is None else terms)))["r"]


def test_a_version_is_accepted_term_by_term_and_kept_as_it_was(api, worker, owner, team):
    w = team
    doc = publish(worker, w)
    first = accept(api, w, w.alice, doc)
    assert (first["version"], first["via"], first["kind"]) == (1, "steps", "pay")
    assert accept(api, w, w.alice, doc)["at"] == first["at"], "a second press returns the first acceptance"
    row = one(api, w, w.alice, "select terms, body_sha256, via from pulse.policy_ack where document_id=%s", (doc,))
    assert row["terms"] == TERMS and row["via"] == "steps"
    assert row["body_sha256"] == hashlib.sha256(PAY.encode()).hexdigest(), "the hash is of the stored text"
    # HR desk's and People & pay's count (GET /api/v0/hr/policies ackCount) includes it.
    assert one(api, w, w.hr, "select count(*)::int n from pulse.policy_ack where document_id=%s", (doc,))["n"] == 1
    # Nobody rewrites an acceptance, not even the worker.
    with pytest.raises(psycopg.errors.InsufficientPrivilege), worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.policy_ack set terms='[]' where document_id=%s", (doc,))
    # Ticks are required, in the right shape.
    for bad in ([], [{"key": "t1-x"}], [{"key": "t1-x", "title": "X", "extra": 1}], {"key": "t1-x", "title": "X"}):
        with pytest.raises(psycopg.errors.InvalidParameterValue):
            accept(api, w, w.bob, doc, bad)
    # My desk's one button keeps working and now keeps the text too.
    one(api, w, w.bob, "select pulse.policy_acknowledge(%s)", (doc,))
    row = one(api, w, w.bob, "select terms, body_sha256, via from pulse.policy_ack where document_id=%s", (doc,))
    assert (row["terms"], row["via"], row["body_sha256"]) == ([], "desk", hashlib.sha256(PAY.encode()).hexdigest())


def test_a_newer_version_asks_again_and_the_old_acceptance_stays(api, worker, owner, team):
    w = team
    v1 = publish(worker, w)
    accept(api, w, w.alice, v1)
    v2 = publish(worker, w, 2, PAY + "\n\n## 3. Claims\nKeep the bills.")
    with pytest.raises(psycopg.errors.SerializationFailure):
        accept(api, w, w.bob, v1)
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        one(api, w, w.bob, "select pulse.policy_acknowledge(%s)", (v1,))
    assert one(api, w, w.alice, "select pulse.policy_is_current(%s) c", (v1,))["c"] is False
    assert [r["version"] for r in as_(api, w, w.alice, "select d.version from pulse.policy_ack a join pulse.policy_document d on d.id=a.document_id")] == [1]
    accept(api, w, w.alice, v2, TERMS + [{"key": "t3-claims", "title": "Claims"}])
    assert sorted(r["version"] for r in as_(api, w, w.alice, "select d.version from pulse.policy_ack a join pulse.policy_document d on d.id=a.document_id")) == [1, 2]
    # A draft is never accepted; someone who left, a client seat and a shared login cannot accept.
    with worker.transaction():
        set_tenant(worker, w.org)
        draft = worker.execute("""insert into pulse.policy_document(org_id,kind,version,title,body,status,created_by)
            values(%s,'conduct',1,'Synthetic conduct',%s,'draft',%s) returning id""", (w.org, PAY, w.hr)).fetchone()["id"]
        worker.execute("update pulse.person set status='inactive' where id=%s", (w.bob,))
        client = worker.execute("insert into pulse.person(org_id,display_name,side) values(%s,'Synthetic Client','client') returning id", (w.org,)).fetchone()["id"]
    with pytest.raises(psycopg.errors.NoDataFound):
        accept(api, w, w.alice, draft)
    for who in (w.bob, client, None):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            accept(api, w, who, v2)


def test_managers_see_their_people_hr_everyone_others_nobody(api, worker, owner, team):
    w = team
    doc = publish(worker, w)
    accept(api, w, w.alice, doc)
    mine = one(api, w, w.mgr, "select pulse.policy_team_status() s")["s"]
    assert (mine["scope"], mine["people"]) == ("team", 1)
    assert [p["name"] for p in mine["policies"][0]["accepted"]] == ["Synthetic Alice"] and mine["policies"][0]["pending"] == []
    everyone = one(api, w, w.hr, "select pulse.policy_team_status() s")["s"]
    assert everyone["scope"] == "company"
    pending = {p["name"] for p in everyone["policies"][0]["pending"]}
    assert {"Synthetic Bob", "Synthetic Manager", "Synthetic HR"} <= pending and "Synthetic Alice" not in pending
    nobody = one(api, w, w.bob, "select pulse.policy_team_status() s")["s"]
    assert (nobody["scope"], nobody["people"]) == ("team", 0)
    assert all(p["accepted"] == [] and p["pending"] == [] for p in nobody["policies"])
    # Employees still read only their own acceptances; another company sees none of this one's.
    assert as_(api, w, w.bob, "select person_id from pulse.policy_ack") == []
    other = build_world(worker, owner, api)
    other_hr = person(worker, other, "Synthetic Other HR", "hr")
    assert one(api, other, other_hr, "select pulse.policy_team_status() s")["s"]["policies"] == []
    assert one(api, other, other_hr, "select pulse.policy_is_current(%s) c", (doc,))["c"] is False
    with pytest.raises(psycopg.errors.NoDataFound):
        accept(api, other, other_hr, doc)


def api_env(**extra):
    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    return {**os.environ, "PULSE_CI": "1", "TEST_API_CONFIG": json.dumps(config), **extra}


def test_acceptance_through_the_api(api, worker, team):
    w = team
    doc = publish(worker, w)
    emails = {}
    with worker.transaction():
        set_tenant(worker, w.org)
        for who, handle in ((w.alice, "alice"), (w.bob, "bob"), (w.mgr, "mgr"), (w.hr, "hr")):
            worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')",
                           (w.org, f"{handle}@{w.domain}", who))
            emails[handle] = f"{handle}@{w.domain}"
    p = subprocess.run(["node", "test/policy-acceptance-runner.mjs"], cwd=API, env=api_env(TEST_EMAILS=json.dumps(emails), TEST_DOC=str(doc)),
                       capture_output=True, text=True, timeout=120, check=False)
    assert p.returncode == 0, p.stderr[-4000:] + p.stdout[-4000:]
    row = one(api, w, w.alice, "select terms, via from pulse.policy_ack where document_id=%s", (doc,))
    assert (row["terms"], row["via"]) == (TERMS, "steps")
