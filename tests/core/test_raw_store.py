import re

import psycopg
import pytest
from conftest import dsn
from helpers import build_world
from psycopg.rows import dict_row
from pulse_sdk.db import set_tenant
from pulse_sdk.raw import RawObjectNotFound, RawStoreFull, capture, get, put


def test_raw_roundtrip_deduplicates_and_captures_versions(worker, owner, api):
    w = build_world(worker, owner, api)
    with worker.transaction():
        set_tenant(worker, w.org)
        sha, stored = put(worker, w.org, b"synthetic invoice bytes", "text/plain", "finance")
        assert stored and get(worker, w.org, sha) == b"synthetic invoice bytes"
        assert put(worker, w.org, b"synthetic invoice bytes", "text/plain", "finance") == (sha, False)
        fields = {"account_ref": "synthetic-account", "path": "folder/item.csv"}
        assert capture(worker, w.org, "finance", "sheet", "synthetic-file", sha, version="v1", **fields)
        assert not capture(worker, w.org, "finance", "sheet", "synthetic-file", sha, version="v1", **fields)
        assert capture(worker, w.org, "finance", "sheet", "synthetic-file", sha, version="v2", **fields)
        assert worker.execute("select count(*) n from pulse_priv.raw_capture where org_id=%s", (w.org,)).fetchone()["n"] == 2


def test_raw_rows_are_tenant_isolated_append_only_and_unavailable_to_api(worker, owner, api):
    w = build_world(worker, owner, api)
    other = build_world(worker, owner, api)
    with worker.transaction():
        set_tenant(worker, w.org)
        sha, _ = put(worker, w.org, b"private synthetic bytes", "application/pdf", "finance")
        capture(worker, w.org, "finance", "sheet", "synthetic-file", sha, version="v1")
    with worker.transaction():
        set_tenant(worker, other.org)
        with pytest.raises(RawObjectNotFound):
            get(worker, other.org, sha)
        for table in ("pulse.raw_object", "pulse_priv.raw_blob", "pulse_priv.raw_capture"):
            assert worker.execute(f"select count(*) n from {table} where org_id=%s", (w.org,)).fetchone()["n"] == 0

    owner_role = owner.execute("select pg_get_userbyid(nspowner) r from pg_namespace where nspname='pulse'").fetchone()["r"]
    assert re.fullmatch(r"[a-z_][a-z0-9_]*", owner_role)
    with owner.transaction():
        owner.execute(f"set local role {owner_role}")
        set_tenant(owner, other.org)
        assert owner.execute("select count(*) n from pulse_priv.raw_blob").fetchone()["n"] == 0
    for statement, params in (
        ("update pulse.raw_object set media_type=media_type where org_id=%s and sha256=%s", (w.org, sha)),
        ("delete from pulse.raw_object where org_id=%s and sha256=%s", (w.org, sha)),
        ("update pulse_priv.raw_blob set stored_length=stored_length where org_id=%s and sha256=%s", (w.org, sha)),
        ("delete from pulse_priv.raw_blob where org_id=%s and sha256=%s", (w.org, sha)),
        ("update pulse_priv.raw_capture set cursor=cursor where org_id=%s", (w.org,)),
        ("delete from pulse_priv.raw_capture where org_id=%s", (w.org,)),
        ("truncate pulse_priv.raw_capture", ()),
    ):
        with pytest.raises(psycopg.errors.ObjectNotInPrerequisiteState, match="append-only"), owner.transaction():
            owner.execute(f"set local role {owner_role}")
            set_tenant(owner, w.org)
            owner.execute(statement, params)
    privileges = owner.execute("""select has_table_privilege('pulse_worker','pulse.raw_object','update') worker_update,
        has_table_privilege('pulse_worker','pulse_priv.raw_blob','delete') worker_delete,
        has_table_privilege('pulse_api','pulse_priv.raw_capture','select') api_select,
        has_table_privilege('pulse_worker','pulse_priv.raw_store_limit','select,update') worker_cap,
        has_table_privilege('pulse_worker','pulse_priv.raw_store_usage','select,insert,update,delete,truncate') worker_usage,
        has_table_privilege('pulse_api','pulse_priv.raw_store_usage','select,insert,update,delete,truncate') api_usage""").fetchone()
    assert not any(privileges.values()), privileges


def test_raw_cap_counts_bytes_across_tenants_and_can_be_lowered(worker, owner, api, admin):
    first, second = build_world(worker, owner, api), build_world(worker, owner, api)
    assert admin.execute("select pg_bytes from pulse_priv.raw_store_limit").fetchone()["pg_bytes"] == 512 * 1024 * 1024
    used = admin.execute("select used_bytes from pulse_priv.raw_store_usage").fetchone()["used_bytes"]
    admin.execute("update pulse_priv.raw_store_limit set pg_bytes=%s", (used + 5,))
    try:
        with worker.transaction():
            set_tenant(worker, first.org)
            put(worker, first.org, b"abc", "application/pdf", "finance")
        with worker.transaction():
            set_tenant(worker, second.org)
            with pytest.raises(RawStoreFull, match="raw store full"):
                put(worker, second.org, b"def", "application/pdf", "finance")
        assert admin.execute("select used_bytes from pulse_priv.raw_store_usage").fetchone()["used_bytes"] == used + 3
    finally:
        admin.execute("update pulse_priv.raw_store_limit set pg_bytes=%s", (512 * 1024 * 1024,))


@pytest.mark.parametrize("isolation", [psycopg.IsolationLevel.REPEATABLE_READ, psycopg.IsolationLevel.SERIALIZABLE])
def test_raw_cap_rejects_stale_snapshot_writers(worker, owner, api, admin, isolation):
    first, second = build_world(worker, owner, api), build_world(worker, owner, api)
    used = admin.execute("select used_bytes from pulse_priv.raw_store_usage").fetchone()["used_bytes"]
    admin.execute("update pulse_priv.raw_store_limit set pg_bytes=%s", (used + 5,))
    try:
        with psycopg.connect(dsn("worker"), autocommit=True, row_factory=dict_row) as stale:
            stale.isolation_level = isolation
            with pytest.raises(psycopg.errors.SerializationFailure), stale.transaction():
                set_tenant(stale, second.org)
                stale.execute("select count(*) from pulse.raw_object")  # establish B's snapshot before A commits
                with worker.transaction():
                    set_tenant(worker, first.org)
                    put(worker, first.org, b"abc", "application/pdf", "finance")
                put(stale, second.org, b"def", "application/pdf", "finance")
            with stale.transaction():
                set_tenant(stale, second.org)
                assert stale.execute("select count(*) n from pulse.raw_object").fetchone()["n"] == 0
                with pytest.raises(RawStoreFull):
                    put(stale, second.org, b"def", "application/pdf", "finance")
        assert admin.execute("select used_bytes from pulse_priv.raw_store_usage").fetchone()["used_bytes"] == used + 3
    finally:
        admin.execute("update pulse_priv.raw_store_limit set pg_bytes=%s", (512 * 1024 * 1024,))


def test_raw_drive_reference_can_exceed_pg_object_limit(worker, owner, api):
    w = build_world(worker, owner, api)
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("""insert into pulse.raw_object(org_id,sha256,size,media_type,codec,stored_length,storage,
                                                       locator,sensitivity)
                         values (%s,%s,8388609,'video/mp4','none',8388609,'drive',
                                 '{"file_id":"synthetic-large-media"}','internal')""", (w.org, "a" * 64))
        assert worker.execute("select size from pulse.raw_object").fetchone()["size"] == 8388609


def test_raw_usage_rolls_back_and_skipped_blobs_are_not_charged(worker, owner, api, admin):
    w = build_world(worker, owner, api)
    used = admin.execute("select used_bytes from pulse_priv.raw_store_usage").fetchone()["used_bytes"]
    with worker.transaction(force_rollback=True):
        set_tenant(worker, w.org)
        put(worker, w.org, b"abc", "application/pdf", "finance")
    assert admin.execute("select used_bytes from pulse_priv.raw_store_usage").fetchone()["used_bytes"] == used
    with worker.transaction():
        set_tenant(worker, w.org)
        sha, stored = put(worker, w.org, b"abc", "application/pdf", "finance")
        assert stored
        assert put(worker, w.org, b"abc", "application/pdf", "finance") == (sha, False)
        worker.execute("""insert into pulse_priv.raw_blob(org_id,sha256,data,stored_length)
                          values (%s,%s,'abc',3) on conflict do nothing""", (w.org, sha))
    assert admin.execute("select used_bytes from pulse_priv.raw_store_usage").fetchone()["used_bytes"] == used + 3


def test_raw_accounting_cannot_be_attached_to_a_worker_temp_table(worker, owner, api, admin):
    w = build_world(worker, owner, api)
    used = admin.execute("select used_bytes from pulse_priv.raw_store_usage").fetchone()["used_bytes"]
    admin.execute("update pulse_priv.raw_store_limit set pg_bytes=%s", (used + 5,))
    try:
        with worker.transaction():
            set_tenant(worker, w.org)
            assert put(worker, w.org, b"abc", "application/pdf", "finance")[1]
        with psycopg.connect(dsn("worker"), autocommit=True, row_factory=dict_row) as attacker:
            assert not attacker.execute("""select has_function_privilege(current_user,
                'pulse_priv.raw_store_enforce_cap()', 'execute') allowed""").fetchone()["allowed"]
            with attacker.transaction():
                attacker.execute("create temporary table raw_cap_attack(stored_length bigint) on commit drop")
                with pytest.raises(psycopg.errors.InsufficientPrivilege, match="raw_store_enforce_cap"), attacker.transaction():
                    attacker.execute("""create trigger attack after insert on raw_cap_attack for each row
                                        execute function pulse_priv.raw_store_enforce_cap()""")
                attacker.execute("insert into raw_cap_attack values (-3)")
        assert admin.execute("select used_bytes from pulse_priv.raw_store_usage").fetchone()["used_bytes"] == used + 3
        with worker.transaction():
            set_tenant(worker, w.org)
            with pytest.raises(RawStoreFull):
                put(worker, w.org, b"def", "application/pdf", "finance")
        assert admin.execute("select used_bytes from pulse_priv.raw_store_usage").fetchone()["used_bytes"] == used + 3
    finally:
        admin.execute("update pulse_priv.raw_store_limit set pg_bytes=%s", (512 * 1024 * 1024,))


def test_raw_accounting_guard_rejects_an_owner_created_temp_trigger(owner, admin):
    used = admin.execute("select used_bytes from pulse_priv.raw_store_usage").fetchone()["used_bytes"]
    role = owner.execute("select pg_get_userbyid(nspowner) r from pg_namespace where nspname='pulse'").fetchone()["r"]
    assert re.fullmatch(r"[a-z_][a-z0-9_]*", role)
    with owner.transaction():
        owner.execute(f"set local role {role}")
        owner.execute("create temporary table raw_cap_guard(stored_length bigint) on commit drop")
        owner.execute("""create trigger attack after insert on raw_cap_guard for each row
                          execute function pulse_priv.raw_store_enforce_cap()""")
        with pytest.raises(psycopg.errors.InsufficientPrivilege, match="raw_blob AFTER INSERT"), owner.transaction():
            owner.execute("insert into raw_cap_guard values (-3)")
    assert admin.execute("select used_bytes from pulse_priv.raw_store_usage").fetchone()["used_bytes"] == used
