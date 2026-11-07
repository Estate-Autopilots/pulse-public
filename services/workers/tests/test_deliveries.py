from __future__ import annotations

from datetime import UTC, datetime
from types import SimpleNamespace

from pulse_workers.deliveries import Deliveries


class Result:
    def __init__(self, rows=None, row=None):
        self.rows = rows or []
        self.row = row

    def fetchall(self):
        return self.rows

    def fetchone(self):
        return self.row

    def __iter__(self):
        return iter(self.rows)


class Connection:
    def __init__(self):
        self.orgs = {
            "ea-org": [{
                "doc_key": "ea-video-rules", "version": 3,
                "body": {"schema_version": 1, "index_rules": [
                    {"match": "approved videos?", "kind": "final"},
                ]},
            }],
            # Synthetic second company, Northwind Studio, uses its own stage vocabulary.
            "northwind-studio": [{
                "doc_key": "northwind-creative-flow", "version": 1,
                "body": {"schema_version": 1, "index_rules": [
                    {"match": "client handoff", "kind": "draft"},
                ]},
            }],
        }
        self.queries = []
        self.current_org = None

    def execute(self, sql, params=()):
        self.queries.append((sql, params))
        if "select id,storage_root" in sql:
            return Result(rows=[
                {"storage_root": "index-path:ea-root", "id": "ea-project"},
                {"storage_root": "index-path:northwind-root", "id": "northwind-project"},
            ])
        if "select doc_key, version, body from pulse.tenant_config" in sql:
            self.current_org = params[0]
            return Result(rows=self.orgs[self.current_org])
        if "insert into pulse.asset" in sql:
            return Result(row={"id": f"{self.current_org}-asset"})
        return Result()


def event(file_id: str, path: str, seq: int):
    now = datetime(2026, 10, 8, tzinfo=UTC)
    return SimpleNamespace(
        type="drive.file.observed",
        redacted=False,
        subject=f"file:gdrive:{file_id}",
        time=now,
        seq=seq,
        data={
            "index_path": path,
            "name": f"{file_id}.mp4",
            "mime": "video/mp4",
            "owner": "account:google:synthetic@example.test",
            "index_created_at": now,
            "index_modified_at": now,
        },
    )


def test_one_worker_pass_uses_each_orgs_active_delivery_rules():
    conn = Connection()
    projection = Deliveries()
    paths = {
        "ea-org": ("ea-final", "ea-root/project/Approved Videos/ea-final.mp4"),
        "northwind-studio": ("northwind-draft", "northwind-root/client/Client Handoff/northwind-draft.mp4"),
    }

    for seq, (org_id, (file_id, path)) in enumerate(paths.items(), start=10):
        projection.begin(conn, org_id)
        projection.apply(conn, event(file_id, path, seq))

    delivery_rows = [params for sql, params in conn.queries if "insert into pulse.delivery" in sql]
    assert [(row[0], row[1], row[4], row[6]) for row in delivery_rows] == [
        ("ea-org", "ea-final", "final", "ea-video-rules"),
        ("northwind-studio", "northwind-draft", "draft", "northwind-creative-flow"),
    ]


def test_missing_exclusions_use_the_historical_default():
    conn = Connection()
    projection = Deliveries()

    projection.begin(conn, "ea-org")

    assert projection.rules.exclusions == ("raw", "b-roll", "reference", "examples?", "templates?")
