"""SOP-WORKFLOW on a disposable tenant with synthetic people and documents only: SOP sources handed over by the Drive
refresh, SOPs leadership makes and imports (versions, statuses), who reads what, and the API acceptance in
services/api/test/sop-runner.mjs (the library, From Drive, parse, save and status)."""
import json
import os
import subprocess
import uuid
from hashlib import sha256
from pathlib import Path

import psycopg
import pytest
from conftest import dsn
from helpers import build_world
from psycopg.conninfo import conninfo_to_dict
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant

ROOT = Path(__file__).resolve().parents[2]
TABLE = """Phase 1 — Project Start
Objective
Get the client ready before any work begins.
Step
\tPGS Tasks / Responsibility
\tKPIs
\t1. Internal Handover
\t• Review the package and the sales notes.• Ensure required brochures, logos and floor plans are available.
\t• Handover reviewed before the call.
\t2. Client Kick-off Call
\t• Run the kick-off call within 2 days of the handover.• Coordinate the research meeting with the Creative Strategist.
\t• Client knows who their contact is.
\t3. Brand Alignment
\t• Assign the Graphic Designer once positioning is clear.
\t• Brand alignment approved.
"""
LIST = "Client Visit Coordination – Process\n" + "\n".join(f"{i}. Visit step {i}\n   * The Coordinator does part {i} within 24 hours." for i in range(1, 6))


def world(worker, owner, api):
    w = build_world(worker, owner, api)
    people = {r: uuid.uuid4() for r in ['lead', 'admin', 'hr', 'pgs', 'pgs2', 'editor', 'member']}
    titles = {'lead': 'Co-founder / CEO', 'admin': 'Engineer', 'hr': 'HR', 'pgs': 'PGS', 'pgs2': 'Senior PGS', 'editor': 'Video Editor', 'member': 'Graphic Designer'}
    with worker.transaction():
        set_tenant(worker, w.org)
        for r, pid in people.items():
            worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,%s,'staff')", (pid, w.org, 'Synthetic ' + r.title()))
            worker.execute("insert into pulse.people_profile(org_id,person_id,role,pod,evidence) values(%s,%s,%s,'Pod 1','{}')", (w.org, pid, titles[r]))
            worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')", (w.org, f'{r}@{w.domain}', pid))
            if r in ('lead', 'admin', 'hr'):
                worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,%s,'2020-01-01')", (w.org, pid, {'lead': 'leadership'}.get(r, r)))
            if r == 'pgs':
                worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,unit_id,valid_from) values(%s,%s,'pgs',%s,'2020-01-01')", (w.org, pid, w.pod))
    return w, people


def capture(worker, org, items, complete=True):
    with worker.transaction():
        set_tenant(worker, org)
        return worker.execute("select pulse.sop_source_capture(%s) r", (Jsonb({"items": items, "complete": complete}),)).fetchone()["r"]


def item(file_id, name, body, score=0.8):
    return {"fileId": file_id, "name": name, "mime": "application/vnd.google-apps.document", "path": "My Drive/SOPs/" + name, "link": "https://docs.example/d/" + file_id,
            "ownerEmail": "ops@example.test", "modifiedAt": "2026-10-01T10:00:00Z", "textHash": sha256(body.encode()).hexdigest(), "body": body, "score": score, "reasons": ["The title says SOP"]}


def test_sop_sources_sops_and_who_reads_them(worker, owner, api):
    w, p = world(worker, owner, api)
    assert capture(worker, w.org, [item('d1', 'PGS Workflow', TABLE), item('d2', 'Visit SOP', LIST)]) == {"new": 2, "changed": 0, "gone": 0, "seen": 2}
    # The next refresh: one changed, one no longer found.
    r = capture(worker, w.org, [item('d1', 'PGS Workflow', TABLE + "\n\t4. Extra\n\t• More.\n\t• Done.\n")])
    assert r["changed"] == 1 and r["gone"] == 1
    with api.transaction():
        set_tenant(api, w.org, p['member'])
        assert api.execute("select count(*) n from pulse.sop_source").fetchone()["n"] == 0, "Drive sources are leadership's"
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            api.execute("select pulse.sop_save(null,%s)", (Jsonb({"title": "Mine", "doc": {"steps": []}}),))
    with api.transaction():
        set_tenant(api, w.org, p['lead'])
        src = api.execute("select id,status from pulse.sop_source where file_id='d1'").fetchone()
        doc = {"steps": [{"id": "s1", "title": "Handover", "role": "PGS"}, {"id": "s2", "title": "Design", "role": "Graphic Designer"}], "phases": [], "roles": [], "outputs": [], "watch": []}
        sid = api.execute("select pulse.sop_save(null,%s) id", (Jsonb({"title": "PGS Workflow", "doc": doc, "status": "draft", "sourceId": str(src["id"]), "confidence": 0.82}),)).fetchone()["id"]
        assert api.execute("select status,sop_id from pulse.sop_source where id=%s", (src["id"],)).fetchone() == {"status": "imported", "sop_id": sid}
        with pytest.raises(psycopg.errors.UniqueViolation):
            with api.transaction():
                api.execute("select pulse.sop_save(null,%s)", (Jsonb({"title": "PGS workflow", "doc": doc, "sourceId": str(src["id"])}),))
        # An edit that changes the steps is a new version; an active SOP needs a step.
        doc["steps"].append({"id": "s3", "title": "Launch", "role": "PGS"})
        api.execute("select pulse.sop_save(%s,%s)", (sid, Jsonb({"title": "PGS Workflow", "doc": doc, "status": "active", "note": "Added the launch"})))
        assert api.execute("select version,status,confirmed_by from pulse.sop where id=%s", (sid,)).fetchone() == {"version": 2, "status": "active", "confirmed_by": p['lead']}
        assert [r["version"] for r in api.execute("select version from pulse.sop_version where sop_id=%s order by version", (sid,)).fetchall()] == [1, 2]
        with pytest.raises(psycopg.errors.InvalidParameterValue):
            with api.transaction():
                api.execute("select pulse.sop_save(null,%s)", (Jsonb({"title": "Empty", "doc": {"steps": []}, "status": "active"}),))
        draft = api.execute("select pulse.sop_save(null,%s) id", (Jsonb({"title": "Draft only", "doc": {"steps": [{"id": "s1", "title": "One"}]}}),)).fetchone()["id"]
    # Members read active SOPs (and their versions), never drafts.
    with api.transaction():
        set_tenant(api, w.org, p['member'])
        assert [r["title"] for r in api.execute("select title from pulse.sop order by title").fetchall()] == ["PGS Workflow"]
        assert api.execute("select count(*) n from pulse.sop_version where sop_id=%s", (draft,)).fetchone()["n"] == 0
    with api.transaction():
        set_tenant(api, w.org, p['lead'])
        api.execute("select pulse.sop_set_status(%s,'archived')", (sid,))
        with pytest.raises(psycopg.errors.InvalidParameterValue):
            with api.transaction():
                api.execute("select pulse.sop_save(%s,%s)", (sid, Jsonb({"title": "PGS Workflow", "doc": doc})))
    with api.transaction():
        set_tenant(api, w.org, p['member'])
        assert api.execute("select count(*) n from pulse.sop").fetchone()["n"] == 0, "archived SOPs leave the library"
    with owner.transaction():
        set_tenant(owner, w.org)
        assert owner.execute("select count(*) n from pulse.audit_event where resource='sop' and action in ('create','update','archive')").fetchone()["n"] >= 4


def run_runner(name, w, p, tmp_path, extra=None, timeout=300):
    config = conninfo_to_dict(dsn('api')); config['database'] = config.pop('dbname')
    env = {**os.environ, 'TEST_API_CONFIG': json.dumps(config), 'PULSE_ORG_ID': str(w.org), 'TEST_DOMAIN': w.domain,
           'TEST_PEOPLE': json.dumps({r: str(x) for r, x in p.items()}), 'TEST_REPORT': str(tmp_path / f'{name}.json'), 'PULSE_CI': '1', **(extra or {})}
    result = subprocess.run(['node', f'test/{name}.mjs'], cwd=ROOT / 'services/api', env=env, text=True, capture_output=True, timeout=timeout)
    assert result.returncode == 0, (result.stdout + '\n' + result.stderr)[-6000:]
    return json.loads((tmp_path / f'{name}.json').read_text())


def test_sop_api(worker, owner, api, tmp_path):
    w, p = world(worker, owner, api)
    capture(worker, w.org, [item('d1', 'PGS Workflow & Responsibilities', TABLE), item('d2', 'Visit SOP', LIST, 0.6)])
    report = run_runner('sop-runner', w, p, tmp_path)
    assert report['checks'] >= 30


# A synthetic agency for the browser flows and the screenshots (~/ea-research/ux/sop/): made-up people in the roles an
# agency has, three SOPs (one with an approval that sends work back, one with a decision) and three Drive documents.
STAFF = [('kedab', 'Kedab Shah', 'Co-founder / CEO', 'Leadership', 'leadership'), ('admin', 'Dev Admin', 'Engineer', 'Tech', 'admin'), ('hr', 'Tara Pillai', 'HR', 'Shared', 'hr'),
         ('asha', 'Asha Rao', 'PGS', 'Pod 1', 'pgs'), ('vikram', 'Vikram Jivop', 'PGS', 'Pod 2', 'pgs'), ('meera', 'Meera Iyer', 'Creative strategist', 'Pod 1', None),
         ('kabir', 'Kabir Mifos', 'Graphic Designer', 'Pod 1', None), ('sana', 'Sana Qipedot', 'Social Media Executive', 'Pod 2', None),
         ('rifob', 'Rifob Desai', 'Performance Marketer', 'Pod 1', None), ('neha', 'Neha Kireteso', 'Project coordinator', 'Shared', None),
         ('ahoro', 'Ahoro Nair', 'Videographer', 'Shared', None), ('ishaan', 'Ishaan Gobap', 'Video Editor', 'Pod 2', None),
         ('ravi', 'Ravi Putig', 'Field Technician', 'Field', None), ('meena', 'Meena Jivop', 'Supervisor', 'Field', None)]


def demo_world(worker, owner, api):
    w = build_world(worker, owner, api)
    p = {}
    with worker.transaction():
        set_tenant(worker, w.org)
        for key, name, title, pod, role in STAFF:
            pid = uuid.uuid4(); p[key] = pid
            worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,%s,'staff')", (pid, w.org, name))
            worker.execute("insert into pulse.people_profile(org_id,person_id,role,pod,evidence) values(%s,%s,%s,%s,'{}')", (w.org, pid, title, pod))
            worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')", (w.org, f'{key}@{w.domain}', pid))
            if role:
                worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,unit_id,valid_from) values(%s,%s,%s,%s,'2020-01-01')", (w.org, pid, role, w.pod if role == 'pgs' else None))
    p['lead'], p['member'] = p['kedab'], p['kabir']
    S = lambda i, title, role, **kw: {"id": i, "title": title, "role": role, **kw}  # noqa: E731
    onboarding = {"steps": [
        S("s1", "Internal handover", "PGS", phase="Start", minutes=30, slaHours=24, inputs=["Package", "Sales notes"], outputs=["Handover notes"], detail="• Read the package and the sales notes\n• List what is missing before the call", kpis=["Handover read before the call"]),
        S("s2", "Kick-off call with the client", "PGS", phase="Start", minutes=60, slaHours=48, involves=["Client"], outputs=["Agreed timeline"], detail="• Introduce yourself as the client's strategist\n• Agree the timeline and who approves"),
        S("s3", "Research meeting", "Creative strategist", phase="Start", minutes=120, slaHours=72, involves=["PGS", "Client"], outputs=["Research notes"]),
        S("s4", "Write the project blueprint", "Creative strategist", phase="Blueprint", minutes=360, slaHours=96, inputs=["Research notes"], outputs=["Blueprint"]),
        S("s5", "Brand alignment", "Graphic Designer", phase="Blueprint", minutes=240, slaHours=72, inputs=["Logo files", "Brochure"], outputs=["Brand kit"], links=[{"label": "Brand kit template", "url": "https://docs.example/brand-kit"}]),
        S("s6", "Client approves the blueprint", "Client", phase="Blueprint", kind="approval", slaHours=48, next=[{"to": "s7", "label": "Approved"}, {"to": "s4", "label": "Send back"}]),
        S("s7", "Social media set-up", "Social Media Executive", phase="Launch", minutes=180, slaHours=48),
        S("s8", "Campaign goes live", "Performance Marketer", phase="Launch", minutes=90, slaHours=24, outputs=["Live campaign"])],
        "phases": ["Start", "Blueprint", "Launch"], "roles": [], "outputs": ["Blueprint", "Brand kit", "Live campaign"], "watch": ["Starting design before the blueprint is approved", "Missing logo files"]}
    shoot = {"steps": [
        S("a", "Is the sample flat ready?", "Project coordinator", kind="decision", next=[{"to": "b", "label": "Yes"}, {"to": "z", "label": "No"}]),
        S("b", "Shortlist two or three models", "Project coordinator", slaHours=24, outputs=["Model options"]),
        S("c", "Client picks the model", "Client", kind="approval"),
        S("d", "Shoot day", "Videographer", minutes=300, involves=["Model"], outputs=["Raw footage"]),
        S("e", "First cut", "Video Editor", minutes=480, slaHours=72, inputs=["Raw footage"], outputs=["First cut"], next=[]),
        S("z", "Reschedule with the client", "Project coordinator", kind="end")], "phases": [], "roles": [], "outputs": ["First cut"], "watch": []}
    report = {"steps": [S("r1", "Pull the month's numbers", "Performance Marketer"), S("r2", "Write the summary", "PGS"), S("r3", "Send to the client", "PGS")], "phases": [], "roles": [], "outputs": [], "watch": []}
    with api.transaction():
        set_tenant(api, w.org, p['kedab'])
        for title, purpose, doc, status in [("Client onboarding", "Start every client the same way, from the handover to the first live campaign.", onboarding, "active"),
                                            ("Shoot day", "From a ready sample flat to the first cut.", shoot, "active"), ("Monthly results report", None, report, "draft")]:
            api.execute("select pulse.sop_save(null,%s)", (Jsonb({"title": title, "purpose": purpose, "doc": doc, "status": status, "ownerRole": doc["steps"][0]["role"]}),))
    capture(worker, w.org, [item('d1', 'PGS Workflow & Responsibilities (synthetic)', TABLE), item('d2', 'Client Visit SOP (synthetic)', LIST, 0.62),
                            item('d3', 'Marketing SOPs (synthetic)', "SOP: Banner\n1. Objective\nThis SOP defines how banner work is assigned and approved.\nStep 1: Share the requirement\nThe PGS shares the folder link.\nStep 2: Prepare content first\nThe Intern prepares the headline.\nStep 3: PGS review\nThe PGS reviews and approves.\nSOP: Campaign\n#1: Select the objective\n#2: Name the campaign\n#3: Set the budget the PGS gives\n", 0.55)])
    return w, p


def test_workflow_api(worker, owner, api, tmp_path):
    w, p = demo_world(worker, owner, api)
    # Two Drive SOPs of one folder, numbered, for the workflow builder's "From SOPs" blocks.
    capture(worker, w.org, [item('d2', '#2 - Visit SOP', LIST), item('d1', '#1 - PGS Workflow', TABLE)])
    report = run_runner('workflow-runner', w, p, tmp_path, extra={'TEST_PROJECT': str(w.project)})
    assert report['checks'] >= 40


@pytest.mark.skipif(os.environ.get('PULSE_AUTH_BROWSER') != '1', reason='browser flows need PULSE_AUTH_BROWSER=1 and a built web app (or SOP_NEXT_DEV=1)')
def test_sop_in_the_browser(worker, owner, api, tmp_path):
    w, p = demo_world(worker, owner, api)
    report = run_runner('sop-browser', w, p, tmp_path, extra={'TEST_PROJECT': str(w.project)}, timeout=2400)
    assert not report['failed'], report


# --------------------------------------------------------------------------------------------- part 2: workflows and runs
def as_viewer(api, org, who):
    """A transaction as one person (context manager)."""
    tx = api.transaction(); tx.__enter__(); set_tenant(api, org, who); return tx


def make_workflow(api, org, lead, definition, trigger=None, name='Onboarding flow', publish=True):
    with api.transaction():
        set_tenant(api, org, lead)
        wid = api.execute("select pulse.workflow_save(null,%s) id", (Jsonb({"name": name, "definition": definition, "trigger": trigger or {"kind": "manual"}}),)).fetchone()["id"]
        if publish:
            api.execute("select pulse.workflow_publish(%s)", (wid,))
    return wid


def steps_of(api, org, who, run):
    with api.transaction():
        set_tenant(api, org, who)
        return {r["step_key"]: r for r in api.execute("""select s.step_key,s.status,s.outcome,s.rounds,s.task_id,s.assign_why,s.asked_id,t.assignee_person_id who,t.status task_status
            from pulse.workflow_run_step s left join pulse.task t on t.id=s.task_id where s.run_id=%s order by s.position""", (run,)).fetchall()}


def finish(api, org, who, task):
    with api.transaction():
        set_tenant(api, org, who)
        api.execute("select pulse.task_move(%s,'done')", (task,))


def test_workflow_runs_on_the_task_engine(worker, owner, api):
    w, p = world(worker, owner, api)
    definition = {"steps": [
        {"id": "brief", "title": "Brief the team", "role": "PGS", "slaHours": 24},
        {"id": "design", "title": "Design the creatives", "role": "Graphic Designer", "minutes": 240},
        {"id": "ok", "title": "Client approves", "kind": "approval", "role": "Client", "next": [{"to": "go", "label": "Approved"}, {"to": "design", "label": "Send back"}]},
        {"id": "go", "title": "Publish", "assign": {"by": "starter"}}]}
    wid = make_workflow(api, w.org, p['lead'], definition)
    # Members neither design nor start workflows.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        with api.transaction():
            set_tenant(api, w.org, p['member'])
            api.execute("select pulse.workflow_save(null,%s)", (Jsonb({"name": "x", "definition": {"steps": []}, "trigger": {"kind": "manual"}}),))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        with api.transaction():
            set_tenant(api, w.org, p['member'])
            api.execute("select pulse.workflow_start(%s,%s)", (wid, Jsonb({"projectId": str(w.project)})))
    with api.transaction():
        set_tenant(api, w.org, p['lead'])
        run = api.execute("select pulse.workflow_start(%s,%s) id", (wid, Jsonb({"projectId": str(w.project)}))).fetchone()["id"]
    s = steps_of(api, w.org, p['lead'], run)
    assert [s[k]["status"] for k in s] == ['active', 'waiting', 'waiting', 'waiting']
    assert s['brief']['who'] == p['pgs'] and s['brief']['assign_why'].startswith('Holds the role')
    with worker.transaction():
        set_tenant(worker, w.org)
        t = worker.execute("select source,project_id,due_at>now() due,created_by,category from pulse.task where id=%s", (s['brief']['task_id'],)).fetchone()
        assert t['source'] == 'workflow' and t['project_id'] == w.project and t['due'] and t['created_by'] == p['lead']
        assert worker.execute("select count(*) n from pulse.notification where person_id=%s and event_type='task.assigned'", (p['pgs'],)).fetchone()["n"] == 1
    # The PGS sees the run they have a step in; the designer does not, yet.
    with api.transaction():
        set_tenant(api, w.org, p['editor'])
        assert api.execute("select count(*) n from pulse.workflow_run").fetchone()["n"] == 0
    finish(api, w.org, p['pgs'], s['brief']['task_id'])
    s = steps_of(api, w.org, p['lead'], run)
    assert s['brief']['status'] == 'done' and s['design']['status'] == 'active' and s['design']['who'] == p['member']
    finish(api, w.org, p['member'], s['design']['task_id'])
    s = steps_of(api, w.org, p['lead'], run)
    assert s['ok']['status'] == 'active' and s['ok']['who'] == w.lead, "the client step is followed up by the project's owner"
    assert 'The client does this' in s['ok']['assign_why']
    # Send back: the designer gets it again (a second round), then approval moves on.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        with api.transaction():
            set_tenant(api, w.org, p['pgs'])
            api.execute("select pulse.workflow_step_decide((select id from pulse.workflow_run_step where run_id=%s and step_key='ok'),'Approved')", (run,))
    with pytest.raises(psycopg.errors.NoDataFound):
        with api.transaction():
            set_tenant(api, w.org, p['editor'])
            api.execute("select pulse.workflow_step_decide(%s,'Approved')", (s['ok']['task_id'],))
    with api.transaction():
        set_tenant(api, w.org, p['lead'])
        api.execute("select pulse.workflow_step_decide((select id from pulse.workflow_run_step where run_id=%s and step_key='ok'),'Send back','Logo too small')", (run,))
    s = steps_of(api, w.org, p['lead'], run)
    assert s['ok']['outcome'] == 'Send back' and s['design']['status'] == 'active' and s['design']['rounds'] == 2 and s['go']['status'] == 'waiting'
    finish(api, w.org, p['member'], s['design']['task_id'])
    with api.transaction():
        set_tenant(api, w.org, p['lead'])
        api.execute("select pulse.workflow_step_decide((select id from pulse.workflow_run_step where run_id=%s and step_key='ok'),'approved')", (run,))
    s = steps_of(api, w.org, p['lead'], run)
    assert s['ok']['outcome'] == 'Approved' and s['go']['status'] == 'active' and s['go']['who'] == p['lead']
    finish(api, w.org, p['lead'], s['go']['task_id'])
    with worker.transaction():
        set_tenant(worker, w.org)
        r = worker.execute("select status,finished_at is not null finished from pulse.workflow_run where id=%s", (run,)).fetchone()
        assert r == {"status": "done", "finished": True}
        assert worker.execute("select count(*) n from pulse.notification where event_type='workflow.done' and person_id=%s", (p['lead'],)).fetchone()["n"] == 1


def test_workflow_branches_joins_waits_late_and_triggers(worker, owner, api):
    w, p = world(worker, owner, api)
    # A decision on the run's values, and a join that waits for both branches.
    definition = {"steps": [
        {"id": "start", "title": "Survey", "assign": {"by": "starter"}, "next": [{"to": "a"}, {"to": "b"}]},
        {"id": "a", "title": "Order panels", "assign": {"by": "starter"}, "next": [{"to": "join"}]},
        {"id": "b", "title": "Book the crew", "assign": {"by": "starter"}, "next": [{"to": "join"}]},
        {"id": "join", "title": "Big job?", "kind": "decision", "join": "all", "next": [{"to": "big", "label": "Big", "when": {"field": "panels", "op": "gt", "value": 10}}, {"to": "small", "label": "Small"}]},
        {"id": "big", "title": "Site supervisor visit", "assign": {"by": "starter"}, "next": [{"to": "wait"}]},
        {"id": "small", "title": "Remote check", "assign": {"by": "starter"}, "next": [{"to": "wait"}]},
        {"id": "wait", "title": "Wait two days", "kind": "wait", "waitHours": 48},
        {"id": "end", "title": "Close", "kind": "end"}]}
    wid = make_workflow(api, w.org, p['lead'], definition, name='Install')
    with api.transaction():
        set_tenant(api, w.org, p['lead'])
        run = api.execute("select pulse.workflow_start(%s,%s) id", (wid, Jsonb({"projectId": str(w.project), "context": {"panels": 12}}))).fetchone()["id"]
    s = steps_of(api, w.org, p['lead'], run)
    finish(api, w.org, p['lead'], s['start']['task_id'])
    s = steps_of(api, w.org, p['lead'], run)
    assert s['a']['status'] == 'active' and s['b']['status'] == 'active', 'two branches at once'
    finish(api, w.org, p['lead'], s['a']['task_id'])
    assert steps_of(api, w.org, p['lead'], run)['join']['status'] == 'waiting', 'a join waits for every branch'
    finish(api, w.org, p['lead'], s['b']['task_id'])
    s = steps_of(api, w.org, p['lead'], run)
    assert s['join']['status'] == 'done' and s['join']['outcome'] == 'Big' and s['big']['status'] == 'active' and s['small']['status'] == 'skipped'
    finish(api, w.org, p['lead'], s['big']['task_id'])
    s = steps_of(api, w.org, p['lead'], run)
    assert s['wait']['status'] == 'active' and s['wait']['task_id'] is None
    with worker.transaction():
        set_tenant(worker, w.org)
        assert worker.execute("select pulse.workflow_tick(now()+interval '49 hours') r").fetchone()["r"]["waits"] == 1
    s = steps_of(api, w.org, p['lead'], run)
    assert s['wait']['status'] == 'done' and s['end']['status'] == 'done'
    with worker.transaction():
        set_tenant(worker, w.org)
        assert worker.execute("select status from pulse.workflow_run where id=%s", (run,)).fetchone()["status"] == 'done'

    # Past its SLA: the doer and whoever started it are told once.
    wid2 = make_workflow(api, w.org, p['lead'], {"steps": [{"id": "x", "title": "Call the client", "role": "PGS", "slaHours": 2}]}, name='Call back')
    with api.transaction():
        set_tenant(api, w.org, p['lead'])
        run2 = api.execute("select pulse.workflow_start(%s,'{}') id", (wid2,)).fetchone()["id"]
    with worker.transaction():
        set_tenant(worker, w.org)
        assert worker.execute("select pulse.workflow_tick(now()+interval '3 hours') r").fetchone()["r"]["late"] == 1
        assert worker.execute("select pulse.workflow_tick(now()+interval '4 hours') r").fetchone()["r"]["late"] == 0
        assert worker.execute("select count(*) n from pulse.notification where event_type='workflow.late' and subject_id=%s", (run2,)).fetchone()["n"] == 2
    # Stopping a run cancels its open task.
    with api.transaction():
        set_tenant(api, w.org, p['lead'])
        api.execute("select pulse.workflow_run_cancel(%s,'Client paused')", (run2,))
    s = steps_of(api, w.org, p['lead'], run2)
    assert s['x']['status'] == 'cancelled' and s['x']['task_status'] == 'cancelled'

    # A client package made in Pulse starts the package workflow (not an imported one).
    wid3 = make_workflow(api, w.org, p['lead'], {"steps": [{"id": "k", "title": "Kick-off", "role": "PGS"}]}, trigger={"kind": "package"}, name='Kick-off')
    with owner.transaction():
        set_tenant(owner, w.org, p['lead'])
        made = owner.execute("insert into pulse.project(org_id,registry_no,name,kind) values(%s,%s,'Synthetic Towers','client_work') returning id", (w.org, w.registry_no + 1)).fetchone()["id"]
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("insert into pulse.project(org_id,registry_no,name,kind) values(%s,%s,'Imported Heights','client_work')", (w.org, w.registry_no + 2))
        runs = owner.execute("select project_id,started_via from pulse.workflow_run where workflow_id=%s", (wid3,)).fetchall()
        assert runs == [{"project_id": made, "started_via": "package"}]
        # A schedule: weekly on Mondays at nine, India time.
        due = lambda last, now: owner.execute("select pulse.workflow_schedule_due(%s,%s::timestamptz,%s::timestamptz) d", (Jsonb({"every": "week", "weekday": 1, "at": "09:00"}), last, now)).fetchone()["d"]  # noqa: E731
        assert due(None, '2026-10-12 09:30+05:30') and not due('2026-10-12 09:31+05:30', '2026-10-13 10:00+05:30') and due('2026-10-12 09:31+05:30', '2026-10-19 09:00+05:30')
        assert not due(None, '2026-10-12 08:59+05:30') or due(None, '2026-10-12 08:59+05:30') == due(None, '2026-10-05 09:00+05:30')


def test_the_worker_ticks_workflows(worker, owner, api):
    """The worker's minute round (pulse-worker run) moves waits on and flags late steps for every tenant."""
    import pulse_workers.__main__ as M
    w, p = world(worker, owner, api)
    wid = make_workflow(api, w.org, p['lead'], {"steps": [{"id": "x", "title": "Wait an hour", "kind": "wait", "waitHours": 0.25}, {"id": "y", "title": "Then call", "role": "PGS"}]}, name='Tick')
    with api.transaction():
        set_tenant(api, w.org, p['lead'])
        run = api.execute("select pulse.workflow_start(%s,'{}') id", (wid,)).fetchone()["id"]
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("update pulse.workflow_run_step set due_at=now()-interval '1 minute' where run_id=%s and step_key='x'", (run,))
    M._run_workflow_tick(worker)
    s = steps_of(api, w.org, p['lead'], run)
    assert s['x']['status'] == 'done' and s['y']['status'] == 'active'


def test_field_forms(worker, owner, api, tmp_path):
    w, p = demo_world(worker, owner, api)
    report = run_runner('form-runner', w, p, tmp_path, extra={'TEST_PROJECT': str(w.project)})
    assert report['checks'] >= 45
    # Photos are bytes in the private schema, never readable by the API role directly.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        with api.transaction():
            set_tenant(api, w.org, p['kedab'])
            api.execute("select count(*) from pulse_priv.form_file")


def test_runs_overview(worker, owner, api, tmp_path):
    w, p = demo_world(worker, owner, api)
    late = make_workflow(api, w.org, p['kedab'], {"steps": [{"id": "c", "title": "Call the client", "assign": {"by": "person", "personId": str(p['asha'])}, "slaHours": 2}]}, name='Call back')
    nobody = make_workflow(api, w.org, p['kedab'], {"steps": [{"id": "x", "title": "Install the panels", "role": "Solar Installer"}]}, name='Install')
    done = make_workflow(api, w.org, p['kedab'], {"steps": [{"id": "b", "title": "Brief", "assign": {"by": "starter"}, "slaHours": 1}]}, name='Brief')
    with api.transaction():
        set_tenant(api, w.org, p['kedab'])
        start = lambda wid, proj=None: api.execute("select pulse.workflow_start(%s,%s) id", (wid, Jsonb({"projectId": str(proj) if proj else None}))).fetchone()["id"]  # noqa: E731
        late_run, stuck_run, done_run = start(late, w.project), start(nobody), start(done, w.project)
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("update pulse.workflow_run_step set due_at=now()-interval '3 hours',started_at=now()-interval '5 hours' where run_id=%s", (late_run,))
        owner.execute("update pulse.workflow_run_step set started_at=now()-interval '6 hours',late_at=now()-interval '5 hours' where run_id=%s", (done_run,))
    task = steps_of(api, w.org, p['kedab'], done_run)['b']['task_id']
    finish(api, w.org, p['kedab'], task)
    report = run_runner('runs-runner', w, p, tmp_path, extra={'TEST_SETUP': json.dumps({"lateRun": str(late_run), "stuckRun": str(stuck_run), "doneRun": str(done_run), "project": str(w.project)})})
    assert report['checks'] >= 10
