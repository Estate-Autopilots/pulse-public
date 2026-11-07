from contextlib import nullcontext
from dataclasses import dataclass

import pytest

from pulse_gdrive_snapshot import backfill, bootstrap, team


class Result:
    def __init__(self, row=None, rows=None):
        self.row = row
        self.rows = rows or []

    def fetchone(self):
        return self.row

    def fetchall(self):
        return self.rows

    def __iter__(self):
        return iter(self.rows)


class Pulse:
    def __init__(self):
        self.statements = []
        self.folder_rules = []

    def execute(self, sql, params=()):
        self.statements.append((sql, params))
        if sql == "select pulse.install_org() as org_id":
            return Result({"org_id": None})
        if sql == "select pulse.install_ea(%s) as org_id":
            return Result({"org_id": str(bootstrap.EA_ORG)})
        if sql == "select code from pulse.org where id=%s":
            return Result({"code": "EA"})
        if sql == "select to_regclass('pulse.sync_run') is not null as ok":
            return Result({"ok": True})
        if sql.startswith("insert into pulse.sync_run("):
            return Result({"id": "run-1"})
        if sql.startswith("select version,body from pulse.tenant_config"):
            return Result()
        if "insert into pulse.tenant_config" in sql and "'folder_rules'" in sql:
            body = params[-1].obj if hasattr(params[-1], "obj") else params[-1]
            self.folder_rules = [{"doc_key": "ea-deliveries-v0", "version": params[-2], "body": body}]
        elif "from pulse.tenant_config" in sql and "doc_kind = 'folder_rules'" in sql:
            return Result(rows=self.folder_rules)
        return Result()


class Index:
    def __init__(self):
        self.statements = []

    def execute(self, sql, params=()):
        self.statements.append((sql, params))
        users = [
            {"email": "editor@example.test", "name": "Synthetic Editor", "suspended": False},
            {"email": "suspended@example.test", "name": "Synthetic Suspended", "suspended": True},
        ]
        if "where not coalesce(suspended,false)" in sql:
            return Result(rows=[user for user in users if not user["suspended"]])
        if "from ws_user" in sql:
            return Result(rows=users)
        if "max(finished)" in sql:
            return Result({"at": None})
        return Result(rows=[])


@dataclass
class Counts:
    processed: int = 0


def test_missing_index_url_is_recorded_as_a_failed_sync_run(monkeypatch):
    pulse = Pulse()
    monkeypatch.delenv("EA_INDEX_DATABASE_URL", raising=False)
    monkeypatch.setattr(bootstrap, "url_for", lambda _role: "worker-url")
    monkeypatch.setattr(bootstrap.psycopg, "connect", lambda *_args, **_kwargs: nullcontext(pulse))
    monkeypatch.setattr(bootstrap, "tenant_tx", lambda *_args: nullcontext())

    with pytest.raises(bootstrap.MissingIndexConfiguration):
        bootstrap.refresh()

    started = next(i for i, (sql, _) in enumerate(pulse.statements)
                   if sql.startswith("insert into pulse.sync_run("))
    failed = next(i for i, (sql, params) in enumerate(pulse.statements)
                  if "set finished_at=now(),ok=false,error=%s where id=%s" in sql
                  and params == ("MissingIndexConfiguration", "run-1"))
    assert started < failed


def test_bootstrap_refreshes_metadata_roster_without_drive_text_sql(monkeypatch, tmp_path, capsys):
    pulse, index = Pulse(), Index()
    config = {
        "shared_local_parts": [], "shared_external_accounts": [], "delivery_rules": [], "same_person": [],
        "team": [{"name": "Synthetic Editor", "key": "synthetic-editor", "role": "Video Editor", "pod": "Pod 1"}],
        "name_aliases": {}, "confirm_same_person": [],
        "sensitive_access": ["suspended@example.test"], "mailbox_roles": {},
    }
    monkeypatch.setenv("EA_INDEX_DATABASE_URL", "index-url")
    monkeypatch.setenv("EA_GROUPS_ROSTER", str(tmp_path / "missing-groups.csv"))
    monkeypatch.setattr(bootstrap, "url_for", lambda _role: "worker-url")
    monkeypatch.setattr(bootstrap.psycopg, "connect", lambda url, **_kwargs: nullcontext(
        pulse if url == "worker-url" else index))
    monkeypatch.setattr(bootstrap, "tenant_tx", lambda *_args: nullcontext())
    monkeypatch.setattr(bootstrap, "run_backfill", lambda *_args, **_kwargs: Counts())
    monkeypatch.setattr(team, "load_config", lambda: config)
    monkeypatch.setattr(team, "_account_map", lambda: None)
    monkeypatch.setattr(team, "tenant_tx", lambda *_args: nullcontext())
    monkeypatch.setattr(team, "seed_records", lambda *_args: {})

    assert bootstrap.refresh() == 0
    assert "'roster_active': 1" in capsys.readouterr().out

    statements = [sql.lower() for sql, _ in [*pulse.statements, *index.statements]]
    assert all("drive_text" not in sql for sql in statements)
    assert all("drive_text" not in sql.lower() for sql in (backfill.FOLDER_SQL, backfill.FILES_SQL))
    assert any("from ws_user" in sql for sql in statements)
    source_refresh = "delete from pulse.person_source where source in ('ops_hub','groups_roster','workspace_directory')"
    assert any(source_refresh in sql for sql in statements)
    assert not any("delete from pulse_priv.hr_" in sql or "delete from pulse.person where" in sql
                   or "delete from pulse.people_profile where" in sql
                   for sql in statements)
    assert any("insert into pulse.person_source" in sql for sql in statements)
    assert not any("insert into pulse.sensitive_permission" in sql for sql in statements)
