"""R52 (migration 0470): per-company connectors, contract connector.v1, on synthetic two-company fixtures.

The company is the one that installed a connector, never a field of a payload: EA Connect reads a company's roots with
that company's own credential from its own folder of the secret store, and a plugin's signed batch finds its company by
its install id alone. A credential belongs to one company. A replay changes nothing, an upgrade waits for the admin's
grant, a record outside the granted entities or the root's rights is refused, and a revoked connector stops at once
while what it delivered stays. Every Drive is test_drive_changes' FakeDrive and every key is synthetic: this is mock
evidence, not a Google receipt."""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import threading
import time
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

import psycopg
import pytest
from conftest import dsn
from helpers import build_world
from psycopg.conninfo import conninfo_to_dict
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from pulse_gdrive_changes import connect, feed
from pulse_gdrive_extract import cli as extract_cli
from pulse_ingest.connectors import ingest_connector_batch
from pulse_sdk import connector
from pulse_sdk.db import set_tenant
from pulse_sdk.signing import generate_keypair
from test_drive_changes import SECRET, FakeDrive, make_admin, q
from test_tasks_rt1 import team  # noqa: F401  (a fixture)

META = "https://www.googleapis.com/auth/drive.metadata.readonly"
FOLDER = "application/vnd.google-apps.folder"
SYNTHETIC_KEY = "-----BEGIN PRIVATE KEY-----\nSyntheticKeyMustNotLeak\n-----END PRIVATE KEY-----\n"
ALL_DRIVE = sorted(e["type"] for e in connector.ea_connect_manifest()["entities"])


@pytest.fixture
def two(worker, owner, api):
    """Company A (the install's own company, built first) and company B, each with an admin (the manager)."""
    a = build_world(worker, owner, api)
    b = build_world(worker, owner, api)
    for w in (a, b):
        make_admin(worker, w)
    return a, b


@pytest.fixture
def secrets(tmp_path, monkeypatch):
    """A private secret store with one folder per company, and connectors switched on for this server."""
    base = tmp_path / "connector-secrets"
    base.mkdir(mode=0o700)
    monkeypatch.setenv(connector.SECRETS_DIR_ENV, str(base))
    monkeypatch.setenv(connector.ENABLED_ENV, "1")
    return base


def sa(name):
    """A synthetic service-account address, unique per test: a credential stays claimed by its company for good."""
    return f"{name}-{uuid.uuid4().hex[:10]}@synthetic-gcp.example"


def key_file(tmp_path, email):
    path = tmp_path / f"{uuid.uuid4().hex}.json"
    path.write_text(json.dumps({"type": "service_account", "client_email": email, "private_key_id": "synthetic",
                                "private_key": SYNTHETIC_KEY}))
    path.chmod(0o600)
    return path


def fn(api, w, sql, *args, who=None):
    """A connector function called as a company's admin (or `who`) through the API role, as the API routes do."""
    return q(api, w.org, sql, args, viewer=who or w.manager)[0]


def ea_connect(api, w, **extra):
    return fn(api, w, "select pulse.connector_create(%s) id", Jsonb({
        "implementation": "ea_connect", "manifest": connector.ea_connect_manifest(), "secretRef": "ea-connect", **extra}))["id"]


def add_root(api, w, install, *, kind="shared_drive", ref="team-drive", label="Deliverables", entities=None):
    body = {"kind": kind, "ref": ref, "label": label, **({"entities": entities} if entities is not None else {})}
    return fn(api, w, "select pulse.connector_source_add(%s,%s) id", install, Jsonb(body))["id"]


def approve(api, w, install, entities=ALL_DRIVE, scopes=(META,), ref="E13/E18 synthetic approval"):
    return fn(api, w, "select pulse.connector_approve(%s,%s) r", install,
              Jsonb({"scopes": list(scopes), "entities": list(entities), "approvalRef": ref}))["r"]


def revoke(api, w, install, reason="Synthetic: the company stopped using this connector"):
    return fn(api, w, "select pulse.connector_revoke(%s,%s) r", install, reason)["r"]


def status(api, w):
    return fn(api, w, "select pulse.connector_status() s")["s"]


def plugin_manifest(version="1.0.0", entities=("drive.file.created", "drive.file.updated"), key="acme-sync"):
    return {"contract": "connector.v1", "key": key, "name": "Synthetic company plugin", "version": version,
            "publisher": "Synthetic Co", "transport": "push", "auth": "signed_push",
            "scopes": [{"scope": META, "why": "Synthetic: read file metadata of the approved folders"}],
            "sources": ["shared_drive", "folder"], "entities": [{"type": t, "schema": 1} for t in entities]}


def plugin(api, w, manifest=None, pub=None):
    key = None
    if pub is None:
        key, pub = generate_keypair()
    install = fn(api, w, "select pulse.connector_create(%s) id", Jsonb({
        "implementation": "plugin", "manifest": manifest or plugin_manifest(), "publicKey": pub}))["id"]
    return install, key, pub


def record(item, kind="drive.file.created", schema=1, name="Synthetic brief.pdf", mime="application/pdf", **data):
    at = (datetime.now(UTC) - timedelta(minutes=5)).isoformat().replace("+00:00", "Z")
    return {"key": hashlib.sha256(f"{item}|{kind}|{at}".encode()).hexdigest(), "type": kind, "schema": schema, "time": at,
            "item": item, "data": {"name": name, "mime": mime, "parents": ["gdrive:plugin-root"], **data},
            "provenance": {"system": "google_drive", "ref": f"changes/{item}", "observedAt": at}}


def batch(source, batch_id, records, frm=None, version="1.0.0"):
    return {"contract": "connector.v1", "manifestVersion": version, "source": source, "batch": batch_id,
            "cursor": {"from": frm, "to": f"cursor-after-{batch_id}"}, "records": records}


def push(ingest, install, key, body):
    raw = json.dumps(body).encode()
    return ingest_connector_batch(ingest, connector.sign_batch(key, install, raw), raw)


def connector_events(worker, w):
    return q(worker, w.org, "select source, subject, type from pulse.event where source like '/collectors/connector/%%' order by subject")


def test_the_contract_s_lists_match_the_database_and_bad_manifests_are_refused_twice(worker, two):
    a, _ = two
    schema = connector.manifest_schema()
    entities = schema["properties"]["entities"]["items"]["properties"]["type"]["enum"]
    scopes = schema["properties"]["scopes"]["items"]["properties"]["scope"]["enum"]
    row = q(worker, a.org, "select pulse.connector_entities() e, pulse.connector_scopes() s")[0]
    assert (sorted(row["e"]), sorted(row["s"])) == (sorted(entities), sorted(scopes))
    for t in entities:
        assert q(worker, a.org, "select pulse.connector_entity_scope(%s) s", (t,))[0]["s"] == connector.entity_scopes()[t]
    ea = connector.ea_connect_manifest()
    ok = lambda m: q(worker, a.org, "select pulse.connector_manifest_ok(%s) ok", (Jsonb(m),))[0]["ok"]
    assert connector.manifest_problems(ea) == [] and ok(ea)
    assert connector.manifest_problems(plugin_manifest()) == [] and ok(plugin_manifest())
    bad = {
        "an entity outside the contract": {**ea, "entities": [{"type": "mail.message.sent", "schema": 1}]},
        "a data schema Pulse does not have": {**ea, "entities": [{"type": "drive.file.created", "schema": 2}]},
        "a broader Google scope": {**ea, "scopes": [{"scope": "https://www.googleapis.com/auth/drive", "why": "Synthetic: all"}]},
        "a puller with a plugin's auth": {**ea, "auth": "signed_push"},
        "another contract": {**ea, "contract": "connector.v2"},
        "a field naming a company": {**ea, "orgId": str(a.org)},
        "a scope naming an account": {**ea, "scopes": [{**ea["scopes"][0], "subject": "someone@synthetic.example"}]},
        "an entity twice": {**ea, "entities": ea["entities"] + ea["entities"][:1]},
        "a scope with no reason": {**ea, "scopes": [{"scope": META, "why": "x"}]},
    }
    for why, manifest in bad.items():
        assert connector.manifest_problems(manifest), why
        assert not ok(manifest), why


def test_a_connector_belongs_to_one_company_and_its_admins_alone(worker, api, two, secrets, tmp_path):
    a, b = two
    install = ea_connect(api, a)
    for who in (a.editor, a.editor2, a.lead):                           # a member, another member, a project lead
        for sql, args in (("select pulse.connector_status() s", ()),
                          ("select pulse.connector_source_add(%s,%s) id", (install, Jsonb({"kind": "folder", "ref": "x1",
                                                                                           "label": "Theirs"}))),
                          ("select pulse.connector_revoke(%s,%s) r", (install, "Synthetic: not mine to revoke"))):
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                fn(api, a, sql, *args, who=who)
    # The other company sees nothing of it and cannot select, approve or revoke for it.
    assert status(api, b) == []
    for attempt in (lambda: add_root(api, b, install), lambda: approve(api, b, install), lambda: revoke(api, b, install),
                    lambda: fn(api, b, "select pulse.connector_propose(%s,%s) r", install, Jsonb(connector.ea_connect_manifest()))):
        with pytest.raises(psycopg.errors.NoDataFound):
            attempt()
    with pytest.raises(psycopg.errors.UniqueViolation):                 # one live EA Connect per company
        ea_connect(api, a)
    theirs = ea_connect(api, b)                                         # the other company installs its own
    # A's Google key is A's: B is refused before anything lands in B's folder.
    mine = sa("reader-a")
    key = key_file(tmp_path, mine)
    done = connect.install_secret(worker, a.org, install, key)
    assert done == {"install": str(install), "secretRef": "ea-connect", "installed": True,
                    "credentialId": connector.fingerprint_google(mine)[:12]}
    assert (secrets / str(a.org) / "ea-connect.json").stat().st_mode & 0o777 == 0o600
    assert (secrets / str(a.org)).stat().st_mode & 0o777 == 0o700
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="credential_elsewhere"):
        connect.install_secret(worker, b.org, theirs, key)
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="credential_elsewhere"):   # another key, same account
        connect.install_secret(worker, b.org, theirs, key_file(tmp_path, mine.upper()))
    assert not (secrets / str(b.org)).exists()
    with pytest.raises(LookupError):                                    # naming A's install from B's company
        connect.install_secret(worker, b.org, install, key_file(tmp_path, sa("reader-b")))
    assert q(worker, b.org, "select credential_fingerprint f from pulse.connector_install")[0]["f"] is None
    # A plugin key registered for A is refused for B.
    _, _, pub = plugin(api, a)
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="credential_elsewhere"):
        plugin(api, b, pub=pub)
    # The API role cannot read the tables at all; only the admin function answers.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        q(api, a.org, "select * from pulse.connector_install")


def test_ea_connect_reads_each_company_with_its_own_credential_and_a_change_lands_once(worker, api, two, secrets,
                                                                                      tmp_path, monkeypatch):
    a, b = two
    drives = {}

    def api_for(source):
        path, _subject = connect.credential_for(source, a.org)         # A is the install's own company
        return drives[path]

    installs = {}
    for w, email in ((a, sa("reader-a")), (b, sa("reader-b"))):
        install = ea_connect(api, w)
        add_root(api, w, install, ref="team-shared")                    # both name a drive with the same id
        with pytest.raises(psycopg.errors.ObjectNotInPrerequisiteState, match="secret_missing"):
            approve(api, w, install)
        connect.install_secret(worker, w.org, install, key_file(tmp_path, email))
        assert approve(api, w, install) == {"status": "active", "version": "1.0.0"}
        drives[secrets / str(w.org) / "ea-connect.json"] = FakeDrive()
        installs[w.org] = install
    for w in (a, b):                                                    # an R44 root bound to its own install
        rows = q(worker, w.org, "select install_id, credential_ref, enabled, approval_ref from pulse.drive_source")
        assert [(r["install_id"], r["credential_ref"], r["enabled"]) for r in rows] == [(installs[w.org], "ea-connect", True)]
        feed.run_once(worker, w.org, api_for)                           # starts at Google's current position
    drive_a, drive_b = (drives[secrets / str(w.org) / "ea-connect.json"] for w in (a, b))
    drive_a.put("syntheticfile1", "Synthetic brief v2.pdf", ["team-shared"], drive_id="team-shared", mime="application/pdf")
    due = datetime.now(UTC) + timedelta(hours=1)
    for _ in range(2):
        for w in (a, b):
            feed.run_once(worker, w.org, api_for, now=lambda: due)
    subject = "file:gdrive:syntheticfile1"
    count = lambda w: q(worker, w.org, "select count(*) n from pulse.event where subject=%s", (subject,))[0]["n"]
    assert (count(a), count(b)) == (1, 0)                               # the owner's change reaches only A, once
    assert drive_b.lists >= 1                                           # B's own Drive was read with B's own key

    # A root without a connector in B (as R44 registers them) is never read with the install's credential.
    legacy = feed.add_source(worker, b.org, kind="folder", root_id="b-legacy", label="Legacy root",
                             credential_ref="synthetic-ea")
    feed.approve_source(worker, b.org, legacy, approved_by=b.manager, approval_ref="E13 synthetic approval")
    result = next(r for r in feed.run_once(worker, b.org, api_for, now=lambda: due) if r.source == str(legacy))
    assert (result.status, result.error_code) == ("access_lost", "credential_unbound")
    insert = ("insert into pulse.drive_change(org_id,source_id,change_key,file_id,change_time,kind) "
              "values (%s,%s,%s,'synthetic',now(),'created')")
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="credential_unbound"):
        q(worker, b.org, insert, (b.org, legacy, "0" * 64))             # the database refuses it too

    def root(w):
        bound = q(worker, w.org, "select id from pulse.drive_source where install_id is not null")[0]["id"]
        return q(worker, w.org, feed.SOURCE_SQL, (bound,))[0]

    # The file in A's folder must be the credential A's install recorded, private, and a real file.
    src_a, src_b = root(a), root(b)
    mine = secrets / str(a.org) / "ea-connect.json"
    original = mine.read_bytes()
    mine.write_text(json.dumps({"type": "service_account", "client_email": "someone-else@synthetic.example"}))
    with pytest.raises(connect.CredentialMismatch):
        connect.credential_for(src_a, a.org)
    mine.write_bytes(original)
    mine.chmod(0o640)
    with pytest.raises(connect.CredentialUnavailable):
        connect.credential_for(src_a, a.org)
    mine.chmod(0o600)
    theirs = secrets / str(b.org) / "ea-connect.json"
    theirs.rename(theirs.with_suffix(".kept"))
    theirs.symlink_to(mine)                                             # B's folder pointing at A's key
    with pytest.raises(connect.CredentialUnavailable):
        connect.credential_for(src_b, a.org)
    monkeypatch.delenv(connector.ENABLED_ENV)
    with pytest.raises(connect.ConnectorsOff):
        connect.credential_for(src_a, a.org)


def test_revoking_ea_connect_waits_for_a_page_in_flight_then_stops_reading(worker, owner, api, two, secrets, tmp_path):
    a, _ = two
    install = ea_connect(api, a)
    add_root(api, a, install, ref="team-a")
    connect.install_secret(worker, a.org, install, key_file(tmp_path, sa("reader-a")))
    approve(api, a, install)
    drive = FakeDrive()

    def api_for(source):
        connect.credential_for(source, a.org)
        return drive

    feed.run_once(worker, a.org, api_for)
    source = q(worker, a.org, "select id from pulse.drive_source")[0]["id"]
    drive.put("inflight1", "Synthetic one.pdf", ["team-a"], drive_id="team-a", mime="application/pdf")
    seen: dict = {}

    def revoke_elsewhere():
        with psycopg.connect(dsn("api"), autocommit=True, row_factory=dict_row) as other:
            seen["result"] = revoke(other, a, install)
            seen["revoked_at"] = time.monotonic()

    thread = threading.Thread(target=revoke_elsewhere)

    def fault(point, _page):
        if point == "before_commit":
            thread.start()
            time.sleep(1.0)
            assert thread.is_alive(), "the revoke waits for the page in flight"
            seen["page_done"] = time.monotonic()

    due = datetime.now(UTC) + timedelta(hours=1)
    with feed_source(worker, a, source) as row:
        result = feed.poll_source(worker, api_for(row), a.org, source, now=lambda: due, fault=fault)
    thread.join(15)
    assert result.events == 1 and seen["result"] == {"status": "revoked"} and seen["revoked_at"] > seen["page_done"]
    # Nothing more is read; what was read stays.
    drive.put("after1", "Synthetic two.pdf", ["team-a"], drive_id="team-a", mime="application/pdf")
    assert feed.run_once(worker, a.org, api_for, now=lambda: due + timedelta(hours=1)) == []
    with feed_source(worker, a, source) as row:
        assert row["enabled"] is False and row["install_status"] == "revoked"
        with pytest.raises(connect.ConnectorInactive):
            connect.credential_for(row, a.org)
        assert feed.poll_source(worker, drive, a.org, source, now=lambda: due).status == "not_approved"
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="connector_revoked"):
        q(worker, a.org, "insert into pulse.drive_change(org_id,source_id,change_key,file_id,change_time,kind) "
                         "values (%s,%s,%s,'synthetic',now(),'created')", (a.org, source, "1" * 64))
    events = q(worker, a.org, "select subject from pulse.event where source=%s", (feed.source_uri(source),))
    assert [e["subject"] for e in events] == ["file:gdrive:inflight1"]
    st = status(api, a)[0]
    assert (st["status"], st["sources"][0]["status"], st["sources"][0]["cursor"]["reading"]) == ("revoked", "stopped", False)
    assert st["revokeReason"].startswith("Synthetic")
    # Revoked is final: no grant, root or second revoke; a new install starts again from preview.
    for attempt in (lambda: approve(api, a, install), lambda: add_root(api, a, install, ref="team-b"),
                    lambda: revoke(api, a, install)):
        with pytest.raises(psycopg.errors.ObjectNotInPrerequisiteState):
            attempt()
    with pytest.raises(psycopg.errors.ObjectNotInPrerequisiteState), owner.transaction():  # not even the table's owner
        role = owner.execute("select pg_get_userbyid(nspowner) r from pg_namespace where nspname='pulse'").fetchone()["r"]
        owner.execute(f"set local role {role}")
        set_tenant(owner, a.org)
        owner.execute("update pulse.connector_install set status='active' where id=%s", (install,))
    fresh = ea_connect(api, a)
    assert [i["status"] for i in status(api, a) if i["id"] == str(fresh)] == ["preview"]


class feed_source:
    """The R44 root row with its install's state, read inside the company."""

    def __init__(self, worker, w, source):
        self.worker, self.w, self.source = worker, w, source

    def __enter__(self):
        return q(self.worker, self.w.org, feed.SOURCE_SQL, (self.source,))[0]

    def __exit__(self, *_):
        return False


def test_a_plugin_s_batch_lands_in_its_company_once_and_a_replay_changes_nothing(worker, api, ingest, two, monkeypatch):
    a, b = two
    install, key, _ = plugin(api, b)
    add_root(api, b, install, kind="folder", ref="plugin-root", label="Plugin root")
    approve(api, b, install, entities=["drive.file.created", "drive.file.updated"])
    r1, r2 = record("pfile1"), record("pfile2")
    first = batch("plugin-root", "b-0001", [r1, r2])
    assert push(ingest, install, key, first).status == 404             # off on this server: as if absent
    monkeypatch.setenv(connector.ENABLED_ENV, "1")
    named = push(ingest, install, key, {**first, "orgId": str(a.org)})  # a body can never name a company
    assert named.status == 400 and named.body["error"] == "invalid_batch"
    ok = push(ingest, install, key, first)
    assert ok.status == 200, ok.body
    assert (ok.body["status"], ok.body["accepted"], ok.body["duplicates"], ok.body["refused"]) == ("accepted", 2, 0, 0)
    got = connector_events(worker, b)
    assert [e["subject"] for e in got] == ["file:gdrive:pfile1", "file:gdrive:pfile2"]
    assert all(e["source"].startswith(f"/collectors/connector/{install}/") for e in got)
    assert connector_events(worker, a) == []
    prov = q(ingest, b.org, "select item, provenance from pulse.connector_record order by item")  # ingest's own table
    assert [p["provenance"]["ref"] for p in prov] == ["changes/pfile1", "changes/pfile2"]
    # The same batch again (a fresh signature and nonce) is answered from the record; nothing is written.
    again = push(ingest, install, key, first)
    assert (again.status, again.body["status"], again.body["accepted"]) == (200, "replayed", 2)
    # A batch from a stale position is refused with the checkpoint to resume from.
    stale = push(ingest, install, key, batch("plugin-root", "b-0002", [record("pfile3")]))
    assert (stale.status, stale.body) == (409, {"error": "cursor_conflict", "checkpoint": "cursor-after-b-0001"})
    # Records sent again inside a new batch are duplicates: a key is accepted once per root, ever.
    nxt = push(ingest, install, key, batch("plugin-root", "b-0002", [r1, record("pfile3")], frm="cursor-after-b-0001"))
    assert (nxt.body["accepted"], nxt.body["duplicates"]) == (1, 1)
    assert len(connector_events(worker, b)) == 3
    # A nonce is used once; a wrong key, another company's install, an unknown install or root are refused.
    raw = json.dumps(batch("plugin-root", "b-0003", [], frm="cursor-after-b-0002")).encode()
    headers = connector.sign_batch(key, install, raw)
    assert ingest_connector_batch(ingest, headers, raw).status == 200
    assert ingest_connector_batch(ingest, headers, raw).status == 401
    stranger, _ = generate_keypair()
    assert push(ingest, install, stranger, batch("plugin-root", "b-0004", [], frm="cursor-after-b-0003")).status == 401
    install_a, key_a, _ = plugin(api, a)                                # A's own plugin, not approved
    assert push(ingest, install_a, key, first).status == 401           # B's key on A's install
    assert push(ingest, install_a, key_a, first).status == 403         # A's install is still a preview
    assert push(ingest, str(uuid.uuid4()), key, first).status == 401
    unknown = push(ingest, install, key, batch("someone-elses-root", "b-0005", []))
    assert (unknown.status, unknown.body["error"]) == (404, "source_unknown")
    v2 = push(ingest, install, key, {**first, "contract": "connector.v2", "batch": "b-0006"})
    assert (v2.status, v2.body["error"]) == (400, "contract_unsupported")
    # The admin sees that a checkpoint is held and the counts, never its value.
    st = status(api, b)[0]
    cursor = st["sources"][0]["cursor"]
    assert (cursor["stored"], cursor["records"], cursor["duplicates"]) == (True, 3, 1)
    assert "cursor-after" not in json.dumps(st)
    assert connector_events(worker, a) == []


def test_an_upgrade_waits_for_the_grant_and_records_outside_the_grant_are_refused(worker, api, ingest, two, monkeypatch):
    _, b = two
    monkeypatch.setenv(connector.ENABLED_ENV, "1")
    install, key, _ = plugin(api, b, plugin_manifest(entities=("drive.file.created", "drive.file.updated")))
    root_one = add_root(api, b, install, kind="folder", ref="root-one", label="Root one")
    approve(api, b, install, entities=["drive.file.created"])           # a partial grant
    st = status(api, b)[0]
    assert st["missingEntities"] == ["drive.file.updated"]
    assert (st["sources"][0]["rights"], st["sources"][0]["notGranted"]) == (["drive.file.created"], ["drive.file.updated"])
    first = batch("root-one", "u-1", [record("x1"), record("x2", kind="drive.file.updated"), record("x3", schema=2),
                                      record("x4", note="Synthetic undeclared field")])
    res = push(ingest, install, key, first)
    assert res.status == 207
    assert [(r["status"], r.get("error", "").split(":")[0]) for r in res.body["records"]] == [
        ("accepted", ""), ("refused", "entity_not_granted"), ("refused", "schema_unsupported"), ("refused", "invalid_record")]
    # Version 1.1.0 adds new folders; it waits for the grant while 1.0.0 keeps applying.
    newer = plugin_manifest("1.1.0", entities=("drive.file.created", "drive.file.updated", "drive.folder.created"))
    up = fn(api, b, "select pulse.connector_propose(%s,%s) r", install, Jsonb(newer))["r"]
    assert (up["from"], up["to"], up["newEntities"]) == ("1.0.0", "1.1.0", ["drive.file.updated", "drive.folder.created"])
    for same_or_older in (plugin_manifest("1.0.0"), plugin_manifest("0.9.0")):
        with pytest.raises(psycopg.errors.InvalidParameterValue):
            fn(api, b, "select pulse.connector_propose(%s,%s) r", install, Jsonb(same_or_older))
    with pytest.raises(psycopg.errors.InvalidParameterValue):            # an upgrade cannot become another connector
        fn(api, b, "select pulse.connector_propose(%s,%s) r", install, Jsonb(plugin_manifest("2.0.0", key="other-sync")))
    early = push(ingest, install, key, batch("root-one", "u-2", [record("x5")], frm="cursor-after-u-1", version="1.1.0"))
    assert (early.status, early.body["error"]) == (409, "manifest_not_granted")
    folder = lambda item: record(item, kind="drive.folder.created", name="Synthetic folder", mime=FOLDER)
    before = push(ingest, install, key, batch("root-one", "u-2", [folder("f1")], frm="cursor-after-u-1"))
    assert before.body["records"][0]["error"] == "entity_not_granted"
    assert status(api, b)[0]["proposed"] == {"version": "1.1.0", "newScopes": [],
                                             "newEntities": ["drive.file.updated", "drive.folder.created"]}
    # A root selected during the upgrade may carry the new entity; root one keeps the rights it was selected with.
    add_root(api, b, install, kind="folder", ref="root-two", label="Root two")
    approve(api, b, install, entities=["drive.file.created", "drive.folder.created"])
    st = status(api, b)[0]
    assert (st["version"], st["proposed"], st["missingEntities"]) == ("1.1.0", None, ["drive.file.updated"])
    two_ok = push(ingest, install, key, batch("root-two", "v-1", [folder("f2")], version="1.1.0"))
    assert (two_ok.status, two_ok.body["accepted"]) == (200, 1)
    one = push(ingest, install, key, batch("root-one", "u-3", [folder("f3")], frm="cursor-after-u-2", version="1.1.0"))
    assert one.body["records"][0]["error"] == "entity_not_granted"
    # A batch accepted before the upgrade replays as before.
    assert push(ingest, install, key, first).body["status"] == "replayed"
    assert [e["subject"] for e in connector_events(worker, b)] == ["file:gdrive:f2", "file:gdrive:x1"]
    # The database refuses a record outside the grant even without the ingest service's checks.
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="entity_not_granted"):
        q(ingest, b.org, "insert into pulse.connector_record(org_id,source_id,record_key,entity,item,record_time,event_id,"
                         "batch_id,provenance) values (%s,%s,%s,'drive.file.updated','zz',now(),'e','b',%s)",
          (b.org, root_one, "f" * 64, Jsonb({"system": "google_drive", "ref": "r", "observedAt": "2026-10-12T00:00:00Z"})))


def test_revoking_a_plugin_refuses_its_next_batch_and_keeps_what_it_delivered(worker, api, ingest, two, monkeypatch):
    _, b = two
    monkeypatch.setenv(connector.ENABLED_ENV, "1")
    install, key, pub = plugin(api, b)
    add_root(api, b, install, kind="folder", ref="plugin-root", label="Plugin root")
    approve(api, b, install, entities=["drive.file.created"])
    first = batch("plugin-root", "r-1", [record("kept1")])
    assert push(ingest, install, key, first).status == 200
    assert revoke(api, b, install, "Synthetic: the plugin's key may have leaked") == {"status": "revoked"}
    assert push(ingest, install, key, batch("plugin-root", "r-2", [record("late1")], frm="cursor-after-r-1")).status == 401
    assert push(ingest, install, key, first).status == 401              # even a replay
    assert [e["subject"] for e in connector_events(worker, b)] == ["file:gdrive:kept1"]
    assert q(ingest, b.org, "select count(*) n from pulse.connector_record")[0]["n"] == 1
    st = status(api, b)[0]
    assert (st["status"], st["sources"][0]["status"], st["sources"][0]["cursor"]["reading"]) == ("revoked", "stopped", False)
    # The same company may install the same key again: a new install, waiting for a new approval.
    again, _, _ = plugin(api, b, pub=pub)
    assert push(ingest, again, key, first).status == 403


def test_status_shows_grants_gaps_and_the_secret_reference_never_the_secret(worker, api, two, secrets, tmp_path):
    a, _ = two
    email = sa("reader-a")
    install = ea_connect(api, a, subject=email, label="EA Connect for Company A")
    st = status(api, a)[0]
    assert (st["key"], st["name"], st["version"], st["status"], st["label"]) == (
        "ea-connect", "EA Connect", "1.0.0", "preview", "EA Connect for Company A")
    assert st["credential"] == {"ref": "ea-connect", "installed": False, "id": None, "delegated": True,
                                "kind": "google_service_account"}
    assert (st["missingScopes"], st["missingEntities"], st["sources"]) == ([META], ALL_DRIVE, [])
    add_root(api, a, install, ref="team-a")
    connect.install_secret(worker, a.org, install, key_file(tmp_path, email))
    approve(api, a, install, entities=["drive.file.created", "drive.file.updated"])
    drive = FakeDrive()
    feed.run_once(worker, a.org, lambda s: (connect.credential_for(s, a.org), drive)[1])
    st = status(api, a)[0]
    assert st["credential"]["installed"] and len(st["credential"]["id"]) == 12
    assert st["missingScopes"] == [] and len(st["missingEntities"]) == 4
    src = st["sources"][0]
    assert (src["ref"], src["status"], src["rights"], len(src["notGranted"])) == (
        "team-a", "approved", ["drive.file.created", "drive.file.updated"], 4)
    assert (src["cursor"]["stored"], src["cursor"]["reading"], src["cursor"]["status"]) == (True, True, "ok")
    text = json.dumps(st)
    for hidden in (SECRET, email, "SyntheticKeyMustNotLeak", str(secrets), connector.fingerprint_google(email)):
        assert hidden not in text


def test_document_text_is_never_read_from_a_connector_root(worker, api, two, secrets, tmp_path):
    a, b = two
    install = ea_connect(api, a)
    add_root(api, a, install, ref="team-a")
    connect.install_secret(worker, a.org, install, key_file(tmp_path, sa("reader-a")))
    approve(api, a, install)
    source = q(worker, a.org, "select id from pulse.drive_source")[0]["id"]
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="scope_not_granted"):
        q(worker, a.org, "insert into pulse.drive_extract_policy(org_id,source_id,formats,audience,approval_ref,approved_by,"
                         "approved_at,enabled) values (%s,%s,'{text}','{admin}','E08 synthetic approval',%s,now(),true)",
          (a.org, source, a.manager))
    opener = extract_cli.content_for(a.org)
    with pytest.raises(extract_cli.ScopeNotGranted):
        opener({"install_id": install, "org_id": a.org, "credential_ref": "ea-connect", "subject": None})
    with pytest.raises(connect.CredentialUnbound):
        opener({"install_id": None, "org_id": b.org, "credential_ref": "synthetic-ea", "subject": None})


def test_http_routes_preview_install_grant_and_revoke(worker, api, team):  # noqa: F811
    """services/api/test/connectors-runner.mjs: the same rules over HTTP with real password sessions."""
    w = team
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        for pid in (w.manager, w.editor, w.lead):
            api.execute("select pulse.login_issue(%s,'Synthetic-issued-2026!')", (pid,))
    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    # Reading stays off on this server; RELEASE-6: "setup" shows the connectors module (unset, its routes answer 404).
    env = {**{k: v for k, v in os.environ.items() if k != connector.ENABLED_ENV}, connector.ENABLED_ENV: "setup"}
    proc = subprocess.run(["node", "test/connectors-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api",
                          env={**env, "TEST_API_CONFIG": json.dumps(config), "PULSE_ORG_ID": str(w.org)},
                          capture_output=True, text=True, timeout=120, check=False)
    assert proc.returncode == 0, proc.stderr + proc.stdout
