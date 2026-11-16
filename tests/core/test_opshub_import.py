"""Ops Hub import acceptance: synthetic data, actual worker permissions and RLS."""

import copy
import json
from datetime import datetime, timezone
from pathlib import Path

import psycopg
import pytest
from helpers import build_world
from pulse_sdk.db import set_tenant
from pulse_workers import opshub_import as imp

FIXTURE = Path(__file__).resolve().parents[2] / "services/workers/tests/fixtures/opshub-synthetic.json"
ALIASES = {"Editor One": ["Marin Example"], "Project Lead": ["Lio Example"]}
TABLES = (*imp.TABLE_KEYS, "person", "source_observation", "import_batch", "audit_event")


@pytest.fixture
def source():
    return imp.read_source(FIXTURE)


@pytest.fixture
def world(worker, owner, api):
    w = build_world(worker, owner, api)
    with worker.transaction():
        set_tenant(worker, w.org)
        # EA is the intentionally permitted slug; release it after each independent test.
        worker.execute("update pulse.org set slug='ea' where id=%s", (w.org,))
    yield w
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.org set slug=%s where id=%s", ("synthetic-" + str(w.org), w.org))


def snapshot(c, org):
    with c.transaction():
        set_tenant(c, org)
        return {t: c.execute(f"select to_jsonb(t) row from pulse.{t} t where org_id=%s order by to_jsonb(t)::text", (org,)).fetchall() for t in TABLES}


def test_view_is_pure_and_ports_page_rules(source):
    original = copy.deepcopy(source["ea_clients"][0]["data"])
    view = imp.opshub_view(original)
    assert source["ea_clients"][0]["data"] == original
    tasks = {t["id"]: t for t in view["deliverables"]}
    assert tasks["synthetic-vov"]["targetStart"] == "2026-09-07"
    assert tasks["synthetic-vov"]["name"] == "High-Conversion VOV Ads #1 - script"
    assert tasks["synthetic-nurture"]["phase"] == "Phase 3"
    assert "synthetic-retired" not in tasks
    assert len([k for k in tasks if k.startswith("d-mig-")]) == 3
    assert imp.opshub_view(view) == view
    assert "pin" not in json.dumps(source) and "contactNumber" not in json.dumps(source)
    assert imp.canonize("Model-Led Walkthrough - shoot scheduled") == "Model-Led Walkthrough Video - shoot completed"
    assert imp.canonize("Model-Led #3 shoot day scheduled") == "Model-Led Video Ads #3 - shoot completed (+ B-roll)"
    c = {"onboardingDate": "2026-01-01", "deliverables": [
        {"id": "a", "name": "Brand alignment check", "status": "open"},
        {"id": "b", "name": "Brand Alignment™", "status": "done"},
        {"id": "c", "name": "Film shoot completed", "ownerRole": "Videographer"},
        *[{"id": str(i), "name": n} for i, n in enumerate(("Sales Enablement - training framework", "Site Visit Acceleration - follow-up optimization", "Project Blueprint™ handoff", "Pod briefing"))],
    ]}
    tasks = imp.opshub_view(c)["deliverables"]
    assert next(t for t in tasks if t["name"] == "Brand Alignment™")["id"] == "b"
    assert next(t for t in tasks if t["id"] == "c")["ownerRole"] == "Project Coordinator"
    assert len(tasks) == 5


def test_dry_run_writes_nothing_and_apply_replays(worker, world, source):
    before = snapshot(worker, world.org)
    dry = imp.run(worker, world.org, source, aliases=ALIASES)
    assert snapshot(worker, world.org) == before
    assert dry["counts"]["tasks_insert"] == 8
    first = imp.run(worker, world.org, source, apply=True, aliases=ALIASES)
    assert first["counts"] == dry["counts"]
    second = imp.run(worker, world.org, source, apply=True, aliases=ALIASES)
    assert second["batch_id"] != first["batch_id"]
    assert second["counts"]["tasks_unchanged"] == 8
    assert second["counts"]["tasks_update"] == second["counts"]["tasks_insert"] == 0
    after = snapshot(worker, world.org)
    assert after["person"] == before["person"]
    assert first["counts"]["members_unmatched"] == first["counts"]["tasks_unassigned"] == 1
    assert first["counts"]["dates_due_before_start"] == first["counts"]["dates_done_without_date"] == 1
    with worker.transaction():
        set_tenant(worker, world.org)
        row = worker.execute("select owner_id from pulse.task where source_key='opshub:synthetic-client/synthetic-unknown'").fetchone()
        assert row["owner_id"] is None
        task = worker.execute("select due_at,work_on from pulse.task where source_key='opshub:synthetic-client/synthetic-vov'").fetchone()
        assert task["due_at"] == datetime(2026, 9, 9, 18, 30, tzinfo=timezone.utc)
        ledger = worker.execute("select payload from pulse.source_observation where import_id=%s order by source_key", (first["batch_id"],)).fetchall()
        assert all(x["payload"]["before"] is None for x in ledger)
        assert {x["payload"]["table"] for x in ledger} == set(imp.TABLE_KEYS)
        assert worker.execute("select count(*) n from pulse.source_observation where import_id=%s", (second["batch_id"],)).fetchone()["n"] == 0


def test_reuse_fill_only_locks_and_before_values(worker, world, source):
    with worker.transaction():
        set_tenant(worker, world.org)
        worker.execute("update pulse.project set title='Fictional Orchard',location=null,segment='keep',locked=array['location'] where id=%s", (world.project,))
    result = imp.run(worker, world.org, source, apply=True, aliases=ALIASES)
    assert result["counts"]["projects_reused"] == 1
    with worker.transaction():
        set_tenant(worker, world.org)
        project = worker.execute("select location,segment,client_id from pulse.project where id=%s", (world.project,)).fetchone()
        assert project["location"] is None and project["segment"] == "keep" and project["client_id"]
        before = worker.execute("select payload from pulse.source_observation where import_id=%s and payload->>'table'='project'", (result["batch_id"],)).fetchone()["payload"]["before"]
        assert before["client_id"] is None and before["segment"] == "keep"
        worker.execute("update pulse.task set title='Keep title',status='in_progress',owner_id=%s,assignee_person_id=%s,locked=array['title','status','owner_id','due_at'] where source_key='opshub:synthetic-client/synthetic-vov'", (world.editor2, world.editor2))
    source["ea_clients"][0]["data"]["deliverables"][0].update(status="done", completionDate="2026-09-15", targetEnd="2026-09-20")
    imp.run(worker, world.org, source, apply=True, aliases=ALIASES)
    with worker.transaction():
        set_tenant(worker, world.org)
        task = worker.execute("select title,status,owner_id,assignee_person_id,done_at from pulse.task where source_key='opshub:synthetic-client/synthetic-vov'").fetchone()
        assert task == dict(title="Keep title", status="in_progress", owner_id=world.editor2, assignee_person_id=world.editor2, done_at=None)


def test_ambiguous_project_skipped(worker, world, source):
    with worker.transaction():
        set_tenant(worker, world.org)
        worker.execute("update pulse.project set title='Fictional Orchard' where id=%s", (world.project,))
        worker.execute("insert into pulse.project(org_id,registry_no,name) values(%s,999999,'Fictional Orchard')", (world.org,))
    result = imp.run(worker, world.org, source, apply=True, aliases=ALIASES)
    assert result["counts"]["projects_ambiguous"] == result["counts"]["projects_skipped"] == 1
    assert result["counts"]["tasks_insert"] == 0


def test_non_ea_refused_and_failed_apply_is_atomic(worker, owner, api, world, source):
    other = build_world(worker, owner, api)
    with pytest.raises(ValueError, match="organisation refused"):
        imp.run(worker, other.org, source, apply=True, aliases=ALIASES)
    before = snapshot(worker, world.org)
    source["ea_clients"][0]["data"]["deliverables"][0]["name"] = "x" * 100000
    # A failure after earlier inserts rolls the whole batch and ledger back.
    source["ea_clients"][0]["data"]["pod"] = "x" * 81
    with pytest.raises(psycopg.errors.CheckViolation):
        imp.run(worker, world.org, source, apply=True, aliases=ALIASES)
    assert snapshot(worker, world.org) == before


def test_http_only_get_and_secrets_dropped(monkeypatch):
    seen = []
    class Response:
        def __enter__(self):
            import io
            return io.StringIO('[{"data":{"pin":"synthetic","contactNumber":"synthetic","keep":1}}]')
        def __exit__(self, *args):
            pass
    class Opener:
        def open(self, request, timeout):
            seen.append((request.get_method(), request.full_url))
            return Response()
    monkeypatch.setattr(imp, "build_opener", lambda *args: Opener())
    for verb in ("POST", "PATCH", "PUT", "DELETE", "HEAD"):
        with pytest.raises(ValueError):
            imp.http_source("https://synthetic.invalid", "synthetic-key", method=verb)
    monkeypatch.delenv("PULSE_OPSHUB_DATABASE_URL", raising=False)
    monkeypatch.setenv("PULSE_OPSHUB_SUPABASE_URL", "https://synthetic.invalid")
    monkeypatch.setenv("PULSE_OPSHUB_SUPABASE_KEY", "synthetic-key")
    assert imp.read_source()["ea_team"] == [{"data": {"keep": 1}}]
    assert seen == [("GET", "https://synthetic.invalid/rest/v1/ea_clients?select=id,data"), ("GET", "https://synthetic.invalid/rest/v1/ea_team?select=data&id=eq.team")]
    with pytest.raises(ValueError):
        imp.NoRedirect().redirect_request(None)


def test_source_db_is_read_only_and_exact_queries(monkeypatch):
    queries = []
    class SourceDB:
        def __enter__(self):
            return self
        def __exit__(self, *args):
            pass
        def execute(self, query):
            queries.append(query)
            return self
        def fetchall(self):
            return [{"data": {"pin": "synthetic", "contactNumber": "synthetic", "keep": 1}}]
    def connection(url, **kwargs):
        assert url == "synthetic-db" and kwargs == {"options": "-c default_transaction_read_only=on"}
        return SourceDB()
    monkeypatch.setenv("PULSE_OPSHUB_DATABASE_URL", "synthetic-db")
    monkeypatch.setattr(imp, "connect", connection)
    assert imp.read_source()["ea_clients"] == [{"data": {"keep": 1}}]
    assert queries == ["select id,data from public.ea_clients", "select data from public.ea_team where id='team'"]


def test_owner_precedence_and_ambiguity(source):
    client = source["ea_clients"][0]["data"]
    team = source["ea_team"][0]["data"]
    assert imp.owner_member(dict(status="done", completedById="synthetic-editor", ownerRole=imp.PGS), client, team) == "synthetic-editor"
    assert imp.owner_member(dict(ownerRole=imp.PGS), client, team) == "synthetic-pm"
    assert imp.owner_member(dict(ownerRole="Video Editor"), client, team) == "synthetic-editor"
    team.append(dict(id="synthetic-founder", name="Synthetic Founder", role="Co-founder", pod="All"))
    assert imp.owner_member(dict(ownerRole="Video Editor"), client, team) == "synthetic-editor"
    assert imp.owner_member(dict(ownerRole="SME"), client, team) is None
    team.append(dict(id="second", name="Synthetic Second", role="Video Editor", pod="Shared"))
    assert imp.owner_member(dict(ownerRole="Video Editor"), client, team) is None


def test_cli_never_echoes_source_errors_or_arguments(monkeypatch, capsys):
    monkeypatch.setattr("sys.argv", ["opshub_import", "--dry-run", "--file", "synthetic.json"])
    def fail(*args):
        raise RuntimeError("https://synthetic.invalid/private?key=synthetic-key")
    monkeypatch.setattr(imp, "read_source", fail)
    with pytest.raises(SystemExit):
        imp.main()
    assert capsys.readouterr().err == '{"error": "RuntimeError"}\n'
    monkeypatch.setattr("sys.argv", ["opshub_import", "--bad=https://synthetic.invalid/secret"])
    with pytest.raises(SystemExit):
        imp.main()
    assert capsys.readouterr().err == '{"error": "ValueError"}\n'
