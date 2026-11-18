"""Stopgap project discovery reuses accepted ids/rules without deleting records or changing manual bindings."""
from helpers import FOLDER_RULES, build_world, read_as
import pytest
from psycopg.types.json import Jsonb
from pulse_gdrive_snapshot.backfill import FOLDER_MIME
from pulse_gdrive_snapshot.refresh import refresh_projects
from pulse_sdk.db import set_tenant


class Rows:
    def __init__(self, rows):
        self.rows = rows

    def fetchall(self):
        return self.rows

    def __iter__(self):
        return iter(self.rows)


class MetadataIndex:
    def __init__(self, paths):
        self.rows = [{"id": f"folder-{n}", "name": path.split('/')[-1], "parents": [],
                      "path": path, "mime": FOLDER_MIME} for n, path in enumerate(paths)]

    def execute(self, sql, params=()):
        assert sql.startswith('select ') and 'drive_file' in sql
        assert 'drive_text' not in sql
        return Rows(self.rows)


def test_project_stopgap_replays_preserves_locks_and_never_removes_missing_projects(worker, owner, api):
    world = build_world(worker, owner, api)
    root = 'My Drive/Client Video Shoot/2026/October/Synthetic New Project'
    with worker.transaction():
        set_tenant(worker, world.org)
        worker.execute("insert into pulse.tenant_config(org_id,doc_kind,doc_key,version,body,is_active) "
                       "values(%s,'folder_rules','synthetic-refresh',1,%s,true)", (world.org, Jsonb(FOLDER_RULES)))
        worker.execute("update pulse.project set name='Manual project',locked=array['name','client_id'],client_id=null "
                       "where id=%s", (world.project,))
    before = read_as(worker, world.org, 'select id from pulse.project')
    people_before = read_as(worker, world.org, 'select id from pulse.person order by id')
    index = MetadataIndex([root, root + '/Final Videos', 'My Drive/EA Team Member Details/Private'])
    first = refresh_projects(index, worker, world.org)
    assert first['new_projects'] == 1
    second = refresh_projects(index, worker, world.org)
    assert second['new_projects'] == 0
    assert len(read_as(worker, world.org, 'select id from pulse.project')) == len(before) + 1
    original = read_as(worker, world.org, 'select name,client_id from pulse.project where id=%s', (world.project,))[0]
    assert original == {'name': 'Manual project', 'client_id': None}
    refresh_projects(MetadataIndex([]), worker, world.org)
    assert len(read_as(worker, world.org, 'select id from pulse.project')) == len(before) + 1
    assert read_as(worker, world.org, 'select id from pulse.person order by id') == people_before


def test_legacy_rules_without_project_paths_fail_before_any_project_change(worker, owner, api):
    world = build_world(worker, owner, api)
    with worker.transaction():
        set_tenant(worker, world.org)
        worker.execute("update pulse.tenant_config set body=body-'project_paths' where doc_kind='folder_rules'")
    before = read_as(worker, world.org, 'select id,kind,client_id from pulse.project order by id')
    with pytest.raises(RuntimeError, match='project-path rules are missing'):
        refresh_projects(MetadataIndex([]), worker, world.org)
    assert read_as(worker, world.org, 'select id,kind,client_id from pulse.project order by id') == before
