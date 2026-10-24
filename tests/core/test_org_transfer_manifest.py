"""ADR-0033: catalogue drift and unlisted JSON UUID paths prevent organisation transfer."""

import uuid

from psycopg import sql
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from pulse_sdk.org_transfer import (
    MANIFEST,
    catalogue,
    dump,
    jsonb_problems,
    load,
    refresh,
    static_problems,
    uuid_paths,
)
from test_acceptance_isolation import tenant_tables
from test_acceptance_isolation import two_tenants as two_tenants


def test_static_catalogue_and_preserved_decisions(admin):
    catalog, entries = catalogue(admin), load()
    tables = catalog[0]
    assert set(tables) == set(tenant_tables(admin)) | {"pulse.org"}
    assert static_problems(catalog, entries) == []
    assert MANIFEST.read_text() == dump(entries)
    assert refresh(tables, entries) == entries
    stale = {"table": "pulse.retired_manifest_probe", "class": "skip", "reason": "reviewed retirement"}
    refreshed = refresh({**tables, "pulse.new_manifest_probe": ["payload"]}, entries + [stale])
    assert stale in refreshed
    new = next(e for e in refreshed if e["table"] == "pulse.new_manifest_probe")
    assert new["jsonb"] == {}
    assert static_problems(({new["table"]: ["payload"]}, []), [{**new, "class": "copy"}]) == [
        "pulse.new_manifest_probe.payload: undeclared jsonb column"]
    problems = static_problems(catalog, refreshed)
    assert any("retired_manifest_probe: stale entry" in p for p in problems)
    assert any("new_manifest_probe: unclassified" in p for p in problems)


def test_synthetic_jsonb_values(two_tenants, owner):
    # The isolation fixture includes build_world, issued asset, render/upload, projector, score and backfill extras.
    assert not owner.execute(
        "select rolsuper or rolbypassrls as bypass from pg_roles where rolname=current_user").fetchone()["bypass"]
    for world in two_tenants:
        assert jsonb_problems(owner, load(), world.org) == []


def test_negative_new_table_and_nested_uuid_paths_roll_back(owner, two_tenants):
    world = two_tenants[0]
    before = catalogue(owner)
    with owner.transaction(force_rollback=True):
        role = owner.execute(
            "select pg_get_userbyid(nspowner) as role from pg_namespace where nspname='pulse'").fetchone()["role"]
        owner.execute(sql.SQL("set local role {}").format(sql.Identifier(role)))
        owner.execute("create table pulse.transfer_manifest_probe(org_id uuid, payload jsonb)")
        owner.execute("alter table pulse.transfer_manifest_probe enable row level security")
        owner.execute("alter table pulse.transfer_manifest_probe force row level security")
        owner.execute("create policy tenant on pulse.transfer_manifest_probe using(org_id=pulse.current_org())")
        set_tenant(owner, world.org)
        owner.execute("insert into pulse.transfer_manifest_probe values(%s,%s)",
                      (world.org, Jsonb({"items": [{"new_id": str(uuid.uuid4())}]})))
        catalog, entries = catalogue(owner), load()
        assert "pulse.transfer_manifest_probe: unclassified table (missing entry)" in static_problems(catalog, entries)
        entries.append({"table": "pulse.transfer_manifest_probe", "class": "copy", "jsonb": {"payload": []}})
        path = "pulse.transfer_manifest_probe.payload.items[].new_id: undeclared UUID path"
        assert path in jsonb_problems(owner, entries, world.org)
        entries[-1]["jsonb"]["payload"] = ["payload.items[].new_id"]
        assert path not in jsonb_problems(owner, entries, world.org)
        owner.execute("update pulse.tenant_config set body=body||%s where org_id=%s",
                      (Jsonb({"manifest_probe": str(uuid.uuid4())}), world.org))
        assert "pulse.tenant_config.body.manifest_probe: undeclared UUID path" in jsonb_problems(
            owner, entries, world.org)
    assert catalogue(owner) == before


def test_uuid_walker_and_missing_column_reason(admin):
    value = str(uuid.uuid4())
    assert list(uuid_paths({"items": [[{"id": value}]], "label": "synthetic"}, "payload")) == ["payload.items[][].id"]
    entries = load()
    row = next(e for e in entries if e.get("class") == "copy" and e.get("jsonb"))
    col = next(iter(row["jsonb"]))
    del row["jsonb"][col]
    entries.append({"table": "pulse.org", "class": "skip"})
    problems = static_problems(catalogue(admin), entries)
    assert f"{row['table']}.{col}: undeclared jsonb column" in problems
    assert "pulse.org: skip requires a reason" in problems
    assert "pulse.org: duplicate entry" in problems


def test_fk_closure_rejects_copy_to_rebuild_and_copy_rebuild_to_skip(admin):
    entries = load()
    parent = next(e for e in entries if e["table"] == "pulse.device")
    parent.update({"class": "skip", "reason": "negative FK probe"})
    next(e for e in entries if e["table"] == "pulse.version")["class"] = "rebuild"
    problems = static_problems(catalogue(admin), entries)
    assert any("pulse.device_assignment: foreign key" in p and "pulse.device" in p for p in problems)
    assert any("pulse.review: foreign key" in p and "rebuild table pulse.version" in p for p in problems)
    edge = ({"pulse.child": [], "pulse.device": []}, [("pulse.child", "pulse.device", "probe_fk")])
    for child, target in [("copy", "rebuild"), ("copy", "skip"), ("rebuild", "skip")]:
        probe = [{"table": "pulse.child", "class": child}, {**parent, "class": target}]
        assert any("probe_fk" in p and "invalid FK closure" in p for p in static_problems(edge, probe))
    for child, target in [("copy", "copy"), ("rebuild", "copy"), ("rebuild", "rebuild")]:
        assert static_problems(edge, [{"table": "pulse.child", "class": child}, {**parent, "class": target}]) == []


def test_manifest_path_respects_repo_root_in_installed_layout(tmp_path, monkeypatch):
    import importlib.util
    from pathlib import Path

    from pulse_sdk import org_transfer

    installed = tmp_path / "venv/lib/python3.12/site-packages/pulse_sdk/org_transfer.py"
    installed.parent.mkdir(parents=True)
    installed.write_text(Path(org_transfer.__file__).read_text())
    monkeypatch.setenv("PULSE_REPO_ROOT", str(tmp_path / "app"))
    spec = importlib.util.spec_from_file_location("pulse_sdk._installed_transfer", installed)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert module.MANIFEST == tmp_path / "app/db/org-transfer/manifest.jsonl"


def test_reviewed_global_parents_require_explicit_external_resolution():
    entries = [{"table": "pulse.child", "class": "copy"}]
    for parent in ("privacy.purpose", "privacy.retention_class", "pulse_priv.pulse_account"):
        edge = [("pulse.child", parent, "global_parent_fk")]
        assert static_problems(({"pulse.child": []}, edge), entries) == []
        # An allowlisted name becoming tenant-scoped must still be classified; no blanket exemption.
        assert any("invalid FK closure" in p for p in static_problems(
            ({"pulse.child": [], parent: []}, edge), entries))
    unknown = [("pulse.child", "privacy.new_global_parent", "unknown_global_fk")]
    assert any("unknown_global_fk" in p and "invalid FK closure" in p for p in static_problems(
        ({"pulse.child": []}, unknown), entries))


def test_cli_check_reports_all_problems_without_writing(admin, tmp_path, monkeypatch, capsys):
    from contextlib import nullcontext

    from pulse_sdk import org_transfer

    path = tmp_path / "manifest.jsonl"
    entries = load()
    entries[0]["class"] = "unclassified"
    next(e for e in entries if e["table"] == "pulse.device").update(
        {"class": "skip", "reason": "negative CLI FK probe"})
    entries.append({"table": "pulse.retired_cli_probe", "class": "skip"})
    original = dump(entries)
    path.write_text(original)
    monkeypatch.setattr(org_transfer, "connect", lambda *a, **kw: nullcontext(admin))
    monkeypatch.setattr("sys.argv", ["org-transfer", "manifest", "--check", "--manifest", str(path)])
    assert org_transfer.main() == 1
    output = capsys.readouterr().out
    assert "unclassified" in output and "stale entry" in output and "skip requires a reason" in output
    assert "pulse.device_assignment: foreign key" in output and "skip table pulse.device" in output
    assert path.read_text() == original
