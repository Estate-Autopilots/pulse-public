"""TASKS-4A: creating work and finding it, in a browser on a production build, on a synthetic agency: + Create as the
one way to create, views everywhere with remembered and saved views, a person's page, a project's views and the
company's word for a team. Synthetic tenants only."""
import json
import os
import subprocess
from pathlib import Path

import pytest
from conftest import dsn
from test_tasks_rt1 import team  # noqa: F401  (fixture)
from test_tasks3 import _config, _seed_tasks3

BROWSER = pytest.mark.skipif(os.environ.get("PULSE_AUTH_BROWSER") != "1", reason="browser checks run in CI with PULSE_AUTH_BROWSER=1")


@BROWSER
def test_tasks4a_flows_in_the_browser(worker, owner, api, team, tmp_path):  # noqa: F811
    w = team
    ids = _seed_tasks3(api, worker, w)
    env = {**os.environ, "PULSE_CI": "1", "PULSE_PUBLIC_LOGIN_ENABLED": "0", "TEST_API_CONFIG": _config(dsn("api")), "TEST_MEMBER": w.editor_handle,
           "TEST_HEAD": f"editor2@{w.domain}", "TEST_OUTSIDER_EMAIL": f"outsider@{w.domain}", "TEST_DEV": f"dev@{w.domain}", "TEST_SANA": f"sana@{w.domain}",
           "TEST_IDS": json.dumps(ids), "PULSE_TASKS4A_REPORT": str(tmp_path / "tasks4a.json")}
    p = subprocess.run(["node", "test/tasks4a-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api", env=env, capture_output=True, text=True, timeout=2400, check=False)
    report = json.loads((tmp_path / "tasks4a.json").read_text()) if (tmp_path / "tasks4a.json").exists() else None
    assert p.returncode == 0 and report and not report["failed"], (p.stderr + p.stdout)[-8000:]


def test_view_preferences_are_each_persons_own(api, worker, team):  # noqa: F811
    """A person's view preferences and saved views are theirs alone: another person neither reads nor changes them, and
    "make it your default?" is asked once per view and place."""
    from pulse_sdk.db import set_tenant
    w = team
    with api.transaction():
        set_tenant(api, w.org, w.editor)
        api.execute("insert into pulse.work_view_pref(org_id,person_id,place,layout,uses) values(pulse.current_org(),%s,'company','table','{\"table\":{\"ms\":700000}}')", (w.editor,))
        api.execute("insert into pulse.work_saved_view(org_id,person_id,place,name,config) values(pulse.current_org(),%s,'company','Mine','{}')", (w.editor,))
    with api.transaction():
        set_tenant(api, w.org, w.editor2)
        assert api.execute("select count(*) n from pulse.work_view_pref").fetchone()["n"] == 0
        assert api.execute("select count(*) n from pulse.work_saved_view").fetchone()["n"] == 0
        assert api.execute("update pulse.work_saved_view set name='Theirs' returning id").fetchall() == []
        with pytest.raises(Exception):
            with api.transaction():
                api.execute("insert into pulse.work_saved_view(org_id,person_id,place,name,config) values(pulse.current_org(),%s,'company','Planted','{}')", (w.editor,))
    with api.transaction():
        set_tenant(api, w.org, w.editor)
        assert api.execute("select name from pulse.work_saved_view").fetchone()["name"] == "Mine"
    # The team word: one or two words, Pod by default.
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        assert api.execute("select pulse.work_settings_get()->>'teamLabel' t").fetchone()["t"] == "Pod"
        assert api.execute("select pulse.work_settings_set('{\"teamLabel\":\"squad\"}')->>'teamLabel' t").fetchone()["t"] == "Squad"
        with pytest.raises(Exception):
            with api.transaction():
                api.execute("select pulse.work_settings_set('{\"teamLabel\":\"x\"}')")
        api.execute("select pulse.work_settings_set('{\"teamLabel\":\"Pod\"}')")
