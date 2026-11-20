"""WL-FINANCE-CLEAN (2495): a quotation is archived (kept as it was, left out of every read the app makes: the API's,
the workers' and the definer functions'), optionally as superseded by the live quotation that replaces it, and
unarchived exactly back (its client links and its follow-up too). Who may, and what may not be archived. Synthetic
company, people, clients and figures only."""
import hashlib
import json
import os
import subprocess
import uuid
from pathlib import Path

import psycopg
import pytest
from pulse_sdk.db import set_tenant
from test_erp_invoice import as_, draft, erp, issue, one, person  # noqa: F401  (erp is a fixture)
from test_quote_followups import at, followup, ist, own, sent, tasks, tick  # noqa: F401  (ist is a fixture)

NOTE = "cleaned by owner order (synthetic)"


def archive(api, w, who, q, note=NOTE, by=None):
    return one(api, w, who, "select pulse.erp_document_archive(%s,%s,%s) r", (q, note, by))["r"]


def unarchive(api, w, who, q, note=None):
    return one(api, w, who, "select pulse.erp_document_unarchive(%s,%s) r", (q, note))["r"]


def kept(owner, w, q):
    """The row as the database keeps it (read the way the archive functions do)."""
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("select set_config('pulse.erp_archived','show',true)")
        return owner.execute("select * from pulse.erp_document where id=%s", (q,)).fetchone()


def seen(conn, w, q, who=None):
    with conn.transaction():
        set_tenant(conn, w.org, who) if who else set_tenant(conn, w.org)
        return conn.execute("select count(*) n from pulse.erp_document where id=%s", (q,)).fetchone()["n"]


def test_an_archived_quotation_is_kept_and_left_out_of_every_read(api, owner, worker, erp):
    w = erp
    q = draft(api, w, w.finance, "quotation")
    issue(api, w, w.finance, q)
    other = draft(api, w, w.finance, "quotation", day="2026-04-03")
    issue(api, w, w.finance, other)
    d = draft(api, w, w.finance, "quotation")                       # a draft never issued
    before = kept(owner, w, q)
    open_quotes = "select count(*) filter (where doc_type='quotation' and status in ('issued','sent')) n, count(*) filter (where status='draft') drafts from pulse.erp_document"
    assert one(api, w, w.finance, open_quotes) == {"n": 2, "drafts": 1}

    r = archive(api, w, w.finance, q)
    assert r["number"] == before["number"] and r["status"] == "issued" and r["linksStopped"] == 0 and "supersededBy" not in r
    with api.transaction():                                         # the rest of the caller's transaction does not see it either
        set_tenant(api, w.org, w.founder)
        api.execute("select pulse.erp_document_archive(%s,'an old draft, never sent')", (d,))
        assert api.execute("select count(*) n from pulse.erp_document where id=%s", (d,)).fetchone()["n"] == 0
        assert api.execute("select current_setting('pulse.erp_archived',true) s").fetchone()["s"] in ("", None)
        api.execute("select pulse.erp_archived_list()")
        assert api.execute("select count(*) n from pulse.erp_document where id=%s", (d,)).fetchone()["n"] == 0

    # Gone from every read: the API's (lists and totals), the workers', and the owner's (definer functions).
    assert one(api, w, w.finance, open_quotes) == {"n": 1, "drafts": 0}
    assert seen(api, w, q, w.finance) == 0 and seen(api, w, q, w.founder) == 0
    assert seen(worker, w, q) == 0 and seen(owner, w, q) == 0
    assert seen(api, w, other, w.finance) == 1
    # Kept exactly as it was, with its lines.
    after = kept(owner, w, q)
    for k in ("status", "number", "total", "buyer", "issued_at", "superseded_by", "decision"):
        assert after[k] == before[k], k
    assert after["archived_by"] == w.finance and after["archive_note"] == NOTE and after["archived_at"] is not None
    with owner.transaction():
        set_tenant(owner, w.org)
        assert owner.execute("select count(*) n from pulse.erp_line where document_id=%s", (q,)).fetchone()["n"] == 1
    # Nobody changes or deletes an archived row past the functions (an update or a delete finds nothing).
    assert as_(api, w, w.finance, "update pulse.erp_document set notes='x' where id=%s returning id", (q,)) == []
    assert as_(api, w, w.finance, "delete from pulse.erp_document where id=%s returning id", (d,)) == []
    assert kept(owner, w, d)["status"] == "draft"
    # ... nor archives one by writing the table.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.finance, "update pulse.erp_document set archived_at=now(),archive_note='x' where id=%s", (other,))
    # The Archived list, the ERP log and Audit.
    listed = one(api, w, w.finance, "select pulse.erp_archived_list() r")["r"]
    assert [x["id"] for x in listed] == [str(d), str(q)]
    assert listed[1]["number"] == before["number"] and listed[1]["note"] == NOTE and listed[1]["archivedBy"] == "Synthetic Finance"
    ev = as_(api, w, w.finance, "select kind,detail,actor from pulse.erp_event where subject_id=%s and kind='archived'", (q,))
    assert len(ev) == 1 and ev[0]["detail"]["number"] == before["number"] and ev[0]["detail"]["note"] == NOTE and ev[0]["actor"] == w.finance
    with owner.transaction():
        set_tenant(owner, w.org)
        audit = owner.execute("select fields from pulse.audit_event where resource='erp_document' and resource_id=%s and action='update'", (str(q),)).fetchall()
    assert any("archived_at" in a["fields"] for a in audit)
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="already archived"):
        archive(api, w, w.finance, q)

    # Unarchived: back in every read, as it was.
    r = unarchive(api, w, w.finance, q, "archived by mistake")
    assert r["number"] == before["number"] and r["linksBack"] == 0 and r["followupBack"] is False
    assert seen(api, w, q, w.finance) == 1 and seen(worker, w, q) == 1 and seen(owner, w, q) == 1
    back = one(api, w, w.finance, "select * from pulse.erp_document where id=%s", (q,))
    for k in ("status", "number", "total", "buyer", "issued_at", "superseded_by", "decision"):
        assert back[k] == before[k], k
    assert back["archived_at"] is None and back["archived_by"] is None and back["archive_note"] is None and back["archive_undo"] is None
    assert one(api, w, w.finance, open_quotes) == {"n": 2, "drafts": 0}
    assert [x["id"] for x in one(api, w, w.finance, "select pulse.erp_archived_list() r")["r"]] == [str(d)]
    assert [e["kind"] for e in as_(api, w, w.finance, "select kind from pulse.erp_event where subject_id=%s order by at,kind", (q,))][-2:] == ["archived", "unarchived"]
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="not archived"):
        unarchive(api, w, w.finance, q)
    # An unarchived draft is a draft again: it can be edited.
    unarchive(api, w, w.founder, d)
    assert as_(api, w, w.finance, "update pulse.erp_document set notes='back' where id=%s returning notes", (d,)) == [{"notes": "back"}]


def test_superseded_by_the_quotation_that_replaces_it_and_undone(api, owner, erp):
    w = erp
    a, b, c, gone = (draft(api, w, w.finance, "quotation") for _ in range(4))
    for q in (a, b, c, gone):
        issue(api, w, w.finance, q)
    inv = draft(api, w, w.finance, "invoice")
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="cannot replace itself"):
        archive(api, w, w.finance, a, by=a)
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="live quotation"):
        archive(api, w, w.finance, a, by=inv)
    archive(api, w, w.finance, gone)
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="live quotation"):
        archive(api, w, w.finance, a, by=gone)                     # an archived one replaces nothing
    num_b = one(api, w, w.finance, "select number from pulse.erp_document where id=%s", (b,))["number"]

    r = archive(api, w, w.finance, a, "a duplicate of the one the customer took", by=b)
    assert r["supersededBy"] == str(b) and r["supersededByNumber"] == num_b
    assert kept(owner, w, a)["superseded_by"] == b and kept(owner, w, a)["status"] == "issued"
    row = [x for x in one(api, w, w.finance, "select pulse.erp_archived_list() r")["r"] if x["id"] == str(a)][0]
    assert row["supersededBy"] == str(b) and row["supersededByNumber"] == num_b
    unarchive(api, w, w.finance, a)
    assert one(api, w, w.finance, "select superseded_by from pulse.erp_document where id=%s", (a,))["superseded_by"] is None

    # A revision's own "superseded by" (1842) is kept through archive and unarchive, and not replaced.
    own(owner, w, "update pulse.erp_document set superseded_by=%s where id=%s", (b, c))
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="Another version"):
        archive(api, w, w.finance, c, by=a)
    archive(api, w, w.finance, c, by=b)
    unarchive(api, w, w.finance, c)
    assert one(api, w, w.finance, "select superseded_by from pulse.erp_document where id=%s", (c,))["superseded_by"] == b


def test_client_links_and_the_follow_up_stop_and_come_back(api, owner, worker, ist):
    w = ist
    q = sent(api, owner, w, at(2026, 10, 20, 10, 30))
    token = hashlib.sha256(b"synthetic-archive-token").hexdigest()
    one(api, w, w.finance, "select pulse.erp_accept_link_create(%s,%s,30)", (q, token))
    assert one(api, w, None, "select pulse.erp_accept_open(%s) r", (token,))["r"]["canDecide"]
    assert tick(worker, w, at(2026, 10, 22, 9, 0)) == {"due": 1, "told": 1}
    [t] = tasks(owner, w, q)
    assert t["status"] == "open"
    due = followup(owner, w, q)["next_due_at"]

    r = archive(api, w, w.finance, q, "superseded by the option the customer took")
    assert r["linksStopped"] == 1 and r["followupStopped"] is True
    assert one(api, w, None, "select pulse.erp_accept_open(%s) r", (token,))["r"] is None      # the customer's link stops
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        one(api, w, None, "select pulse.erp_accept_decide(%s,'accepted','Asha Kireteso',null,%s,'test')", (token, "a" * 64))
    f = followup(owner, w, q)
    assert f["state"] == "stopped" and f["stopped_reason"] == "archived" and f["next_due_at"] is None
    assert [x["status"] for x in tasks(owner, w, q)] == ["cancelled"]
    assert tick(worker, w, at(2026, 10, 30, 9, 0)) == {"due": 0, "told": 0}                 # nothing comes back while archived

    r = unarchive(api, w, w.finance, q)
    assert r["linksBack"] == 1 and r["followupBack"] is True
    assert one(api, w, None, "select pulse.erp_accept_open(%s) r", (token,))["r"]["canDecide"]
    f = followup(owner, w, q)
    assert f["state"] == "scheduled" and f["stopped_reason"] is None and f["next_due_at"] >= due
    with owner.transaction():
        set_tenant(owner, w.org)
        now = owner.execute("select now() n").fetchone()["n"]
    assert tick(worker, w, max(f["next_due_at"], now)) == {"due": 1, "told": 1}              # the follow-up task is made again
    assert sorted(x["status"] for x in tasks(owner, w, q)) == ["cancelled", "open"]
    # A link the customer already answered stays answered through archive and unarchive.
    one(api, w, None, "select pulse.erp_accept_decide(%s,'accepted','Asha Kireteso','Go ahead',%s,'test')", (token, "a" * 64))
    archive(api, w, w.finance, q)
    assert one(api, w, None, "select pulse.erp_accept_open(%s) r", (token,))["r"] is None
    unarchive(api, w, w.finance, q)
    seen_link = one(api, w, None, "select pulse.erp_accept_open(%s) r", (token,))["r"]
    assert seen_link["decision"] == "accepted" and not seen_link["canDecide"]
    assert one(api, w, w.finance, "select status from pulse.erp_document where id=%s", (q,))["status"] == "accepted"


def test_who_may_archive_and_what(api, owner, worker, erp):
    w = erp
    q = draft(api, w, w.finance, "quotation")
    issue(api, w, w.finance, q)
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        archive(api, w, w.member, q)                               # no Billing access
    seller = person(worker, w, "Synthetic Seller", "sales")
    mine = draft(api, w, seller, "quotation")
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="leadership, admins and the Finance role"):
        archive(api, w, seller, mine)                              # a sales seat, even their own deal
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        one(api, w, seller, "select pulse.erp_archived_list() r")
    bot = uuid.uuid4()                                             # an AI employee with the Billing tool (it writes Billing)
    with owner.transaction():
        role = owner.execute("select pg_get_userbyid(nspowner) r from pg_namespace where nspname='pulse'").fetchone()["r"]
        owner.execute(f"set local role {role}")
        set_tenant(owner, w.org)
        owner.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,'Synthetic AI Employee','agent')", (bot, w.org))
        owner.execute("insert into pulse.agent_member(org_id,person_id,owner_person_id,employee_no,employee_id,tools) values(%s,%s,%s,951,'SY-QA-001',%s)",
                      (w.org, bot, w.founder, ["billing"]))
    with api.transaction():
        set_tenant(api, w.org, bot)
        api.execute("select set_config('pulse.agent_session','on',true)")
        assert api.execute("select pulse.erp_can(true) w").fetchone()["w"] is True
        with pytest.raises(psycopg.errors.InsufficientPrivilege, match="not an AI employee"):
            api.execute("select pulse.erp_document_archive(%s,%s)", (q, NOTE))
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="Say why"):
        archive(api, w, w.finance, q, "  ")
    inv = draft(api, w, w.finance, "invoice")
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="Only a quotation"):
        archive(api, w, w.finance, inv)
    conv = draft(api, w, w.finance, "quotation")
    issue(api, w, w.finance, conv)
    own(owner, w, "update pulse.erp_document set status='converted' where id=%s", (conv,))
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="became an invoice"):
        archive(api, w, w.finance, conv)
    with pytest.raises(psycopg.errors.NoDataFound):
        archive(api, w, w.finance, "00000000-0000-4000-8000-000000000000")
    # Another company never sees, archives or unarchives this one's.
    from helpers import build_world
    from test_erp_invoice import setup_company
    o = build_world(worker, owner, api)
    o.finance = person(worker, o, "Other Finance", "finance")
    setup_company(api, o, person(worker, o, "Other Founder", "leadership"))
    with pytest.raises(psycopg.errors.NoDataFound):
        archive(api, o, o.finance, q)
    archive(api, w, w.finance, q)
    with pytest.raises(psycopg.errors.NoDataFound):
        unarchive(api, o, o.finance, q)
    assert one(api, o, o.finance, "select pulse.erp_archived_list() r")["r"] == []


API = r'''
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { createApp } from './dist/app.js';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)), app = createApp(pool, pool);
const { a, b, emails } = JSON.parse(process.env.TEST_IDS);
const call = async (who, method, url, payload) => {
  const r = await app.inject({ url, method, headers: { 'cf-access-authenticated-user-email': emails[who] }, ...(payload ? { payload } : {}) });
  return { status: r.statusCode, body: r.json() };
};
let r = await call('member', 'POST', `/api/v0/erp/documents/${a}/archive`, { note: 'not mine to archive' });
assert.equal(r.status, 403, JSON.stringify(r));
r = await call('finance', 'POST', `/api/v0/erp/documents/${a}/archive`, { note: ' ' });
assert.ok(r.status === 400 && r.body.error === 'Say why it is archived', JSON.stringify(r));
r = await call('finance', 'POST', `/api/v0/erp/documents/${a}/archive`, { note: 'duplicate', supersededBy: 'nope' });
assert.equal(r.status, 400, JSON.stringify(r));
r = await call('finance', 'POST', `/api/v0/erp/documents/${a}/archive`, { note: 'a duplicate of the one the customer took', supersededBy: b });
assert.ok(r.status === 200 && r.body.supersededBy === b && r.body.number, JSON.stringify(r));
r = await call('finance', 'GET', `/api/v0/erp/documents/${a}`);
assert.equal(r.status, 404, 'an archived quotation is not opened: ' + JSON.stringify(r));
r = await call('finance', 'GET', '/api/v0/erp/documents?type=quotation');
assert.ok(r.status === 200 && !JSON.stringify(r.body).includes(a), 'nor listed: ' + JSON.stringify(r).slice(0, 400));
r = await call('finance', 'GET', '/api/v0/erp/documents/archived');
assert.ok(r.status === 200 && r.body.documents.length === 1 && r.body.documents[0].id === a && r.body.documents[0].supersededBy === b, JSON.stringify(r));
r = await call('member', 'GET', '/api/v0/erp/documents/archived');
assert.equal(r.status, 403, JSON.stringify(r));
r = await call('finance', 'POST', `/api/v0/erp/documents/${a}/unarchive`, { note: 'archived by mistake' });
assert.ok(r.status === 200 && r.body.id === a, JSON.stringify(r));
r = await call('finance', 'GET', `/api/v0/erp/documents/${a}`);
assert.equal(r.status, 200, JSON.stringify(r).slice(0, 300));
r = await call('finance', 'POST', `/api/v0/erp/documents/${a}/unarchive`, {});
assert.ok(r.status === 400 && r.body.error === 'This quotation is not archived', JSON.stringify(r));
r = await call('finance', 'POST', '/api/v0/erp/documents/not-a-uuid/archive', { note: 'x y z' });
assert.equal(r.status, 404, JSON.stringify(r));
await app.close(); await pool.end();
'''


def test_archive_and_unarchive_through_the_api(api, owner, worker, erp):
    from conftest import dsn
    from psycopg.conninfo import conninfo_to_dict
    w = erp
    emails = {"finance": f"finance@{w.domain}", "member": f"member@{w.domain}"}
    with worker.transaction():
        set_tenant(worker, w.org)
        for who, pid in [("finance", w.finance), ("member", w.member)]:
            worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')",
                           (w.org, emails[who], pid))
    a, b = draft(api, w, w.finance, "quotation"), draft(api, w, w.finance, "quotation")
    issue(api, w, w.finance, a)
    issue(api, w, w.finance, b)
    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    env = {**os.environ, "PULSE_CI": "1", "TEST_API_CONFIG": json.dumps(config), "TEST_IDS": json.dumps({"a": str(a), "b": str(b), "emails": emails})}
    p = subprocess.run(["node", "--input-type=module", "-e", API], cwd=Path(__file__).resolve().parents[2] / "services/api",
                       env=env, capture_output=True, text=True, timeout=240, check=False)
    assert p.returncode == 0, (p.stderr + p.stdout)[-4000:]
