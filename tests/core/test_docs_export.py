"""DOCS-EXPORT: a doc downloads as PDF, Word (.docx) and Markdown for whoever may open it, and for nobody else
(services/api/test/docs-export-runner.mjs). Two disposable synthetic companies: this company's admin and a colleague,
and another company with a doc of its own that this company's admin must not get. Nothing is sent anywhere."""
import json
import os
import subprocess
from pathlib import Path

from conftest import dsn
from helpers import build_world
from psycopg.conninfo import conninfo_to_dict
from test_agent_ui_browser import install_org
from test_hr_suite import ADMIN
from test_tasks_rt1 import one, team  # noqa: F401  (team is a fixture)

DOC = "insert into pulse.doc(org_id,title,body_html,body_text,access,created_by) values(pulse.current_org(),%s,%s,'',%s,pulse.current_viewer()) returning id"


def test_docs_export(api, worker, owner, team, tmp_path):  # noqa: F811
    w = team
    other = build_world(worker, owner, api)
    # the other company's own doc, open to everyone in that company (made by its editor, under row security)
    foreign = one(api, other, other.editor, DOC, ("Other company's plan (synthetic)", "<p>Not yours</p>", "company"))["id"]
    was = install_org(owner, w.org)

    def config(value):
        data = conninfo_to_dict(value)
        data["database"] = data.pop("dbname")
        return json.dumps(data)

    report = tmp_path / "docs-export.json"
    env = {**os.environ, "PULSE_CI": "1", "PULSE_PUBLIC_LOGIN_ENABLED": "0", "TEST_API_CONFIG": config(dsn("api")),
           "TEST_ADMIN_EMAIL": ADMIN, "TEST_MEMBER_EMAIL": w.editor_handle, "TEST_MEMBER_ID": str(w.editor),
           "TEST_FOREIGN_DOC": str(foreign), "DOCS_EXPORT_REPORT": str(report)}
    root = Path(__file__).resolve().parents[2]
    try:
        result = subprocess.run(["node", "test/docs-export-runner.mjs"], cwd=root / "services/api", env=env, capture_output=True, text=True, timeout=600)
    finally:
        if was:
            install_org(owner, was)
    assert result.returncode == 0, (result.stderr + result.stdout)[-6500:]
    assert json.loads(report.read_text())["checks"] >= 20
