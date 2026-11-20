"""FIX-BILLING (19 Nov 2026), through the API on a scratch database. Synthetic company, people and figures only.

BC-035 (2441): how many days a new quotation stays valid is the company's own setting (30 until it sets one).
BC-066: a quotation drafted one day and approved as it stands after a later one in its series was numbered is dated
the day it is approved (its validity moves with it, and its history says so); an invoice keeps the date a person chose.
"""
import json
import os
import subprocess
from datetime import timedelta
from pathlib import Path

from psycopg.conninfo import conninfo_to_dict
from pulse_sdk.db import set_tenant
from test_erp_invoice import draft, erp, issue, one  # noqa: F401  (erp is a fixture)

API = r'''
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { createApp } from './dist/app.js';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)), app = createApp(pool, pool);
const { emails, oldQuote, oldInvoice, today } = JSON.parse(process.env.TEST_IDS);
const call = async (who, url, body) => {
  const r = await app.inject({ url: `/api/v0/${url}`, method: body ? 'POST' : 'GET', headers: { 'cf-access-authenticated-user-email': emails[who] }, ...(body ? { payload: body } : {}) });
  return { status: r.statusCode, body: r.json() };
};
const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
const quote = async () => {
  const made = await call('finance', 'erp/documents', { docType: 'quotation' });
  assert.equal(made.status, 200, JSON.stringify(made));
  const r = await call('finance', `erp/documents/${made.body.id ?? made.body.document?.id}`);
  return r.body.document ?? r.body;
};

// BC-035: 30 days until the company sets its own; then every new quotation takes it.
let s = await call('founder', 'erp/settings');
assert.equal(s.body.quoteValidDays, 30, JSON.stringify(s.body).slice(0, 300));
let q = await quote();
assert.equal(days(q.issueDate, q.validUntil), 30, JSON.stringify(q));
const keep = { company: s.body.company, inventoryEnabled: s.body.inventoryEnabled, dueDays: s.body.dueDays, roundTotal: s.body.roundTotal };
for (const bad of [0, 366, 2.5, 'seven']) assert.equal((await call('founder', 'erp/settings', { ...keep, quoteValidDays: bad })).status, 400, `refused: ${bad}`);
assert.equal((await call('founder', 'erp/settings', { ...keep, quoteValidDays: 7 })).status, 200);
assert.equal((await call('founder', 'erp/settings')).body.quoteValidDays, 7);
q = await quote();
assert.equal(days(q.issueDate, q.validUntil), 7, JSON.stringify(q));
// A screen that does not send it keeps the saved one.
assert.equal((await call('founder', 'erp/settings', keep)).status, 200);
assert.equal((await call('founder', 'erp/settings')).body.quoteValidDays, 7);

// BC-066: approved as it stands, yesterday's quotation is dated today and keeps its 30-day window.
let r = await call('finance', `erp/documents/${oldQuote}/issue`, {});
assert.equal(r.status, 200, JSON.stringify(r));
q = (await call('finance', `erp/documents/${oldQuote}`)).body;
q = q.document ?? q;
assert.ok(q.number && q.issueDate === today && days(q.issueDate, q.validUntil) === 30, JSON.stringify(q));
// An invoice keeps its date: the series still asks for one on or after the latest.
r = await call('finance', `erp/documents/${oldInvoice}/issue`, {});
assert.ok(r.status === 400 && /on or after it/.test(JSON.stringify(r.body)), JSON.stringify(r));
await app.close(); await pool.end();
'''


def test_quotation_validity_setting_and_approving_an_earlier_draft(api, worker, owner, erp):  # noqa: F811
    from conftest import dsn
    w = erp
    emails = {"founder": f"founder@{w.domain}", "finance": f"finance@{w.domain}"}
    with worker.transaction():
        set_tenant(worker, w.org)
        for who, pid in [("founder", w.founder), ("finance", w.finance)]:
            worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')",
                           (w.org, emails[who], pid))
    today = one(api, w, w.finance, "select (now() at time zone pulse.org_time_zone())::date d")["d"]
    yesterday = today - timedelta(days=1)
    # Today's first quotation and invoice are numbered; then yesterday's drafts come up for approval.
    for doc_type in ("quotation", "invoice"):
        issue(api, w, w.finance, draft(api, w, w.finance, doc_type, day=today.isoformat(), client=w.client))
    old_quote = draft(api, w, w.finance, "quotation", day=yesterday.isoformat(), client=w.client)
    one(api, w, w.finance, "update pulse.erp_document set valid_until=%s where id=%s returning id", (yesterday + timedelta(days=30), old_quote))
    old_invoice = draft(api, w, w.finance, "invoice", day=yesterday.isoformat(), client=w.client)
    # Issued through the API, a GST-registered buyer needs a billing address (the SQL helper's drafts carry none).
    one(api, w, w.finance, """update pulse.erp_document set buyer=buyer||'{"address":["1 Synthetic Road, Pune 411001"]}'::jsonb
        where id=any(%s) returning id""", ([old_quote, old_invoice],))
    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    ids = {"emails": emails, "oldQuote": str(old_quote), "oldInvoice": str(old_invoice), "today": today.isoformat()}
    env = {**os.environ, "PULSE_CI": "1", "TEST_API_CONFIG": json.dumps(config), "TEST_IDS": json.dumps(ids)}
    p = subprocess.run(["node", "--input-type=module", "-e", API], cwd=Path(__file__).resolve().parents[2] / "services/api",
                       env=env, capture_output=True, text=True, timeout=240, check=False)
    assert p.returncode == 0, (p.stderr + p.stdout)[-4000:]
    with owner.transaction():
        set_tenant(owner, w.org)
        kinds = [r["kind"] for r in owner.execute("select kind from pulse.erp_event where subject_id=%s and kind in ('redated','issued') order by at", (old_quote,)).fetchall()]
    assert kinds == ["redated", "issued"], kinds
