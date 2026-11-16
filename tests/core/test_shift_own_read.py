"""POLISH-1: each person reads only their own shift (and the shift it names); writes stay with admins and HR.

Before 0163 the restrictive admin_write policy covered reads as well, so a person who is not admin or HR read no shift
and their daily brief ignored it (found by RELEASE-2)."""
import json
import os
import subprocess
import uuid
from pathlib import Path

import psycopg
import pytest
from conftest import dsn
from helpers import build_world
from psycopg.conninfo import conninfo_to_dict
from pulse_sdk.db import set_tenant


def config(role):
    c = conninfo_to_dict(dsn(role))
    c['database'] = c.pop('dbname')
    return c


def _world(worker, owner, api):
    w = build_world(worker, owner, api)
    hr = uuid.uuid4()
    early, late = uuid.uuid4(), uuid.uuid4()
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,'Synthetic HR','staff')", (hr, w.org))
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'hr','2020-01-01')", (w.org, hr))
        worker.execute("""insert into pulse.account(org_id,provider,handle,holder_person_id,purpose)
                          values(%s,'google',%s,%s,'Workspace account')""", (w.org, f"staff@{w.domain}", w.editor))
        # Every day a working day, so the brief is due whatever day the suite runs.
        worker.execute("""insert into pulse.shift(org_id,id,name,start_time,end_time,work_days)
                          values(%s,%s,'Synthetic early','07:30','16:30','{1,2,3,4,5,6,7}'),(%s,%s,'Synthetic late','13:00','22:00','{1,2,3,4,5}')""",
                       (w.org, early, w.org, late))
        worker.execute("""insert into pulse.person_shift(org_id,person_id,shift_id,mode,valid_from)
                          values(%s,%s,%s,'office','2020-01-01'),(%s,%s,%s,'office','2020-01-01')""",
                       (w.org, w.editor, early, w.org, w.editor2, late))
    return w, hr, early, late


def test_a_person_reads_only_their_own_shift_and_hr_reads_all(worker, owner, api):
    w, hr, early, late = _world(worker, owner, api)
    with api.transaction():
        set_tenant(api, w.org, w.editor)
        assert [r["person_id"] for r in api.execute("select person_id from pulse.person_shift").fetchall()] == [w.editor]
        assert [r["id"] for r in api.execute("select id from pulse.shift").fetchall()] == [early]
    with api.transaction():
        set_tenant(api, w.org, w.manager)  # a pod manager: still only their own (none)
        assert api.execute("select count(*) n from pulse.person_shift").fetchone()["n"] == 0
        assert api.execute("select count(*) n from pulse.shift").fetchone()["n"] == 0
    with api.transaction():
        set_tenant(api, w.org, hr)
        assert api.execute("select count(*) n from pulse.person_shift").fetchone()["n"] == 2
        assert api.execute("select count(*) n from pulse.shift").fetchone()["n"] == 2


@pytest.mark.parametrize("sql", [
    "insert into pulse.shift(org_id,name,start_time,end_time) values(pulse.current_org(),'Synthetic own','08:00','12:00')",
    "update pulse.shift set start_time='06:00'",
    "delete from pulse.person_shift",
    "insert into pulse.person_shift(org_id,person_id,shift_id,valid_from) select org_id,person_id,shift_id,'2030-01-01' from pulse.person_shift",
])
def test_a_person_still_cannot_change_shifts(worker, owner, api, sql):
    w, _hr, _early, _late = _world(worker, owner, api)
    with api.transaction():
        set_tenant(api, w.org, w.editor)
        try:
            changed = api.execute(sql).rowcount
        except psycopg.errors.InsufficientPrivilege:
            changed = 0
        assert changed == 0
    with worker.transaction():
        set_tenant(worker, w.org)
        assert worker.execute("select count(*) n from pulse.person_shift").fetchone()["n"] == 2
        assert worker.execute("select start_time::text t from pulse.shift where name='Synthetic early'").fetchone()["t"] == "07:30:00"


def test_a_plain_staff_members_brief_follows_their_shift(worker, owner, api, tmp_path):
    w, _hr, _early, _late = _world(worker, owner, api)
    env = {**os.environ, 'TEST_API_CONFIG': json.dumps(config('api')), 'TEST_STAFF_EMAIL': f"staff@{w.domain}",
           'TEST_SHIFT': json.dumps({'start': '07:30', 'end': '16:30', 'days': [1, 2, 3, 4, 5, 6, 7]}),
           'TEST_REPORT': str(tmp_path / 'shift.json')}
    root = Path(__file__).resolve().parents[2]
    result = subprocess.run(['node', 'test/shift-read-runner.mjs'], cwd=root / 'services/api', env=env, text=True,
                            capture_output=True, timeout=120)
    assert result.returncode == 0, result.stdout + '\n' + result.stderr
    assert json.loads((tmp_path / 'shift.json').read_text())['checks'] == 3
