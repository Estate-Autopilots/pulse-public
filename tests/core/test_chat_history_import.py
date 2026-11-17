"""R47 on real PostgreSQL: WhatsApp history imported into a conversation is read by its current members only, never by
a role, never by the worker, ingest, privacy or model roles, and never feeds anything else. Duplicate and overlapping
exports add only what is new; a withdrawn batch is hidden, not deleted. Every export, name and message is synthetic."""

import hashlib
import json
import os
import re
import subprocess
import uuid
from pathlib import Path

import psycopg
import pytest
from conftest import dsn
from psycopg.conninfo import conninfo_to_dict
from pulse_sdk.db import set_tenant
from test_chats import setup
from test_tasks_rt1 import team  # noqa: F401  (team is a fixture)

CANARY = "R47-canary-" + uuid.uuid4().hex


def key(*parts):
    return hashlib.sha256("\n".join(map(str, parts)).encode()).hexdigest()


def message(line, body, author=None, label="Editor One", kind="text", minute=0):
    return {"key": key("synthetic", line, label, body), "at": f"2026-10-12T03:{30 + minute:02d}:00Z",
            "local": f"2026-10-12T09:{minute:02d}:00", "exact": True, "line": line, "author": str(author) if author else None,
            "label": label, "kind": kind, "body": body, "edited": False}


def batch(sha, messages, **extra):
    return {"parser": "whatsapp-text/1", "fileSha256": sha, "fileBytes": 512, "timeZone": "Asia/Kolkata", "dateOrder": "dmy",
            "stats": {"messages": len(messages)}, "participants": [{"key": key("p", m["label"]), "display": m["label"]} for m in messages],
            "approvalRef": "E15 synthetic approval", "retentionNote": "Proposal for legal review; no purge", **extra}


def run_import(api, w, viewer, channel, sha, messages):
    with api.transaction():
        set_tenant(api, w.org, viewer)
        return api.execute("select pulse.chat_import(%s,%s,%s) r", (channel, json.dumps(batch(sha, messages)), json.dumps(messages))).fetchone()["r"]


def history(api, w, viewer, channel):
    with api.transaction():
        set_tenant(api, w.org, viewer)
        return [r["body"] for r in api.execute("select body from pulse.chat_history(%s) order by seq", (channel,))]


def world(worker, owner, api):
    w = setup(worker, owner, api)
    with worker.transaction():
        set_tenant(worker, w.org)
        # Roles that must not open anyone's chats by themselves: HR (Editor Two) and leadership (Project Lead).
        for pid, role in ((w.editor2, "hr"), (w.lead, "leadership")):
            worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,%s,'2020-01-01')", (w.org, pid, role))
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        group = api.execute("select pulse.chat_group_create('Synthetic shoot crew',%s) id", ([w.editor],)).fetchone()["id"]
    return w, group


def test_members_read_imported_history_and_repeats_add_only_what_is_new(worker, owner, api):
    w, group = world(worker, owner, api)
    with worker.transaction():
        set_tenant(worker, w.org)
        before = {t: worker.execute(f"select count(*) n from pulse.{t}").fetchone()["n"] for t in ("notification", "chat_event", "chat_message")}
    first = [message(1, "Synthetic call sheet\nline two", w.editor), message(2, "", w.manager, "Pod Manager", "media", 1),
             message(3, "Joining from the client side", None, "Number ending 123", minute=2)]
    result = run_import(api, w, w.manager, group, "a" * 64, first)
    assert (result["added"], result["duplicates"]) == (3, 0)
    assert history(api, w, w.editor, group) == ["Synthetic call sheet\nline two", "", "Joining from the client side"]
    with api.transaction():
        set_tenant(api, w.org, w.editor)
        rows = api.execute("select author_id,author_name,author_label,kind,local_time from pulse.chat_history(%s) order by seq", (group,)).fetchall()
        assert [(r["author_id"], r["author_name"], r["author_label"], r["kind"]) for r in rows] == [
            (w.editor, "Editor One", "Editor One", "text"), (w.manager, "Pod Manager", "Pod Manager", "media"), (None, None, "Number ending 123", "text")]
        assert api.execute("select pulse.chat_history_count(%s) n", (group,)).fetchone()["n"] == 3
        provenance = api.execute("select pulse.chat_import_batches(%s) b", (group,)).fetchone()["b"]
        assert [(b["added"], b["duplicates"], b["approvedBy"], b["approvalRef"], b["member"]) for b in provenance] == [(3, 0, "Pod Manager", "E15 synthetic approval", True)]
    # The same file again into the same conversation is refused; a longer export that overlaps adds only the new message.
    with pytest.raises(psycopg.errors.UniqueViolation):
        run_import(api, w, w.manager, group, "a" * 64, first)
    result = run_import(api, w, w.manager, group, "b" * 64, first + [message(4, "A new synthetic message", w.editor, minute=3)])
    assert (result["added"], result["duplicates"]) == (1, 3)
    assert len(history(api, w, w.editor, group)) == 4
    # Nothing else moved: no notification, chat event, Pulse message or unread count; no message text in the audit.
    with worker.transaction():
        set_tenant(worker, w.org)
        after = {t: worker.execute(f"select count(*) n from pulse.{t}").fetchone()["n"] for t in ("notification", "chat_event", "chat_message")}
        assert after == before
        audit = worker.execute("select action,fields from pulse.audit_event where resource in ('chat_history','chat_import_batch')").fetchall()
        assert {a["action"] for a in audit} >= {"import", "insert"}
        assert "call sheet" not in json.dumps(audit)


def test_roles_alone_read_nothing_and_only_an_admin_member_imports_into_a_chosen_conversation(worker, owner, api):
    w, group = world(worker, owner, api)
    run_import(api, w, w.manager, group, "c" * 64, [message(1, "Synthetic private plan", w.editor)])
    # HR, leadership and a second admin who are not members read nothing and count nothing.
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'admin','2020-01-01')", (w.org, w.lead))
    for outsider in (w.editor2, w.lead):
        assert history(api, w, outsider, group) == []
        with api.transaction():
            set_tenant(api, w.org, outsider)
            assert api.execute("select pulse.chat_history_count(%s) n", (group,)).fetchone()["n"] == 0
            assert api.execute("select pulse.chat_import_batches(%s) b", (group,)).fetchone()["b"] == []
            # An admin may moderate a group they are not in (chat_has); imported history does not follow that role.
            assert api.execute("select pulse.chat_has(%s) ok", (group,)).fetchone()["ok"] is (outsider == w.lead)
            assert api.execute("select pulse.chat_history_reader(%s) ok", (group,)).fetchone()["ok"] is False
            # An admin sees that an import happened (provenance, never text) and that they are not a member.
            listed = api.execute("select pulse.chat_import_batches() b", ()).fetchone()["b"]
            assert [b["member"] for b in listed] == ([False] if outsider == w.lead else [])
            assert "Synthetic private plan" not in json.dumps(listed)
    # Possessing an export is not access: an admin who is not a member cannot import into the group.
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="member of"):
        run_import(api, w, w.lead, group, "d" * 64, [message(1, "x", w.editor)])
    # A member who is not an admin cannot import either.
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="Only an admin"):
        run_import(api, w, w.editor, group, "d" * 64, [message(1, "x", w.editor)])
    # A pod's members follow the roster and roles: no history goes there, even from an admin member.
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        pod = api.execute("select id from pulse.chat_channel where kind='pod'").fetchone()["id"]
        assert api.execute("select pulse.chat_import_refusal(%s) r", (pod,)).fetchone()["r"].startswith("History goes only into")
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="never a pod"):
        run_import(api, w, w.manager, pod, "d" * 64, [message(1, "x", w.editor)])
    # A direct chat between the admin and one colleague takes history.
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        dm = api.execute("select pulse.chat_direct(%s) id", (w.editor,)).fetchone()["id"]
    assert run_import(api, w, w.manager, dm, "e" * 64, [message(1, "Synthetic direct note", w.editor)])["added"] == 1
    assert history(api, w, w.editor, dm) == ["Synthetic direct note"]
    # A sender can only be mapped to a colleague of this company.
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="colleague of this company"):
        run_import(api, w, w.manager, dm, "f" * 64, [message(1, "x", uuid.uuid4())])


def test_private_group_revoked_member_leaver_and_withdrawal(worker, owner, api):
    w, group = world(worker, owner, api)
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        api.execute("select pulse.chat_group_members(%s,%s,'{}')", (group, [w.editor2]))
        other = api.execute("select pulse.chat_group_create('Synthetic other group',%s) id", ([w.lead],)).fetchone()["id"]
    run_import(api, w, w.manager, group, "1" * 64, [message(1, "Synthetic group-only text", w.editor)])
    assert history(api, w, w.editor2, group) == ["Synthetic group-only text"]
    assert history(api, w, w.lead, group) == [] and history(api, w, w.lead, other) == []
    # Removed from the group: the history closes at once, as for any message.
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        api.execute("select pulse.chat_group_members(%s,'{}',%s)", (group, [w.editor2]))
    assert history(api, w, w.editor2, group) == []
    # Someone who left the company reads nothing either.
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.person set status='inactive' where id=%s", (w.editor,))
    assert history(api, w, w.editor, group) == []
    # Withdrawing hides the batch from everyone; its rows stay (nothing is deleted).
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        batch_id = api.execute("select (pulse.chat_import_batches(%s)->0->>'id')::uuid id", (group,)).fetchone()["id"]
    with pytest.raises(psycopg.errors.InvalidParameterValue), api.transaction():
        set_tenant(api, w.org, w.manager)
        api.execute("select pulse.chat_import_withdraw(%s,'')", (batch_id,))
    with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
        set_tenant(api, w.org, w.editor2)
        api.execute("select pulse.chat_import_withdraw(%s,'Not mine to withdraw')", (batch_id,))
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        api.execute("select pulse.chat_import_withdraw(%s,'Imported into the wrong group')", (batch_id,))
        assert api.execute("select pulse.chat_history_count(%s) n", (group,)).fetchone()["n"] == 0
        assert api.execute("select pulse.chat_import_batches(%s)->0->>'withdrawnNote' n", (group,)).fetchone()["n"] == "Imported into the wrong group"
    assert history(api, w, w.manager, group) == []
    with owner.transaction():
        set_tenant(owner, w.org)
        assert owner.execute("select count(*) n from pulse_priv.chat_import_message where batch_id=%s", (batch_id,)).fetchone()["n"] == 1


def test_worker_ingest_privacy_and_model_roles_cannot_reach_imported_text(worker, owner, api, ingest, privacy, admin):
    w, group = world(worker, owner, api)
    run_import(api, w, w.manager, group, "9" * 64, [message(1, f"Synthetic {CANARY} about Project Lead and the client", w.editor)])
    for role in ("pulse_worker", "pulse_ingest", "pulse_privacy", "pulse_api"):
        for table in ("pulse_priv.chat_import_batch", "pulse_priv.chat_import_message"):
            for privilege in ("select", "insert", "update", "delete"):
                assert not admin.execute("select has_table_privilege(%s,%s,%s) ok", (role, table, privilege)).fetchone()["ok"], (role, table, privilege)
    for role in ("pulse_worker", "pulse_ingest", "pulse_privacy"):
        for fn in ("pulse.chat_history(uuid,timestamptz,bigint,int)", "pulse.chat_history_count(uuid)", "pulse.chat_import(uuid,jsonb,jsonb)", "pulse.chat_import_batches(uuid)"):
            assert not admin.execute("select has_function_privilege(%s,%s,'execute') ok", (role, fn)).fetchone()["ok"], (role, fn)
    for conn in (worker, ingest, privacy):
        with pytest.raises(psycopg.errors.InsufficientPrivilege), conn.transaction():
            set_tenant(conn, w.org)
            conn.execute("select body from pulse_priv.chat_import_message")
        with pytest.raises(psycopg.errors.InsufficientPrivilege), conn.transaction():
            set_tenant(conn, w.org)
            conn.execute("select * from pulse.chat_history(%s)", (group,))
    # The worker's derivations run (R46 relationship proposals) and the canary appears in no other column anywhere.
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("select pulse.relation_refresh()")
    columns = admin.execute(
        """select n.nspname s, c.relname t, a.attname col from pg_attribute a join pg_class c on c.oid=a.attrelid
           join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('pulse','pulse_priv','privacy','pulse_route')
           and c.relkind in ('r','p') and not c.relispartition and a.attnum>0 and not a.attisdropped
           and a.atttypid in ('text'::regtype,'varchar'::regtype,'jsonb'::regtype,'json'::regtype,'text[]'::regtype)
           and not (n.nspname='pulse_priv' and c.relname='chat_import_message')""").fetchall()
    hits = []
    with owner.transaction():
        set_tenant(owner, w.org)
        for c in columns:
            if owner.execute(f'select exists(select 1 from "{c["s"]}"."{c["t"]}" where "{c["col"]}"::text like %s) hit', (f"%{CANARY}%",)).fetchone()["hit"]:
                hits.append(f'{c["s"]}.{c["t"]}.{c["col"]}')
    assert hits == []
    # Code that runs as the worker, ingest, bot or model jobs does not name the imported history at all.
    root = Path(__file__).resolve().parents[2]
    named = [str(p.relative_to(root)) for d in ("services/workers/src", "services/ml", "services/ingest", "services/bot", "collectors")
             for p in (root / d).rglob("*.py") if re.search(r"chat_import|chat_history", p.read_text(errors="ignore"))]
    assert named == []


def test_http_preview_then_approved_import_off_by_default(worker, owner, api):
    """services/api/test/chat-import-runner.mjs: the browser's reader, then the API (off until PULSE_CHAT_IMPORT=1)."""
    w = setup(worker, owner, api)
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        for pid in (w.manager, w.editor, w.editor2, w.lead):
            api.execute("select pulse.login_issue(%s,'Synthetic-issued-2026!')", (pid,))
    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    # RELEASE-5: "off by default" here is the preview without imports (PULSE_CHAT_IMPORT=preview, as pulse-dev runs);
    # unset, the whole module answers 404 (services/api/test/module-routes.test.mjs).
    env = {**{k: v for k, v in os.environ.items() if k != "PULSE_CHAT_IMPORT"}, "PULSE_CHAT_IMPORT": "preview"}
    proc = subprocess.run(["node", "test/chat-import-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api",
                          env={**env, "TEST_API_CONFIG": json.dumps(config), "PULSE_ORG_ID": str(w.org), "TEST_PERSON": str(w.editor)},
                          capture_output=True, text=True, timeout=60, check=False)
    assert proc.returncode == 0, proc.stderr


@pytest.mark.skipif(os.environ.get("PULSE_AUTH_BROWSER") != "1", reason="browser checks run in CI with PULSE_AUTH_BROWSER=1")
def test_import_page_and_history_in_the_browser(worker, owner, api, team, tmp_path):  # noqa: F811
    """services/api/test/chat-import-browser-runner.mjs: preview, decide, import, read; screenshots with PULSE_R47_SCREENSHOTS."""
    w = team
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        api.execute("select pulse.chat_refresh()")
        group = api.execute("select pulse.chat_group_create('Synthetic shoot crew',%s) id", ([w.editor, w.editor2],)).fetchone()["id"]
    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    env = {**{k: v for k, v in os.environ.items() if k != "PULSE_CHAT_IMPORT"}, "PULSE_CI": "1", "TEST_API_CONFIG": json.dumps(config),
           "TEST_MEMBER": w.editor_handle, "TEST_IDS": json.dumps({"group": str(group), "editor": str(w.editor)}), "PULSE_R47_REPORT": str(tmp_path / "r47.json")}
    p = subprocess.run(["node", "test/chat-import-browser-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api", env=env,
                       capture_output=True, text=True, timeout=2400, check=False)
    assert p.returncode == 0, (p.stderr + p.stdout)[-6000:]
    assert json.loads((tmp_path / "r47.json").read_text())["browserChecks"] >= 25
