"""DOCS-POLISH: the reading view and "Make this doc richer" end to end on a disposable synthetic company
(services/api/test/docs-polish-runner.mjs). Always: a Markdown report imported as the Docs page imports it, the upgrades
offered from what it already says (chart, big numbers, timeline, flow diagram, toggle, Indian amounts; a words-only table
kept), nothing for a colleague who cannot see it, applying as its own History version that one Restore undoes, a stale
look refused, the empty doc's templates. With PULSE_AUTH_BROWSER=1 the same in a real browser at 1440 (light) and 363
(dark), before and after, the PDF and the "+" block menu; screenshots go to DOCS_POLISH_SHOTS. Nothing is sent anywhere."""
import json
import os
import subprocess
from pathlib import Path

from conftest import dsn
from psycopg.conninfo import conninfo_to_dict
from test_agent_ui_browser import install_org
from test_hr_suite import ADMIN
from test_tasks_rt1 import team  # noqa: F401  (a fixture)


def test_docs_polish(api, worker, owner, team, tmp_path):  # noqa: F811
    w = team
    was = install_org(owner, w.org)

    def config(value):
        data = conninfo_to_dict(value)
        data["database"] = data.pop("dbname")
        return json.dumps(data)

    report = tmp_path / "docs-polish.json"
    env = {**os.environ, "PULSE_CI": "1", "PULSE_PUBLIC_LOGIN_ENABLED": "0", "TEST_API_CONFIG": config(dsn("api")),
           "TEST_ADMIN_EMAIL": ADMIN, "TEST_MEMBER_EMAIL": w.editor_handle, "DOCS_POLISH_REPORT": str(report)}
    root = Path(__file__).resolve().parents[2]
    try:
        result = subprocess.run(["node", "test/docs-polish-runner.mjs"], cwd=root / "services/api", env=env, capture_output=True, text=True, timeout=2400)
    finally:
        if was:
            install_org(owner, was)
    assert result.returncode == 0, (result.stderr + result.stdout)[-6500:]
    data = json.loads(report.read_text())
    assert data["apiChecks"] >= 25
    if os.environ.get("PULSE_AUTH_BROWSER") == "1":
        assert data["browserChecks"] >= 30
