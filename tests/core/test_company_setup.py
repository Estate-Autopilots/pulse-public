"""ONBOARD-CONFIG (owner, 13 Nov 2026, G3 T3.1.2): a fresh company set up from a transcript with the real `pulse` CLI
(`pulse setup plan --from <file> --class private`, apply --dry-run, apply, apply again) and over MCP, on real tenant
row security (services/api/test/company-setup-runner.mjs). Leadership and admins only; a key without docs.write is
refused; a private source lands in a folder open only to the person who ran it. Synthetic company and words only;
SETUP_SOURCE (outside CI) names another transcript for a timed proof in this throwaway database."""
import hashlib
import json
import os
import secrets
import subprocess
from pathlib import Path

from conftest import dsn
from helpers import build_world
from psycopg.conninfo import conninfo_to_dict
from pulse_sdk.db import set_tenant

ALL = ["tasks.read", "tasks.write", "projects.read", "projects.write", "people.read", "docs.read", "docs.write", "workflows.read", "workflows.write"]


def token(api, org, person, scopes, label):
    t = "ppt_" + secrets.token_urlsafe(32)[:43]
    with api.transaction():
        set_tenant(api, org, person)
        api.execute("select pulse.api_token_issue('personal',%s,%s,30,null,%s)", (label, scopes, hashlib.sha256(t.encode()).hexdigest()))
    return t


def test_a_fresh_company_set_up_from_a_transcript(api, worker, owner):
    w = build_world(worker, owner, api)
    with worker.transaction():
        set_tenant(worker, w.org)
        # A company's owner: an admin (teams) and leadership (projects and company goals), as the setup needs both.
        for role in ("admin", "leadership"):
            worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,%s,'2026-01-01')", (w.org, w.manager, role))
    admin = token(api, w.org, w.manager, ALL, "Setup admin")
    narrow = token(api, w.org, w.manager, ["workflows.read", "workflows.write", "projects.read", "projects.write"], "No docs")
    editor = token(api, w.org, w.editor, ALL, "Editor")
    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    env = {**os.environ, "PULSE_CI": "1", "PULSE_PUBLIC_LOGIN_ENABLED": "0", "PULSE_PUBLIC_URL": "https://pulse.synthetic.example", "TEST_API_CONFIG": json.dumps(config),
           "TEST_W": json.dumps({"org": str(w.org), "admin": admin, "narrow": narrow, "editorToken": editor, "editorId": str(w.editor), "adminId": str(w.manager)})}
    root = Path(__file__).resolve().parents[2]
    # LAND-CAPTAIN-12 (hosted CI: "Cannot find module packages/pulse-cli/dist/cli.js"): the runner drives the real
    # `pulse` CLI, and a database cell builds only the API, so the CLI is built here when it is not built yet.
    if not (root / "packages/pulse-cli/dist/cli.js").exists():
        b = subprocess.run(["corepack", "pnpm", "--dir", "packages/pulse-cli", "run", "build"], cwd=root, capture_output=True, text=True, timeout=600, check=False)
        assert b.returncode == 0, (b.stderr + b.stdout)[-4000:]
    p = subprocess.run(["node", "test/company-setup-runner.mjs"], cwd=root / "services/api", env=env, capture_output=True, text=True, timeout=900, check=False)
    assert p.returncode == 0, (p.stderr + p.stdout)[-8000:]
    out = json.loads([line for line in p.stdout.splitlines() if line.startswith('{"ok"')][-1])
    print(json.dumps(out))
    assert out["checks"] >= 20, out
    assert admin not in p.stdout + p.stderr, "a token never reaches the logs"
    with owner.transaction():
        set_tenant(owner, w.org)
        # One of each thing, once: apply ran twice and a dry run before it.
        assert owner.execute("select count(*) n from pulse.doc where org_id=%s and title='How we are set up'", (w.org,)).fetchone()["n"] == 1
        src = owner.execute("select d.access,f.access folder_access from pulse.doc d join pulse.doc_folder f on f.id=d.folder_id where d.org_id=%s and d.title like 'Source: %%'", (w.org,)).fetchall()
        assert [(r["access"], r["folder_access"]) for r in src] == [("private", "people")], src
        # Both applies are in the audit log (the dry run left none), by the source's sha256 only.
        runs = owner.execute("select resource_id,fields from pulse.audit_event where org_id=%s and resource='company_setup' order by at", (w.org,)).fetchall()
        assert len(runs) == 2 and runs[0]["resource_id"] == runs[1]["resource_id"] and len(runs[0]["resource_id"]) == 64, runs
        assert runs[0]["fields"][0] == f"class={os.environ.get('SETUP_CLASS', 'private')}" and runs[1]["fields"][1] == "made=0", runs
        if not os.environ.get("SETUP_SOURCE"):
            hist = owner.execute("select history from pulse.org_pack where org_id=%s", (w.org,)).fetchone()
            assert hist and sum(1 for h in hist["history"] if h.get("setup")) == 2, hist
            words = owner.execute("select words from pulse.org_pack where org_id=%s", (w.org,)).fetchone()["words"]
            assert (words["team"], words["head"], words["client"], words["project"], words["department"]) == ("Squad", "Captain", "Customer", "Campaign", "Department"), words
            assert owner.execute("select count(*) n from pulse.unit where org_id=%s and kind='department' and name in ('Creative','Performance')", (w.org,)).fetchone()["n"] == 2
            assert owner.execute("select count(*) n from pulse.flow_process where org_id=%s and status='draft'", (w.org,)).fetchone()["n"] >= 1
            goal = owner.execute("select id,target_on::text t from pulse.goal where org_id=%s and title='Sign 20 customers by 31 March 2027'", (w.org,)).fetchone()
            assert goal and goal["t"] == "2027-03-31"
            assert owner.execute("select count(*) n from pulse.goal_link where goal_id=%s", (goal["id"],)).fetchone()["n"] == 1
