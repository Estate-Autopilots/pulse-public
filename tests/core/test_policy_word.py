"""R41 (migration 0215): Word (.docx) sources on policy versions and the browser editor's sessions. The database keeps
each file under the hash it computes, a published version keeps its exact file, Markdown edits drop a Word file, and an
editor session saves only the policy state it opened, as a person who may still edit policies, in its own tenant.
All documents, people and tokens are synthetic; the editor provider itself is not involved (its callbacks are
services/api/test/policy-word-runner.mjs, driven by the last test here)."""
import hashlib
import json
import os
import secrets
import subprocess
from pathlib import Path

import psycopg
import pytest
from helpers import build_world
from pulse_sdk.db import set_tenant
from test_company import configure

BODY = "# Synthetic leave policy\n\n## 1. Purpose\n\nA synthetic policy for tests."
DOCX = b"PK\x03\x04 synthetic word bytes v1"   # the database stores bytes; the API is what checks they are a .docx
DOCX2, DOCX3 = DOCX + b" edited", DOCX + b" edited again"
sha = lambda b: hashlib.sha256(b).hexdigest()  # noqa: E731


def run(conn, w, who, sql, args=()):
    with conn.transaction():
        set_tenant(conn, w.org, who)
        cur = conn.execute(sql, args)
        return cur.fetchone() if cur.description else None


def upload(api, w, who, body, version, revision, data=DOCX, name="Leave.docx"):
    return run(api, w, who, "select pulse.policy_docx_draft_save('leave','Synthetic leave',%s,%s,%s,%s,%s,'upload') r", (body, version, revision, data, name))["r"]


def session(api, w, who, document):
    token = secrets.token_urlsafe(32)
    s = run(api, w, who, "select pulse.policy_editor_open(%s,%s,12) r", (document, sha(token.encode())))["r"]
    return sha(token.encode()), s


def event(api, w, token_hash, key, status, data=None, body=None):
    return run(api, w, None, "select pulse.policy_editor_event(%s,%s,%s,%s,%s) r", (token_hash, key, status, data, body))["r"]


def doc(worker, w, document):
    return run(worker, w, None, "select version,revision,status,body,docx_sha256,docx_source,docx_name from pulse.policy_document where id=%s", (document,))


@pytest.fixture
def world(worker, owner, api):
    w = build_world(worker, owner, api)
    configure(worker, w)   # w.manager is an admin; w.editor is a plain employee
    return w


def test_word_file_kept_under_its_own_hash_and_frozen_once_published(api, worker, owner, world):
    w = world
    saved = upload(api, w, w.manager, BODY, 0, 1)
    assert (saved["version"], saved["revision"], saved["sha256"]) == (1, 1, sha(DOCX))
    assert doc(worker, w, saved["id"])["docx_source"] == "upload"
    # The same file, title and text is no new revision; another file is.
    assert upload(api, w, w.manager, BODY, 1, 1)["revision"] == 1
    assert upload(api, w, w.manager, BODY + " Two.", 1, 1, DOCX2)["revision"] == 2
    with pytest.raises(psycopg.errors.SerializationFailure):
        upload(api, w, w.manager, BODY, 1, 1, DOCX3)          # a stale tab
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        upload(api, w, w.editor, BODY, 1, 2, DOCX3)            # employees do not edit policies
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        upload(api, w, w.manager, BODY, 1, 2, DOCX3, "")
    got = run(api, w, w.manager, "select * from pulse.policy_docx_read(%s)", (saved["id"],))
    assert (bytes(got["bytes"]), got["sha256"], got["name"]) == (DOCX2, sha(DOCX2), "Leave.docx")
    assert run(api, w, w.editor, "select count(*) n from pulse.policy_docx_read(%s)", (saved["id"],))["n"] == 0
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        run(api, w, w.manager, "select count(*) from pulse.policy_docx")   # files are reached through functions only
    run(api, w, w.manager, "select pulse.policy_publish(%s,2)", (saved["id"],))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        run(worker, w, None, "update pulse.policy_document set docx_sha256=%s where id=%s", (sha(DOCX3), saved["id"]))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        run(owner, w, None, "update pulse.policy_docx set bytes='x'")   # even the owner cannot change a kept file
    # Employees read the published text; its Word file stays the one HR published.
    assert run(api, w, w.editor, "select count(*) n from pulse.policy_document where docx_sha256=%s", (sha(DOCX2),))["n"] == 1


def test_markdown_text_change_drops_the_word_file_a_title_change_keeps_it(api, worker, world):
    w = world
    saved = upload(api, w, w.manager, BODY, 0, 1)
    r = run(api, w, w.manager, "select pulse.policy_draft_save('leave','Renamed leave',%s,1,1) r", (BODY,))["r"]
    assert doc(worker, w, saved["id"])["docx_sha256"] == sha(DOCX) and r["revision"] == 2
    run(api, w, w.manager, "select pulse.policy_draft_save('leave','Renamed leave',%s,1,2) r", (BODY + " Edited in Markdown.",))
    row = doc(worker, w, saved["id"])
    assert (row["docx_sha256"], row["docx_name"], row["docx_source"], row["revision"]) == (None, None, None, 3)


def test_an_editor_session_saves_only_the_state_it_opened(api, worker, world):
    w = world
    saved = upload(api, w, w.manager, BODY, 0, 1)
    token, s = session(api, w, w.manager, saved["id"])
    assert s["key"].startswith("pulse-") and len(s["key"]) == 46 and s["sha256"] == sha(DOCX)
    # A second person opening the same state gets the same key (they edit together); any save changes it.
    token2, s2 = session(api, w, w.manager, saved["id"])
    assert s2["key"] == s["key"]
    assert bytes(run(api, w, None, "select pulse.policy_editor_file(%s) b", (token,))["b"]) == DOCX
    assert run(api, w, None, "select pulse.policy_editor_file(%s) b", (sha(b"unknown"),))["b"] is None
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        event(api, w, token, "pulse-another-key", 2, DOCX2, BODY)
    with pytest.raises(psycopg.errors.NoDataFound):
        event(api, w, sha(b"unknown"), s["key"], 2, DOCX2, BODY)
    assert event(api, w, token, s["key"], 1)["outcome"] == "editing"
    # Saved while still open (force save): the draft moves on and the session moves with it.
    forced = event(api, w, token, s["key"], 6, DOCX2, BODY + " Forced.")
    assert (forced["outcome"], forced["revision"], forced["sha256"]) == ("saved", 2, sha(DOCX2))
    row = doc(worker, w, saved["id"])
    assert (row["docx_sha256"], row["docx_source"], row["body"]) == (sha(DOCX2), "editor", BODY + " Forced.")
    # The co-editor's session (same key) moved too, so the final save through it is not stale.
    final = event(api, w, token2, s["key"], 2, DOCX3, BODY + " Final.")
    assert (final["outcome"], final["revision"]) == ("saved", 3)
    assert event(api, w, token, s["key"], 2, DOCX, BODY)["outcome"] == "closed"     # a replay changes nothing
    assert doc(worker, w, saved["id"])["docx_sha256"] == sha(DOCX3)
    assert run(api, w, None, "select pulse.policy_editor_file(%s) b", (token,))["b"] is None

    # Opened before someone else saved: refused, the newer draft stays.
    token, s = session(api, w, w.manager, saved["id"])
    upload(api, w, w.manager, BODY + " Uploaded meanwhile.", 1, 3, DOCX)
    assert event(api, w, token, s["key"], 2, DOCX2, BODY + " Stale.")["outcome"] == "stale"
    assert doc(worker, w, saved["id"])["body"] == BODY + " Uploaded meanwhile."
    # Opened on the draft, then HR published it: the stale key cannot overwrite or follow the published version.
    token, s = session(api, w, w.manager, saved["id"])
    run(api, w, w.manager, "select pulse.policy_publish(%s,4)", (saved["id"],))
    assert event(api, w, token, s["key"], 2, DOCX2, BODY + " After publish.")["outcome"] == "stale"
    assert run(worker, w, None, "select count(*) n from pulse.policy_document where kind='leave'")["n"] == 1
    assert doc(worker, w, saved["id"])["docx_sha256"] == sha(DOCX)
    # Opened on the published version: a save becomes the next version as a draft; the published one is untouched.
    token, s = session(api, w, w.manager, saved["id"])
    nxt = event(api, w, token, s["key"], 2, DOCX3, BODY + " Version two.")
    assert (nxt["outcome"], nxt["version"], nxt["revision"]) == ("saved", 2, 1)
    assert (doc(worker, w, saved["id"])["status"], doc(worker, w, saved["id"])["docx_sha256"]) == ("published", sha(DOCX))
    # The same bytes as opened are "unchanged"; status 4 closes without saving.
    token, s = session(api, w, w.manager, nxt["id"])
    assert event(api, w, token, s["key"], 2, DOCX3, BODY)["outcome"] == "unchanged"
    token, s = session(api, w, w.manager, nxt["id"])
    assert event(api, w, token, s["key"], 4)["outcome"] == "unchanged"
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        session(api, w, w.editor, nxt["id"])


def test_a_save_rechecks_the_person_the_expiry_and_the_tenant(api, worker, owner, world):
    w = world
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'hr','2020-01-01')", (w.org, w.lead))
    saved = upload(api, w, w.lead, BODY, 0, 1)
    token, s = session(api, w, w.lead, saved["id"])
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.role_assignment set valid_to=current_date-1 where person_id=%s and role_key='hr'", (w.lead,))
    assert event(api, w, token, s["key"], 2, DOCX2, BODY + " Former HR.")["outcome"] == "denied"
    assert doc(worker, w, saved["id"])["docx_sha256"] == sha(DOCX)
    token, s = session(api, w, w.manager, saved["id"])
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("update pulse.policy_editor_session set expires_at=now()-interval '1 minute' where token_hash=%s", (token,))
    assert run(api, w, None, "select pulse.policy_editor_file(%s) b", (token,))["b"] is None
    assert event(api, w, token, s["key"], 2, DOCX2, BODY + " Too late.")["outcome"] == "expired"
    # Another tenant cannot use (or even find) this tenant's session.
    other = build_world(worker, owner, api)
    token, s = session(api, w, w.manager, saved["id"])
    with pytest.raises(psycopg.errors.NoDataFound), api.transaction():
        set_tenant(api, other.org)
        api.execute("select pulse.policy_editor_event(%s,%s,2,%s,%s)", (token, s["key"], DOCX2, BODY))
    with api.transaction():
        set_tenant(api, other.org)
        assert api.execute("select pulse.policy_editor_file(%s) b", (token,)).fetchone()["b"] is None


def test_the_editor_through_the_api_with_a_stand_in_provider(api, worker, world, tmp_path):
    """Upload, download, sessions, signed file fetches and callbacks through the real API (services/api/test/
    policy-word-runner.mjs) against a loopback stand-in for the editor service. Mock evidence, not a provider receipt."""
    from conftest import dsn
    from psycopg.conninfo import conninfo_to_dict
    w = world
    with worker.transaction():
        set_tenant(worker, w.org)
        for pid, who in ((w.manager, "hr"), (w.editor, "member")):
            worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account') on conflict do nothing",
                           (w.org, f"{who}-r41@{w.domain}", pid))

    def config(value):
        d = conninfo_to_dict(value)
        d["database"] = d.pop("dbname")
        return json.dumps(d)
    env = {**os.environ, "PULSE_CI": "1", "PULSE_PUBLIC_LOGIN_ENABLED": "0", "TEST_API_CONFIG": config(dsn("api")),
           "TEST_EMAILS": json.dumps({"hr": f"hr-r41@{w.domain}", "member": f"member-r41@{w.domain}"}), "TEST_TMP": str(tmp_path),
           "PULSE_R41_REPORT": str(tmp_path / "r41.json")}
    p = subprocess.run(["node", "test/policy-word-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api", env=env,
                       capture_output=True, text=True, timeout=600, check=False)
    assert p.returncode == 0, (p.stderr + p.stdout)[-8000:]
    report = json.loads((tmp_path / "r41.json").read_text())
    assert report["checks"] >= 30 and report["evilHits"] == 0
    if os.environ.get("PULSE_R41_RECEIPT"):
        Path(os.environ["PULSE_R41_RECEIPT"]).write_text(json.dumps(report, indent=2) + "\n")
