"""CHAT-ALL: the chat list across a Pulse account's companies (synthetic organisations and people only).

The owner's case (18 Nov 2026): one person in several companies wants one chat list ("All") with each chat tagged by
its company, and a quick switch to one company. GET /api/v0/chats/across reads every seat inside its own organisation as
the account's person there (that organisation's row rules decide), never a company this sign-in may not open yet, and
never a conversation the person is not a member of.
"""
import json
import os
import subprocess
import uuid
from pathlib import Path

import pytest
from conftest import dsn
from psycopg.conninfo import conninfo_to_dict
from pulse_sdk.db import set_tenant
from test_chats import setup
from test_my_day import _account, _other_token, _staff_ready, _token
from test_tasks_rt1 import one


def _say(api, w, who, channel, body):
    one(api, w, who, "select pulse.chat_send(%s,%s,null,'[]'::jsonb,%s,null) id", (channel, body, uuid.uuid4()))


def test_chats_across_reads_each_company_inside_its_own(worker, owner, api):
    a, b, c = setup(worker, owner, api), setup(worker, owner, api), setup(worker, owner, api)
    # Sakobe: editor in a and in b (one account); c is a company he is not in.
    account = _account(owner, (a.org, a.editor), (b.org, b.editor))
    # ACCOUNT-META: the account has a sign-in of its own (a Pulse password), so a company's own sign-in opens that company only.
    with owner.transaction():
        owner.execute("update pulse_priv.pulse_account set password_hash='synthetic-test-hash-not-a-password' where id=%s", (account,))
    ga = one(api, a, a.editor, "select pulse.chat_group_create('Brochure launch (test)',%s) id", ([a.editor2],))["id"]
    gb = one(api, b, b.editor2, "select pulse.chat_group_create('Site visit plan (test)',%s) id", ([b.editor],))["id"]
    secret = one(api, b, b.editor2, "select pulse.chat_group_create('Sales team only (test)',%s) id", ([b.lead],))["id"]
    gc = one(api, c, c.editor2, "select pulse.chat_group_create('Not his company (test)',%s) id", ([c.editor],))["id"]
    _say(api, a, a.editor2, ga, "Proofs are ready")
    _say(api, b, b.editor2, gb, "Can you come at 4?")
    _say(api, b, b.editor2, gb, "Bring the plans")
    _say(api, b, b.editor2, secret, "Sales secret plan")
    _say(api, c, c.editor2, gc, "Nothing for Sakobe")

    def config(value):
        d = conninfo_to_dict(value)
        d["database"] = d.pop("dbname")
        return json.dumps(d)
    env = {**os.environ, "PULSE_CI": "1", "PULSE_PUBLIC_LOGIN_ENABLED": "0", "PULSE_CHAT_DUE": "0", "TEST_API_CONFIG": config(dsn("api")),
           # TOKEN_A: a's own sign-in that proved the person (may open b); TOKEN_B: b opened from it by the account switch.
           "TOKEN_A": _token(api, a, a.editor, a.org, owner), "TOKEN_B": _token(api, a, a.editor, b.org, owner),
           # A company-only sign-in in a (never proved the person on this browser) and a colleague without an account.
           "TOKEN_A_ONLY": _token(api, a, a.editor, a.org), "TOKEN_OTHER": _other_token(owner, a, a.editor2),
           "ORG_A": str(a.org), "ORG_B": str(b.org), "ORG_C": str(c.org), "PERSON_B": str(b.editor), "GA": str(ga), "GB": str(gb)}
    root = Path(__file__).resolve().parents[2] / "services/api"
    p = subprocess.run(["node", "--input-type=module", "-e", API_SCRIPT], cwd=root, env=env, capture_output=True, text=True, timeout=240, check=False)
    assert p.returncode == 0, (p.stderr + p.stdout)[-4000:]


API_SCRIPT = r'''
import { Pool } from 'pg';
import { createApp } from './dist/app.js';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG));
const app = createApp(pool, pool);
const E = process.env;
const call = async (url, token) => { const r = await app.inject({ url, method: 'GET', headers: { 'x-pulse-session': token } }); return { status: r.statusCode, body: r.headers['content-type']?.includes('json') ? r.json() : r.body }; };
const ok = (cond, label, extra) => { if (!cond) { console.error('FAILED', label, JSON.stringify(extra ?? '').slice(0, 2000)); process.exit(1); } };
const text = (r) => JSON.stringify(r.body);

// From a: a is the current company (its list is the page's own), b is read inside b.
let r = await call('/api/v0/chats/across', E.TOKEN_A);
ok(r.status === 200 && Array.isArray(r.body.seats), 'answers', r);
let [sa, sb] = r.body.seats;
ok(r.body.seats.length === 2 && sa.org === E.ORG_A && sa.current && sa.state === 'current' && sa.channels.length === 0, 'a first, current, not read again', r);
ok(sb.org === E.ORG_B && !sb.current && sb.state === 'ok' && sb.viewer === E.PERSON_B, 'b read as his person there', r);
const site = sb.channels.find((c) => c.id === E.GB);
ok(site && site.name === 'Site visit plan (test)' && site.unread === 2 && site.preview === 'Bring the plans', 'his chat in b with its unread and preview', sb.channels);
ok(sb.unreadChats === 1 && sb.unreadMessages === 2, "b's totals", sb);
ok(!text(r).includes('Sales secret plan') && !text(r).includes('Sales team only') && !text(r).includes('Not his company') && !text(r).includes(E.ORG_C), 'nothing he is not a member of, nothing of c', r);

// current=1 reads a too (for a list made without the page's own).
r = await call('/api/v0/chats/across?current=1', E.TOKEN_A);
sa = r.body.seats[0];
ok(sa.state === 'ok' && sa.channels.some((c) => c.id === E.GA && c.unread === 1 && c.preview === 'Proofs are ready'), 'a read when asked', sa);

// From b: the same two companies, b first.
r = await call('/api/v0/chats/across', E.TOKEN_B);
ok(r.status === 200 && r.body.seats[0].org === E.ORG_B && r.body.seats[0].current && r.body.seats[1].org === E.ORG_A && r.body.seats[1].state === 'ok', 'b first from b', r);
ok(r.body.seats[1].channels.some((c) => c.id === E.GA), "a's chat read from b", r.body.seats[1]);

// A company's own sign-in that never proved the person: b is locked and never read.
r = await call('/api/v0/chats/across', E.TOKEN_A_ONLY);
ok(r.status === 200, 'company-only answers', r);
const lb = r.body.seats.find((s) => s.org === E.ORG_B);
ok(lb && lb.state === 'locked' && lb.channels.length === 0 && lb.viewer === null && !text(r).includes('Site visit plan'), 'b locked, nothing of it read', r);

// A colleague without an account: only their own company.
r = await call('/api/v0/chats/across', E.TOKEN_OTHER);
ok(r.status === 200 && r.body.seats.length === 1 && r.body.seats[0].org === E.ORG_A && !text(r).includes(E.ORG_B), 'colleague: their own company only', r);

// Signed out: refused.
r = await call('/api/v0/chats/across', 'nonsense');
ok(r.status === 401 || r.status === 403, 'signed out refused', r);
await app.close(); await pool.end();
'''


def _named(owner, w, org_name, people):
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("update pulse.org set name=%s where id=%s", (org_name, w.org))
        for pid, name in people:
            owner.execute("update pulse.person set display_name=%s where id=%s", (name, pid))


@pytest.mark.skipif(os.environ.get("PULSE_AUTH_BROWSER") != "1", reason="browser checks run in CI with PULSE_AUTH_BROWSER=1")
def test_chats_across_in_the_browser(worker, owner, api):
    a, b = setup(worker, owner, api), setup(worker, owner, api)
    _named(owner, a, "Northstar Realty", [(a.editor, "Kedab Mifos"), (a.editor2, "Asha Kireteso")])
    _named(owner, b, "Brightpath Labs Private Limited", [(b.editor, "Kedab Mifos"), (b.editor2, "Neha Soniba")])
    account = _account(owner, (a.org, a.editor), (b.org, b.editor))
    with owner.transaction():
        # A password of his own (a synthetic bcrypt of random text): his sign-in proves him, so his companies open.
        owner.execute("update pulse_priv.pulse_account set display_name='Kedab Mifos', password_hash=crypt(gen_random_uuid()::text, gen_salt('bf', 4)) where id=%s", (account,))
    for w in (a, b):
        _staff_ready(api, worker, w, w.editor)
    ga = one(api, a, a.editor2, "select pulse.chat_group_create('Brochure launch (test)',%s) id", ([a.editor],))["id"]
    gb = one(api, b, b.editor2, "select pulse.chat_group_create('Site visit plan (test)',%s) id", ([b.editor],))["id"]
    _say(api, a, a.editor2, ga, "Proofs are ready for review")
    _say(api, b, b.editor2, gb, "Can you come at 4?")
    _say(api, b, b.editor2, gb, "Bring the plans")
    token = _token(api, a, a.editor, a.org, owner)
    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    # The browser signs in with the session cookie (Pulse passwords), not an Access header.
    env = {**os.environ, "PULSE_CI": "1", "PULSE_CHAT_DUE": "0", "PULSE_PUBLIC_LOGIN_ENABLED": "1", "TEST_API_CONFIG": json.dumps(config),
           "TEST_IDS": json.dumps({"token": token, "orgA": str(a.org), "orgB": str(b.org), "nameA": "Northstar Realty", "nameB": "Brightpath Labs Private Limited",
                                   "shortB": "Brightpath Labs", "groupA": "Brochure launch (test)", "groupB": "Site visit plan (test)", "gb": str(gb)})}
    p = subprocess.run(["node", "test/chats-across-browser-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api", env=env,
                       capture_output=True, text=True, timeout=1800, check=False)
    assert p.returncode == 0, p.stderr[-4000:] + p.stdout[-4000:]
    print(p.stdout[-600:])
