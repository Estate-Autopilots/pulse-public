"""Snapshot delivery facts replay identically and remain inside their tenant."""
from datetime import UTC, datetime
import uuid

from helpers import build_world, read_as, store
from psycopg.types.json import Jsonb
from pulse_gdrive_snapshot.backfill import drive_event
from pulse_rules.folder_rules import load
from pulse_sdk.db import set_tenant
from pulse_workers.deliveries import Deliveries, classify
from pulse_workers.projector import ProjectionRunner, fingerprint

RULES = [{"match": ".*final videos.*", "kind": "final"}, {"match": ".*drafts.*", "kind": "draft"}]


class RuleResult:
    def fetchall(self):
        return [{"doc_key": "synthetic", "version": 1, "body": {"schema_version": 1, "index_rules": RULES}}]


class RuleConnection:
    def execute(self, _sql, _params=()):
        return RuleResult()


def test_output_rules_exclude_raw_and_reference():
    rules = load(RuleConnection(), "synthetic-org")
    assert classify("Work/Final Videos/Hook.mp4", rules) == ("final", "final videos", "synthetic")
    assert classify("Work/Final Videos/Raw data/Hook.mp4", rules) is None
    assert classify("Work/Final Videos/Reference/Hook.mp4", rules) is None
    assert classify("Work/Drafts/Hook.mp4", rules) == ("draft", "drafts", "synthetic")


def test_delivery_replay_preserves_dates_accounts_and_isolation(worker, owner, api):
    w = build_world(worker, owner, api)
    root = "Client Video Shoot/2026/October/Synthetic Engagement"
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.project set storage_root=%s where id=%s", ("index-path:" + root, w.project))
        worker.execute("insert into pulse.tenant_config(org_id,doc_kind,doc_key,version,body,is_active) "
                       "values (%s,'folder_rules','ea-deliveries-v0',1,%s,true)", (w.org, Jsonb({"index_rules": RULES})))
    original = datetime(2026, 9, 20, 6, tzinfo=UTC)
    observed = datetime.now(UTC)
    row = {"id": "synthetic-index-final", "name": "Synthetic.mp4", "mime": "video/mp4", "parents": [],
           "path": root + "/Final Videos/Synthetic.mp4", "created": original, "modified": original,
           "modified_by": w.shared_handle}
    ev = drive_event(row, w.org, observed)
    assert store(worker, ev).status == "accepted"
    assert store(worker, ev).status == "duplicate"
    runner = ProjectionRunner(worker, Deliveries())
    runner.catch_up(w.org)
    result = read_as(api, w.org, "select * from pulse.delivery")
    assert len(result) == 1
    assert result[0]["delivered_at"] == original
    assert result[0]["uploader_account"] == w.shared_handle
    assert read_as(api, w.org, "select creator_person_id from pulse.version")[0]["creator_person_id"] is None
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.task(id,org_id,project_id,title,assignee_person_id) values (%s,%s,%s,'Synthetic delivery claim task',%s)",
                       (uuid.uuid4(), w.org, w.project, w.editor))
    with api.transaction():
        set_tenant(api, w.org, w.editor)
        claim_id = api.execute("insert into pulse.delivery_claim(org_id,file_id,person_id) values (%s,%s,%s) returning id",
                               (w.org, row["id"], w.editor)).fetchone()["id"]
    with api.transaction():
        set_tenant(api, w.org, w.editor)
        assert api.execute("select id from pulse.delivery_claim where id=%s", (claim_id,)).fetchone()["id"] == claim_id
    before = fingerprint(worker, w.org, Deliveries.tables)
    runner.rebuild(w.org)
    assert fingerprint(worker, w.org, Deliveries.tables) == before
    other = build_world(worker, owner, api)
    assert read_as(api, other.org, "select * from pulse.delivery") == []


def test_snapshot_move_out_of_delivery_folder_retains_original_delivery_and_claim(worker, owner, api):
    w = build_world(worker, owner, api)
    root = "Client Video Shoot/2026/October/Synthetic Engagement"
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.project set storage_root=%s where id=%s", ("index-path:" + root, w.project))
        worker.execute("insert into pulse.tenant_config(org_id,doc_kind,doc_key,version,body,is_active) "
                       "values (%s,'folder_rules','ea-deliveries-v0',1,%s,true)", (w.org, Jsonb({"index_rules": RULES})))
    row = {"id": "synthetic-moved-final", "name": "Synthetic.mp4", "mime": "video/mp4", "parents": [],
           "path": root + "/Final Videos/Synthetic.mp4", "modified": datetime.now(UTC),
           "modified_by": w.shared_handle}
    assert store(worker, drive_event(row, w.org, datetime.now(UTC))).status == "accepted"
    runner = ProjectionRunner(worker, Deliveries())
    runner.catch_up(w.org)
    delivery = read_as(worker, w.org, 'select * from pulse.delivery')[0]
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.task(id,org_id,project_id,title,assignee_person_id) "
                       "values(%s,%s,%s,'Synthetic moved delivery task',%s)", (uuid.uuid4(), w.org, w.project, w.editor))
    with api.transaction():
        set_tenant(api, w.org, w.editor)
        claim = api.execute("insert into pulse.delivery_claim(org_id,file_id,person_id) values(%s,%s,%s) returning id",
                            (w.org, row['id'], w.editor)).fetchone()['id']
    row['path'] = root + '/Reference/Synthetic.mp4'
    assert store(worker, drive_event(row, w.org, datetime.now(UTC))).status == "accepted"
    runner.catch_up(w.org)
    assert read_as(worker, w.org, 'select * from pulse.delivery') == [delivery]
    with api.transaction():
        set_tenant(api, w.org, w.editor)
        assert api.execute('select id from pulse.delivery_claim where id=%s', (claim,)).fetchone()
    assert read_as(worker, w.org, 'select creator_person_id from pulse.version')[0]['creator_person_id'] is None
