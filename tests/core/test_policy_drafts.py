"""Policy drafts (migration 0127): HR edits a draft in place, publishes the reviewed revision, published versions stay
immutable and employees never see a draft. All names and documents are synthetic."""
import psycopg
import pytest
from helpers import build_world
from pulse_sdk.db import set_tenant
from test_company import configure

BODY = "# Synthetic policy\n\n## 1. Leave\n\n- Two synthetic days a month **(confirm)**"


def save(api, w, body, version, revision):
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        return api.execute("select pulse.policy_draft_save('leave','Synthetic leave',%s,%s,%s) r", (body, version, revision)).fetchone()["r"]


def test_draft_autosaves_in_place_and_stays_invisible_to_employees(worker, owner, api):
    w = build_world(worker, owner, api)
    configure(worker, w)
    first = save(api, w, BODY, 0, 1)
    assert (first["version"], first["revision"]) == (1, 1)
    again = save(api, w, BODY + "\n- One more synthetic line", 1, 1)
    assert (again["id"], again["version"], again["revision"]) == (first["id"], 1, 2)
    # Nothing changed: no new revision, no audit noise.
    assert save(api, w, BODY + "\n- One more synthetic line", 1, 2)["revision"] == 2
    with pytest.raises(psycopg.errors.SerializationFailure):
        save(api, w, BODY + "\n- A stale tab", 1, 1)
    with pytest.raises(psycopg.errors.SerializationFailure):
        save(api, w, BODY + "\n- Opened before the draft existed", 0, 1)
    with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
        set_tenant(api, w.org, w.editor)
        api.execute("select pulse.policy_draft_save('leave','Synthetic leave',%s,1,2)", (BODY,))
    with pytest.raises(psycopg.errors.InvalidParameterValue), api.transaction():
        set_tenant(api, w.org, w.manager)
        api.execute("select pulse.policy_draft_save(null,'Synthetic leave',%s,1,2)", (BODY,))
    with api.transaction():
        set_tenant(api, w.org, w.editor)
        assert api.execute("select count(*) n from pulse.policy_document").fetchone()["n"] == 0
    with worker.transaction():
        set_tenant(worker, w.org)
        assert worker.execute("select count(*) n from pulse.notification where href like '/me?tab=policies%%'").fetchone()["n"] == 0
        row = worker.execute("select version,revision,status,updated_by from pulse.policy_document where id=%s", (first["id"],)).fetchone()
        assert (row["version"], row["revision"], row["status"], row["updated_by"]) == (1, 2, "draft", w.manager)
        assert worker.execute("select count(*) n from pulse.audit_event where resource='policy_document' and resource_id=%s and action='update'",
                              (str(first["id"]),)).fetchone()["n"] == 1


def test_publish_exact_revision_then_versions_are_immutable(worker, owner, api):
    w = build_world(worker, owner, api)
    configure(worker, w)
    draft = save(api, w, BODY, 0, 1)
    with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
        set_tenant(api, w.org, w.editor)
        api.execute("select pulse.policy_publish(%s,1)", (draft["id"],))
    save(api, w, BODY + "\n- Edited after review", 1, 1)
    with pytest.raises(psycopg.errors.SerializationFailure), api.transaction():
        set_tenant(api, w.org, w.manager)
        api.execute("select pulse.policy_publish(%s,1)", (draft["id"],))
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        published = api.execute("select pulse.policy_publish(%s,2) r", (draft["id"],)).fetchone()["r"]
        assert published["version"] == 1
    with pytest.raises(psycopg.errors.SerializationFailure), api.transaction():
        set_tenant(api, w.org, w.manager)
        api.execute("select pulse.policy_publish(%s,2)", (draft["id"],))
    with pytest.raises(psycopg.errors.InsufficientPrivilege), worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.policy_document set body='Rewritten synthetic history' where id=%s", (draft["id"],))
    with api.transaction():
        set_tenant(api, w.org, w.editor)
        api.execute("select pulse.policy_acknowledge(%s)", (draft["id"],))
    # Editing the published policy starts version 2 as a draft; employees keep reading version 1.
    second = save(api, w, BODY + "\n- Version two", 1, 2)
    assert (second["version"], second["revision"]) == (2, 1)
    with api.transaction():
        set_tenant(api, w.org, w.editor)
        assert [r["version"] for r in api.execute("select version from pulse.policy_document").fetchall()] == [1]
    with pytest.raises(psycopg.errors.InsufficientPrivilege), worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.policy_document set version=3 where id=%s", (second["id"],))
