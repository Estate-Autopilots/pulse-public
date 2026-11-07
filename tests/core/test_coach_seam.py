"""R50 coach seam in the database: off by default and configured per company by admins (the stub is the only
provider); a narrow coach.v1 packet built from R49's explanation with no names, ids, job text or private attributes;
the table refuses any other packet; suggestions must cite that packet and be one of four next-step kinds; HR and admins
decide each one and nothing else happens; a request that times out or fails reads as R49's explanation; nothing
crosses a company. Synthetic tenants, people, jobs and skills only."""
import json
import os
import re
import subprocess
import uuid
from pathlib import Path

import psycopg
import pytest
from conftest import dsn
from helpers import build_world
from psycopg.conninfo import conninfo_to_dict
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from test_internal_ats import (
    FORBIDDEN,
    PRIVATE_WORDS,
    call,
    change_private_attributes,
    world,
)
from test_tasks_rt1 import as_, team  # noqa: F401  (team is a fixture)

STUB = {"state": "enabled", "provider": "stub", "timeoutMs": 3000, "maxSuggestions": 3}


def configure(api, w, who, reason="Synthetic: try the deterministic stub", **change):
    return call(api, w, who, "coach_configure", Jsonb({**STUB, **change}), reason)


def finish(api, w, who, rid, status="answered", suggestions=None, failure=None):
    as_(api, w, who, "select pulse.coach_request_finish(%s,%s,'stub-1',12,%s,%s)", (rid, status, failure, None if suggestions is None else Jsonb(suggestions)))


def counts(owner, w):
    with owner.transaction():
        set_tenant(owner, w.org)
        return {t: owner.execute(f"select count(*) n from pulse.{t}").fetchone()["n"]
                for t in ("ats_pick", "ats_check", "ats_acceptance", "ats_weights", "ats_job", "ats_requirement", "person_skill", "skill_verification")}


def test_off_by_default_and_configured_per_company(api, worker, owner, team, tmp_path):  # noqa: F811
    w = team
    job, _, _ = world(api, worker, w, tmp_path)
    st = call(api, w, w.editor, "coach_status")
    assert (st["contract"], st["tenant"]["state"], st["tenant"]["version"], st["versions"]) == ("coach.v1", "disabled", 0, [])
    assert st["can"] == {"configure": False, "request": False}
    assert call(api, w, w.lead, "coach_status")["can"] == {"configure": False, "request": True}
    assert call(api, w, w.manager, "coach_status")["can"] == {"configure": True, "request": True}
    # Off: nobody can ask, not even HR.
    with pytest.raises(psycopg.errors.ObjectNotInPrerequisiteState):
        call(api, w, w.lead, "coach_request_open", job, w.editor)
    # Admins alone configure: HR, a pod head and a member are refused.
    for who in (w.lead, w.editor2, w.editor):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            configure(api, w, who)
    # The stub is the only provider; bounds and a reason.
    for change in ({"state": "on"}, {"provider": "anthropic"}, {"provider": "openai"}, {"timeoutMs": 50}, {"timeoutMs": 60000},
                   {"timeoutMs": "3000"}, {"maxSuggestions": 0}, {"maxSuggestions": 11}):
        with pytest.raises(psycopg.errors.InvalidParameterValue):
            configure(api, w, w.manager, **change)
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        configure(api, w, w.manager, reason="short")
    assert configure(api, w, w.manager) == 1
    st = call(api, w, w.editor, "coach_status")
    assert (st["tenant"]["state"], st["tenant"]["version"], st["tenant"]["setBy"], len(st["versions"])) == ("enabled", 1, "Pod Manager", 1)
    assert configure(api, w, w.manager, state="disabled", reason="Synthetic: off again until E08/E16") == 2
    with pytest.raises(psycopg.errors.ObjectNotInPrerequisiteState):
        call(api, w, w.lead, "coach_request_open", job, w.editor)
    assert [v["state"] for v in call(api, w, w.lead, "coach_status")["versions"]] == ["disabled", "enabled"]

    # Another company has its own configuration, still off, and none of this one's.
    configure(api, w, w.manager, reason="Synthetic: on for the tenant test")
    rid = call(api, w, w.lead, "coach_request_open", job, w.editor)["id"]
    other = build_world(worker, owner, api)
    with worker.transaction():
        set_tenant(worker, other.org)
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'admin','2026-01-01')", (other.org, other.manager))
    theirs = call(api, other, other.manager, "coach_status")
    assert (theirs["tenant"]["state"], theirs["versions"]) == ("disabled", [])
    configure(api, other, other.manager, reason="Synthetic: the other company's own stub")
    assert call(api, other, other.manager, "coach_requests", None) == []
    for fn, args in (("coach_request_open", (job, w.editor)), ("coach_evidence", (job, w.editor)), ("coach_request_read", (rid,)), ("coach_requests", (job,))):
        with pytest.raises(psycopg.errors.NoDataFound):
            call(api, other, other.manager, fn, *args)
    with pytest.raises(psycopg.errors.NoDataFound):
        call(api, other, other.manager, "coach_request_finish", rid, "timed_out", "stub-1", 1, None, None)
    assert call(api, w, w.lead, "coach_status")["tenant"]["version"] == 3


def test_the_packet_is_narrow_and_the_table_refuses_anything_else(api, worker, owner, team, tmp_path):  # noqa: F811
    w = team
    job, _, _ = world(api, worker, w, tmp_path)
    configure(api, w, w.manager)
    # Only HR and admins build a packet, about current staff of this company.
    for who in (w.editor, w.editor2, w.outsider):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            as_(api, w, who, "select pulse.coach_evidence(%s,%s)", (job, w.editor))
    with pytest.raises(psycopg.errors.NoDataFound):
        call(api, w, w.lead, "coach_evidence", job, uuid.uuid4())
    ev = call(api, w, w.lead, "coach_evidence", job, w.editor)
    assert set(ev) == {"contract", "purpose", "subject", "method", "scale", "evidence"}
    assert (ev["contract"], ev["purpose"], ev["subject"], ev["method"]) == ("coach.v1", "internal_job_fit", "subject", {"weightsVersion": 0, "accepted": False})
    assert ev["scale"] == ["Learning", "Working", "Strong", "Expert"]
    items = {e["requirement"]["skill"]: e for e in ev["evidence"]}
    assert [e["id"] for e in ev["evidence"]] == ["e1", "e2", "e3", "e4", "e5"]
    edit = items["edit video footage"]
    assert edit == {"id": "e1", "requirement": {"skill": "edit video footage", "importance": "required", "minLevel": 3, "recentMonths": 12},
                    "outcome": "matched", "points": 3, "weight": 3,
                    "record": {"skill": "edit video footage", "via": "same", "level": 3, "basis": "verified", "recent": True, "lastUsed": None}}
    assert items["pilot aerial camera"]["record"] is None and items["pilot aerial camera"]["outcome"] == "unknown"
    out = {e["requirement"]["skill"]: e for e in call(api, w, w.lead, "coach_evidence", job, w.outsider)["evidence"]}
    assert (out["Model shoot direction"]["outcome"], out["Model shoot direction"]["record"]["level"]) == ("missing", 1)
    text = json.dumps(ev)
    # No name (the person's or the verifier's), no id, no job title, purpose or note.
    for word in ("Editor One", "Editor Two", "Synthetic launch editor", "edits launch films", "nice to have", str(w.editor), str(job), "@"):
        assert word not in text, word
    with owner.transaction():
        assert owner.execute("select pulse.coach_evidence_ok(%s) ok", (Jsonb(ev),)).fetchone()["ok"] is True

    # Pay, attendance, leave, chats, app activity, contact and private profile fields cannot change the packet.
    before = call(api, w, w.lead, "coach_evidence", job, w.outsider)
    change_private_attributes(owner, w)
    after = call(api, w, w.lead, "coach_evidence", job, w.outsider)
    assert after == before
    for word in [x for x in PRIVATE_WORDS if x != "intern"] + ['"intern"', "Synthetic about", "+910000000000", "example.test"]:
        assert word not in json.dumps(after), word
    # The packet builder reads the job, the person's standing and R49's explanation, nothing else.
    with api.transaction():
        src = {r["proname"]: r["prosrc"].lower() for r in api.execute("""select p.proname, p.prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
            where n.nspname='pulse' and p.proname in ('coach_evidence','coach_request_open')""").fetchall()}
    assert len(src) == 2
    for name, body in src.items():
        assert not [f for f in FORBIDDEN if f in body], name
        used = set(re.findall(r"\b(?:from|join|into)\s+(?:lateral\s+)?(?:pulse\.)?([a-z_]+)", body))
        assert used <= {"ats_job", "person", "jsonb_array_elements", "rec", "rid", "coach_request"}, (name, used)

    # The table itself refuses any other packet: forbidden fields, ids, e-mail addresses, other contracts.
    def refused(change):
        p = json.loads(json.dumps(ev))
        change(p)
        with owner.transaction():
            set_tenant(owner, w.org)
            assert owner.execute("select pulse.coach_evidence_ok(%s) ok", (Jsonb(p),)).fetchone()["ok"] is False
            with pytest.raises(psycopg.errors.CheckViolation), owner.transaction():
                owner.execute("""insert into pulse.coach_request(org_id,job_id,subject_id,evidence,evidence_hash,provider,config_version,timeout_ms,requested_by)
                                 values(%s,%s,%s,%s,repeat('0',64),'stub',1,3000,%s)""", (w.org, job, w.editor, Jsonb(p), w.lead))
    for change in (lambda p: p.update(salary=999999), lambda p: p.update(payroll={"month": "2026-09"}), lambda p: p.update(chat=["Synthetic: expert"]),
                   lambda p: p.update(activity=[{"app": "Synthetic", "minutes": 300}]), lambda p: p.update(attendance={"late": 240}),
                   lambda p: p.update(contact={"phone": "+910000000000"}), lambda p: p.update(name="Editor One"),
                   lambda p: p["evidence"][0].update(notes="Synthetic private note"), lambda p: p["evidence"][0]["record"].update(verifiedBy="Editor Two"),
                   lambda p: p["evidence"][0]["requirement"].update(note="Synthetic"), lambda p: p["method"].update(salaryBand=3),
                   lambda p: p.update(subject=str(w.editor)), lambda p: p.update(contract="coach.v2"), lambda p: p.update(purpose="performance_review"),
                   lambda p: p["evidence"][0].update(outcome="rejected"), lambda p: p["evidence"][0].update(id="person-1"),
                   lambda p: p["evidence"][0]["requirement"].update(skill=f"Edit for {w.editor}"),
                   lambda p: p["evidence"][1]["requirement"].update(skill="Ask synthetic.person@example.test"),
                   lambda p: p.update(evidence=p["evidence"] * 11)):
        refused(change)


def test_cited_suggestions_and_human_decisions_only(api, worker, owner, team, tmp_path):  # noqa: F811
    w = team
    job, _, _ = world(api, worker, w, tmp_path)
    configure(api, w, w.manager)
    for who in (w.editor, w.editor2):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            as_(api, w, who, "select pulse.coach_request_open(%s,%s)", (job, w.outsider))
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="Someone else"):
        call(api, w, w.lead, "coach_request_open", job, w.lead)
    o = call(api, w, w.lead, "coach_request_open", job, w.outsider)
    assert (o["provider"], o["timeoutMs"], o["maxSuggestions"]) == ("stub", 3000, 3)
    rid = o["id"]
    good = [{"kind": "ask_check", "text": "Synthetic: ask them to check shoot direction", "cites": ["e2"]},
            {"kind": "record_work", "text": "Synthetic: recent editing work would update it", "cites": ["e1", "e2"]}]
    # The answer is checked again in the database: who records it, citations, kinds, fields and number.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        finish(api, w, w.manager, rid, suggestions=good)
    for bad in ([{**good[0], "cites": ["e9"]}], [{**good[0], "cites": []}], [{**good[0], "kind": "reject"}], [{**good[0], "kind": "promote"}],
                [{**good[0], "score": 0.92}], [{"kind": "verify", "text": "Synthetic"}], good + good):
        with pytest.raises(psycopg.errors.InvalidParameterValue):
            finish(api, w, w.lead, rid, suggestions=bad)
    with pytest.raises(psycopg.errors.CheckViolation):
        finish(api, w, w.lead, rid, suggestions=[{**good[0], "text": "x" * 301}])
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        finish(api, w, w.lead, rid, status="timed_out", suggestions=good)
    finish(api, w, w.lead, rid, suggestions=good)
    with pytest.raises(psycopg.errors.UniqueViolation):
        finish(api, w, w.lead, rid, status="timed_out")
    r = call(api, w, w.manager, "coach_request_read", rid)
    assert (r["status"], r["fallback"], r["automated"], r["provider"], r["providerVersion"], r["subject"], r["by"], r["job"]) == (
        "answered", None, True, "stub", "stub-1", "Pod Two Outsider", "Project Lead", "Synthetic launch editor")
    assert [(s["kind"], s["cites"], [c["id"] for c in s["cited"]], s["decision"]) for s in r["suggestions"]] == [
        ("ask_check", ["e2"], ["e2"], None), ("record_work", ["e1", "e2"], ["e1", "e2"], None)]
    assert r["suggestions"][0]["cited"][0]["requirement"]["skill"] == "Model shoot direction"
    with owner.transaction():
        set_tenant(owner, w.org)
        assert owner.execute("select encode(sha256(convert_to(evidence::text,'UTF8')),'hex') = evidence_hash ok from pulse.coach_request where id=%s", (rid,)).fetchone()["ok"]

    # Decisions: HR and admins, with a reason; once; never about themselves. Nothing else in Pulse changes.
    before = counts(owner, w)
    s1, s2 = (s["id"] for s in r["suggestions"])
    for who in (w.editor, w.editor2, w.outsider):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            as_(api, w, who, "select pulse.coach_decide(%s,'accepted','Synthetic')", (s1,))
    for decision, note in (("maybe", "Synthetic"), ("accepted", ""), (None, "Synthetic")):
        with pytest.raises(psycopg.errors.InvalidParameterValue):
            as_(api, w, w.lead, "select pulse.coach_decide(%s,%s,%s)", (s1, decision, note))
    as_(api, w, w.lead, "select pulse.coach_decide(%s,'accepted','Synthetic: I will ask them')", (s1,))
    with pytest.raises(psycopg.errors.UniqueViolation):
        as_(api, w, w.manager, "select pulse.coach_decide(%s,'rejected','Synthetic: no')", (s1,))
    as_(api, w, w.manager, "select pulse.coach_decide(%s,'rejected','Synthetic: not useful')", (s2,))
    assert counts(owner, w) == before
    r = call(api, w, w.lead, "coach_request_read", rid)
    assert [(s["decision"]["decision"], s["decision"]["by"], s["decision"]["note"]) for s in r["suggestions"]] == [
        ("accepted", "Project Lead", "Synthetic: I will ask them"), ("rejected", "Pod Manager", "Synthetic: not useful")]
    # A suggestion about an admin is decided by someone else.
    about_admin = call(api, w, w.lead, "coach_request_open", job, w.manager)["id"]
    finish(api, w, w.lead, about_admin, suggestions=[{"kind": "verify", "text": "Synthetic: verify it", "cites": ["e1"]}])
    sid = call(api, w, w.lead, "coach_request_read", about_admin)["suggestions"][0]["id"]
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="Someone else"):
        as_(api, w, w.manager, "select pulse.coach_decide(%s,'accepted','Synthetic: me')", (sid,))
    listed = call(api, w, w.manager, "coach_requests", job)
    assert [(x["subject"], x["status"], x["suggestions"], x["accepted"], x["rejected"]) for x in listed] == [
        ("Pod Manager", "answered", 1, 0, 0), ("Pod Two Outsider", "answered", 2, 1, 1)]
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor, "select pulse.coach_requests(null)")


def test_timeouts_and_failures_fall_back_to_the_explanation(api, worker, owner, team, tmp_path):  # noqa: F811
    w = team
    job, _, _ = world(api, worker, w, tmp_path)
    configure(api, w, w.manager)
    late = call(api, w, w.lead, "coach_request_open", job, w.editor)["id"]
    finish(api, w, w.lead, late, status="timed_out")
    r = call(api, w, w.lead, "coach_request_read", late)
    assert (r["status"], r["fallback"], r["suggestions"], r["failure"]) == ("timed_out", "explanation", [], None)
    assert [e["outcome"] for e in r["evidence"]["evidence"]] == ["matched", "matched", "matched", "unknown", "unknown"]
    broken = call(api, w, w.lead, "coach_request_open", job, w.editor)["id"]
    finish(api, w, w.lead, broken, status="failed", failure="citation")
    assert [call(api, w, w.lead, "coach_request_read", broken)[k] for k in ("status", "failure", "fallback")] == ["failed", "citation", "explanation"]
    # A request that never finished reads as timed out once its timeout (and a minute's grace) has passed.
    stuck = call(api, w, w.lead, "coach_request_open", job, w.outsider)["id"]
    assert call(api, w, w.lead, "coach_request_read", stuck)["status"] == "pending"
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("update pulse.coach_request set requested_at = now() - interval '2 minutes' where id=%s", (stuck,))
    assert [call(api, w, w.lead, "coach_request_read", stuck)[k] for k in ("status", "fallback")] == ["timed_out", "explanation"]
    assert [x["status"] for x in call(api, w, w.lead, "coach_requests", job)] == ["failed", "timed_out", "timed_out"]


def test_http_contract_roles_timeouts_and_decisions(worker, owner, api, team, tmp_path):  # noqa: F811
    """services/api/test/coach-runner.mjs: the same rules over HTTP with real password sessions, the server switch, the
    stub, a provider that is late or cites what it was not given."""
    w = team
    job, _, _ = world(api, worker, w, tmp_path)
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        for pid in (w.manager, w.editor, w.editor2, w.lead, w.outsider):
            api.execute("select pulse.login_issue(%s,'Synthetic-issued-2026!')", (pid,))
    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    ids = {"job": str(job), "editor": str(w.editor), "outsider": str(w.outsider), "hr": str(w.lead), "admin": str(w.manager)}
    env = {k: v for k, v in os.environ.items() if k != "PULSE_COACH"}
    proc = subprocess.run(["node", "test/coach-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api",
                          env={**env, "TEST_API_CONFIG": json.dumps(config), "PULSE_ORG_ID": str(w.org), "TEST_IDS": json.dumps(ids)},
                          capture_output=True, text=True, timeout=120, check=False)
    assert proc.returncode == 0, proc.stderr + proc.stdout
