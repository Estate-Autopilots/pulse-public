"""Appendix A-tests not covered elsewhere (ADR-0025 gate item 1): creator-first review visibility (T4b-c, f, h, i),
the append-only log (T8), single-event redaction with hash and log row (T9), empty default partitions (T10)."""

from __future__ import annotations

import os
import re
from pathlib import Path

import psycopg
import pytest

from pulse_sdk import migrate as pulse_migrate
from pulse_sdk.db import set_tenant
from pulse_workers.projector import ProjectionRunner
from pulse_workers.workgraph import WorkGraph

from helpers import build_world, drive_id, issue_asset, read_as, upload


def test_creator_first_review_visibility(worker, owner, api):
    w = build_world(worker, owner, api)
    cid = w.cid("HK", 3)
    issue_asset(api, w, cid)
    upload(worker, w, drive_id(), f"{cid}-v1.mp4", "draft", folder=w.drafts, minutes=20,
           actor=f"account:google:{w.editor_handle}")
    ProjectionRunner(worker, WorkGraph()).catch_up(w.org)
    with worker.transaction():
        set_tenant(worker, w.org)
        vid = worker.execute("select id from pulse.version").fetchone()["id"]
        worker.execute("update pulse.version set creator_person_id = %s where id = %s", (w.editor, vid))
        rid = worker.execute("""insert into pulse.review (org_id, version_id, reviewer_kind, verdict)
                                values (%s, %s, 'ai', 'revision_required') returning id""", (w.org, vid)).fetchone()["id"]
        worker.execute("""insert into pulse.review_note (org_id, review_id, dimension, change_required, why, severity)
                          values (%s, %s, 'craft', 'Fix caption typo at 00:17', 'Contradicts the script', 3)""",
                       (w.org, rid))

    def sees(viewer):
        with api.transaction():
            set_tenant(api, w.org, viewer)
            return (api.execute("select count(*) as n from pulse.review").fetchone()["n"],
                    api.execute("select count(*) as n from pulse.review_note").fetchone()["n"])

    assert sees(w.editor) == (1, 1)          # T4b, T4c: the creator sees the review of an unshared draft
    assert sees(w.manager) == (0, 0)         # T4f: the manager does not, until the draft is marked ready
    assert sees(w.editor2) == (0, 0)         # T4h: a colleague never does
    assert sees(w.lead) == (0, 0)
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.version set ready_at = now() where id = %s", (vid,))
    assert sees(w.lead) == (1, 1)            # T4i: the project lead once ready
    assert sees(w.manager) == (1, 1)         # and the creator's manager
    assert sees(w.editor2) == (0, 0)


def test_log_is_append_only_for_services(worker, owner, api, ingest, privacy):
    w = build_world(worker, owner, api)
    for conn in (worker, api, ingest, privacy):
        for sql in ("update pulse.event set data = '{}'", "delete from pulse.event",
                    "update pulse.event_ephemeral set data = '{}'", "truncate pulse.event"):
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                with conn.transaction():
                    set_tenant(conn, w.org)
                    conn.execute(sql)


def test_editor_week_access_log_keeps_subject_when_viewer_has_no_person(api, owner, worker):
    w = build_world(worker, owner, api)
    with api.transaction():
        set_tenant(api, w.org)
        api.execute("""insert into privacy.access_log(org_id,viewer_id,subject_person_id,resource,grain,purpose)
                       values (%s,null,%s,'editors.week','person','editor_week_view')""", (w.org, w.editor))
        row = api.execute("""select viewer_id,subject_person_id,resource,grain,purpose from privacy.access_log
                            where org_id=%s and viewer_id is null and subject_person_id=%s
                              and resource='editors.week' and purpose='editor_week_view'
                            order by at desc limit 1""", (w.org, w.editor)).fetchone()
    assert row is not None
    assert row["viewer_id"] is None
    assert row["subject_person_id"] == w.editor
    assert row["grain"] == "person"


def test_ea_editor_config_seed_is_repeatable_and_emits_config_events(worker, owner, api):
    w = build_world(worker, owner, api)
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("update pulse.org set code='EA' where id=%s", (w.org,))

    seed = pulse_migrate.up_section(
        (Path(__file__).resolve().parents[2] / "db/seeds/ea_editor_config.sql").read_text()
    )
    owner_role = os.environ.get("PULSE_DB_OWNER")
    if owner_role is None:
        owner_role = owner.execute("""select pg_get_userbyid(datdba) as role
                                      from pg_database where datname=current_database()""").fetchone()["role"]
        if owner.execute("select rolsuper as superuser from pg_roles where rolname=%s",
                         (owner_role,)).fetchone()["superuser"]:
            owner_role = "pulse_owner"
    assert re.fullmatch(r"[a-z_][a-z0-9_]*", owner_role)
    for _ in range(2):
        with owner.transaction():
            owner.execute(f"set local role {owner_role}")
            tenant_id = owner.execute(
                "select nullif(current_setting('pulse.org_id', true), '') as tenant_id"
            ).fetchone()["tenant_id"]
            assert tenant_id is None
            owner.execute(seed, prepare=False)

    with owner.transaction():
        set_tenant(owner, w.org)
        targets = owner.execute("""select body from pulse.tenant_config where org_id=%s and doc_kind='targets'
                                  and doc_key='editors' and is_active""", (w.org,)).fetchone()["body"]
        folder_rules = owner.execute("""select body from pulse.tenant_config where org_id=%s
                                       and doc_kind='folder_rules' and is_active""", (w.org,)).fetchone()["body"]
        events = owner.execute("""select count(*) from pulse.event where org_id=%s and type='config.changed'
                                 and data->>'changed_by_ref'='system:pulse:db-migration'""", (w.org,)).fetchone()["count"]
    assert targets["editors"]["model_video"] == {"per_week": 4, "placeholder": True}
    assert targets["editors"]["vov"] == {"per_week": 3, "placeholder": True}
    assert targets["editors"]["other"] == {"per_week": None, "placeholder": True}
    assert folder_rules["creative_type_rules"]["parsed_type_codes"]["CP"] == "vov"
    assert events == 2


def test_single_redaction_keeps_a_hash_and_logs_itself(worker, owner, api, privacy, admin):
    w = build_world(worker, owner, api)
    upload(worker, w, drive_id(), "erase-me.mp4", "x", folder=w.drafts, minutes=20)
    row = read_as(admin, w.org, """select seq, time, id from pulse.event where org_id = %s
                                    and data->>'name' = 'erase-me.mp4'""", (w.org,))[0]
    other = build_world(worker, owner, api)
    with privacy.transaction():                                   # another tenant cannot redact it
        set_tenant(privacy, other.org)
        privacy.execute("select privacy.redact_event(%s, %s, 'erasure request')", (row["seq"], row["time"]))
    assert read_as(admin, w.org, "select redacted_at from pulse.event where seq = %s", (row["seq"],))[0]["redacted_at"] \
        is None
    with privacy.transaction():
        set_tenant(privacy, w.org)
        privacy.execute("select privacy.redact_event(%s, %s, 'erasure request')", (row["seq"], row["time"]))
        privacy.execute("select privacy.redact_event(%s, %s, 'erasure request')", (row["seq"], row["time"]))  # no-op
    after = read_as(admin, w.org, "select data, actor, redaction_hash from pulse.event where seq = %s", (row["seq"],))[0]
    assert after["data"] == {} and after["actor"] is None and len(after["redaction_hash"]) == 64
    logged = read_as(admin, w.org, """select count(*) as n from pulse.event where org_id = %s
                                       and type = 'privacy.event.redacted' and subject = %s""",
                     (w.org, f"event:pulse:{row['seq']}"))[0]["n"]
    assert logged == 1


def test_default_partitions_stay_empty(admin):
    assert admin.execute("select count(*) as n from only pulse.event_default").fetchone()["n"] == 0
    assert admin.execute("select count(*) as n from only pulse.event_ephemeral_default").fetchone()["n"] == 0
    today = admin.execute("""select count(*) as n from pg_inherits i join pg_class c on c.oid = i.inhrelid
                              where i.inhparent = 'pulse.event_ephemeral'::regclass
                                and c.relname = 'event_eph_' || to_char(now() at time zone 'UTC', 'YYYY_MM_DD')""")
    assert today.fetchone()["n"] == 1


def test_undeclared_data_fields_are_rejected_by_the_database(worker, owner, api):
    w = build_world(worker, owner, api)
    from helpers import event
    from pulse_sdk.envelope import to_row
    from pulse_sdk.store import insert_event
    ev = event(w.org, "drive.file.uploaded", f"file:gdrive:{drive_id()}",
               {"name": "x.mp4", "mime": "video/mp4", "parents": [w.drafts], "url": "https://drive/x"},
               source=w.collector, time=w.at(5))
    with worker.transaction():
        set_tenant(worker, w.org)
        result = insert_event(worker, to_row(ev))
    assert result.status == "rejected" and "undeclared" in result.error
