"""UX-NOTIFY: the notification panel's contract (GET /api/v0/notices, POST /api/v0/notices/read and /read-all) and its
browser flows (the bell's panel, Pip's island) on a disposable synthetic tenant. No real data."""
import json
import os
import subprocess
import uuid
from pathlib import Path

import pytest
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from test_tasks_rt1 import new_task, one, team  # noqa: F401  (team is a fixture)
from test_work_structure import ask

NOTICES_API = r'''
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { createApp } from './dist/app.js';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG));
const app = createApp(pool, pool);
const E = JSON.parse(process.env.TEST_IDS);
const emails = { member: process.env.TEST_MEMBER, head: process.env.TEST_HEAD, outsider: process.env.TEST_OUTSIDER_EMAIL, hr: 'hr@estateautopilots.com' };
const call = async (path, role, body) => {
  const r = await app.inject({ url: '/api/v0/' + path, method: body === undefined ? 'GET' : 'POST', headers: { 'cf-access-authenticated-user-email': emails[role] }, ...(body === undefined ? {} : { payload: body }) });
  let json = null; try { json = r.json(); } catch { /* empty */ }
  return { status: r.statusCode, body: json };
};
const ok = (c, m, r) => assert.ok(c, `${m}: ${JSON.stringify(r?.body ?? r).slice(0, 1500)}`);
const post = (role, action, extra = {}) => call(action.path.replace(/^\/api\/v0\//, ''), role, { ...(action.body ?? {}), ...extra });

// The member: an ask to take a task (Needs your action), a direct message (one card per conversation, Reply), a mention.
let r = await call('notices', 'member');
ok(r.status === 200 && Array.isArray(r.body.rows), 'member reads the panel', r);
const askCard = r.body.rows.find((n) => n.subject?.id === E.task && n.eventType === 'task.ask');
ok(askCard && askCard.group === 'action' && askCard.state === 'open' && askCard.actions.map((a) => a.label).join() === 'Take it,Decline' && askCard.from?.id === E.head, 'ask with Take it and Decline', r);
const chat = r.body.rows.find((n) => n.subject?.type === 'chat');
ok(chat && chat.channelId === E.channel && chat.ids.length === 2 && chat.unread === 2 && chat.body === 'Second line from the head' && chat.actions[0].key === 'reply'
  && chat.actions[0].path === `/api/v0/chats/${E.channel}/messages` && chat.actions[0].body.clientId === 'new', 'two messages fold into one conversation card with Reply', r);
ok(r.body.rows.filter((n) => n.subject?.type === 'chat').length === 1, 'one card per conversation', r);
const mention = r.body.rows.find((n) => n.eventType === 'task.mention');
ok(mention && mention.group === 'mention' && mention.actions[0]?.key === 'reply', 'mention under Mentions with Reply', r);
ok(r.body.counts.unread >= 3 && r.body.counts.action >= 1 && r.body.today && typeof r.body.today.due === 'number', 'counts and today', r);
ok(!r.body.rows.some((n) => n.eventType === 'approval.waiting'), 'the requester is not asked to approve their own leave', r);

// The pod head: the member's leave, with Approve and Reject (Reject asks for a reason).
r = await call('notices', 'head');
const approval = r.body.rows.find((n) => n.eventType === 'approval.waiting');
ok(approval && approval.group === 'action' && /^Synthetic asks for leave/.test(approval.title) && approval.actions.map((a) => a.key).join() === 'approve,reject'
  && approval.actions[1].fields[0].type === 'text' && approval.subject.title === 'Leave', 'pod head can approve or reject', r);
// Nobody marks someone else's notifications.
r = await call('notices/read', 'member', { ids: approval.ids });
ok(r.status === 200 && r.body.read === 0, 'member cannot mark the head\'s notification', r);
r = await call('notices/read', 'outsider', { ids: askCard.ids });
ok(r.status === 200 && r.body.read === 0, 'outsider cannot mark the member\'s notification', r);
r = await call('notices', 'outsider');
ok(r.status === 200 && !r.body.rows.some((n) => askCard.ids.includes(n.id) || approval.ids.includes(n.id)), 'outsider sees none of them', r);
for (const bad of [{ ids: [] }, { ids: ['nope'] }, { ids: Array(201).fill(askCard.id) }, { ids: askCard.ids, extra: 1 }]) {
  r = await call('notices/read', 'member', bad); ok(r.status === 400, 'invalid read body', r);
}
// Reject needs a reason; Approve is one tap and the card then says so.
r = await post('head', approval.actions[1]);
ok(r.status === 400, 'reject without a reason', r);
r = await post('head', approval.actions[0]);
ok(r.status === 200, 'approve from the panel', r);
r = await call('notices', 'head');
// The waiting card goes (or stays without buttons); the decision arrives as an update with the request's state.
ok(!r.body.rows.some((n) => n.id === approval.id && (n.group === 'action' || n.actions.length)), 'a decided request leaves Needs your action', r);
ok(r.body.rows.some((n) => n.subject?.id === approval.subject.id && n.group === 'update' && n.state === 'approved' && !n.actions.length), 'the decision shows as approved', r);

// The member takes the task, replies in the conversation and reads it from the panel.
r = await post('member', askCard.actions[0]);
ok(r.status === 200, 'take it', r);
r = await post('member', chat.actions[0], { clientId: crypto.randomUUID(), body: 'Reply from the panel' });
ok(r.status === 200 && r.body.message?.body === 'Reply from the panel', 'reply in the conversation', r);
r = await call('notices/read', 'member', { ids: chat.ids });
ok(r.status === 200 && r.body.read === 2 && r.body.conversations === 1, 'reading the card reads the conversation', r);
r = await call('notices', 'member');
ok(r.body.rows.filter((n) => n.subject?.type === 'chat').every((n) => n.readAt && !n.unread), 'the conversation card is read', r);
r = await call('companion/updates', 'member');
ok(r.status === 200 && r.body.counts.chats === 0, 'the conversation is read too', r);
r = await call('notices', 'member');
ok(r.body.rows.find((n) => n.id === askCard.id)?.state === 'accepted', 'ask answered', r);
ok(r.body.counts.unread >= 1, 'something left unread', r);
r = await call('notices/read-all', 'member', {});
ok(r.status === 200 && r.body.read >= 1, 'mark all read', r);
r = await call('notices', 'member');
ok(r.body.counts.unread === 0 && r.body.rows.every((n) => n.readAt), 'everything read', r);
console.log(JSON.stringify({ ok: true }));
await app.close(); await pool.end();
'''


def _config(value):
    from psycopg.conninfo import conninfo_to_dict
    d = conninfo_to_dict(value)
    d["database"] = d.pop("dbname")
    return json.dumps(d)


def _world(api, worker, w):
    """Synthetic arrivals for the member (editor) and the pod head (editor2)."""
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.person set display_name='Synthetic Member' where id=%s", (w.editor,))
        worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')", (w.org, f"outsider@{w.domain}", w.outsider))
    task = new_task(api, w, w.editor2, title="Cut the Lakeview teaser")
    ask(api, w, w.editor2, "take", to=w.editor, task=task)
    talk = new_task(api, w, w.editor2, title="Drone permit", assigneeId=str(w.editor))
    one(api, w, w.editor2, "select pulse.work_comment_add(%s,null,%s,%s) id", (talk, "@Synthetic Member can you send the site plan?", [w.editor]))
    with api.transaction():
        set_tenant(api, w.org, w.editor2)
        channel = api.execute("select pulse.chat_direct(%s) id", (w.editor,)).fetchone()["id"]
        for body in ("First line from the head", "Second line from the head"):
            api.execute("select pulse.chat_send(%s,%s,null,'[]'::jsonb,%s,null)", (channel, body, uuid.uuid4()))
    with api.transaction():
        set_tenant(api, w.org, w.editor)
        api.execute("insert into pulse.leave_request(org_id,person_id,from_date,to_date,leave_kind,days,reason) values(%s,%s,(now() at time zone 'Asia/Kolkata')::date+9,(now() at time zone 'Asia/Kolkata')::date+9,'casual',1,'Synthetic family event')", (w.org, w.editor))
    return {"member": str(w.editor), "head": str(w.editor2), "outsider": str(w.outsider), "task": str(task), "channel": str(channel)}


def _env(w, ids, **extra):
    from conftest import dsn
    return {**os.environ, "PULSE_CI": "1", "PULSE_NOTIFICATION_MODE": "sink", "PULSE_PUBLIC_LOGIN_ENABLED": "0", "TEST_API_CONFIG": _config(dsn("api")),
            "TEST_MEMBER": w.editor_handle, "TEST_HEAD": f"editor2@{w.domain}", "TEST_OUTSIDER_EMAIL": f"outsider@{w.domain}", "TEST_IDS": json.dumps(ids), **extra}


def test_notices_api(worker, owner, api, team):
    w = team
    ids = _world(api, worker, w)
    root = Path(__file__).resolve().parents[2] / "services/api"
    p = subprocess.run(["node", "--input-type=module", "-e", NOTICES_API], cwd=root, env=_env(w, ids), capture_output=True, text=True, timeout=240)
    assert p.returncode == 0, (p.stderr + p.stdout)[-4000:]


@pytest.mark.skipif(os.environ.get("PULSE_AUTH_BROWSER") != "1", reason="browser checks run in CI with PULSE_AUTH_BROWSER=1")
def test_notify_in_the_browser(worker, owner, api, team, tmp_path):
    from test_work_structure import _seed_showcase
    w = team
    seeded = _seed_showcase(api, worker, w)
    # ATT (0860): a family pings a person at most notification_daily_pings times in 24 hours (tasks_assigned: 6) and
    # the rest wait quietly in the bell. The showcase assigns the member six tasks at once, which would leave every
    # later ask in this test quiet, so the island would never spring open for it. Those assignments count as
    # yesterday's (they stay in the bell); the asks the runner makes then ping as a fresh day's would.
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.notification set created_at=created_at-interval '25 hours' where person_id=%s and event_type='task.assigned'", (w.editor,))
    ids = {**_world(api, worker, w), "fulfilment": seeded["fulfilment"]}
    with api.transaction():
        set_tenant(api, w.org, w.editor)
        api.execute("select pulse.task_save(null,%s)", (Jsonb({"title": "Storyboard the Northstar reel", "assigneeId": str(w.editor), "dueOn": None}),))
    env = _env(w, ids, PULSE_NOTIFY_REPORT=str(tmp_path / "notify.json"))
    p = subprocess.run(["node", "test/notify-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api", env=env, capture_output=True, text=True, timeout=1800, check=False)
    assert p.returncode == 0, (p.stderr + p.stdout)[-6000:]
    report = json.loads((tmp_path / "notify.json").read_text())
    assert report["browserChecks"] >= 24
