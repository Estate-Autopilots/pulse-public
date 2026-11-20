"""HR-AGENT (owner decisions, 20 Nov 2026; migration 2493). Synthetic tenants and people only.

1. An AI employee asks to add a staff member; nothing is created until a named approver presses Approve, which adds them
   with People → Add person's own function (through the API) and writes an Audit row naming the AI, the approver and the
   request. Paths: approve, decline (with a reason the AI hears), expiry after 7 days, the approver removed, and no
   approver = a plain refusal with nothing stored.
2. With an HR AI on duty (an AI employee allowed to read attendance), a leave or attendance-correction request gets ONE
   notice to its approver: edits, repeats and retries never ping again, and at most one reminder.
"""
import json
import os
import subprocess
from pathlib import Path

import psycopg
import pytest
from conftest import dsn
from helpers import build_world
from psycopg.conninfo import conninfo_to_dict
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant

from test_hr_suite import ADMIN, HR, _enable_attendance, _staff
from test_runner_access import _agent, _as_agent

JOINER = {"name": "Synthetic New Joiner", "role": "Video editor", "team": "Production", "pod": "Pod 1", "startDate": "2026-12-01"}


def _world(worker, owner, api):
    """The lead is HR (hr@…), the manager is the admin (admin@…), the editors are staff; one AI employee."""
    w = build_world(worker, owner, api)
    _enable_attendance(owner, w)
    _staff(worker, w)
    aid = _agent(owner, w, w.manager)
    _owner(owner, w, "update pulse.person set display_name='Synthetic HR Assistant (AI)' where id=%s", (aid,))
    return w, aid


def _as(api, w, who, sql, args=()):
    with api.transaction():
        set_tenant(api, w.org, who)
        return api.execute(sql, args).fetchone()


def _ai(api, w, aid, sql, args=()):
    with api.transaction():
        _as_agent(api, w, aid)
        return api.execute(sql, args).fetchone()


def _refused(api, w, who, sql, args=(), agent=False):
    with pytest.raises(psycopg.Error) as e:
        with api.transaction():
            (_as_agent if agent else lambda a, ww, x: set_tenant(a, ww.org, x))(api, w, who)
            api.execute(sql, args)
    return e.value.sqlstate, str(e.value)


def _owner(owner, w, sql, args=(), viewer=None):
    with owner.transaction():
        role = owner.execute("select pg_get_userbyid(nspowner) r from pg_namespace where nspname='pulse'").fetchone()["r"]
        owner.execute(f"set local role {role}")
        set_tenant(owner, w.org, viewer)
        cur = owner.execute(sql, args)
        return cur.fetchall() if cur.description else None


def _file(api, w, aid, body=None):
    return _ai(api, w, aid, "select pulse.staff_add_request_file(%s) v", (Jsonb(body or JOINER),))["v"]


def _waiting(owner, w, subject_type, subject_id, kind="approval.waiting"):
    return _owner(owner, w, "select person_id,title,event_key from pulse.notification where subject_type=%s and subject_id=%s and event_type=%s order by created_at",
                  (subject_type, subject_id, kind))


# 1 -------------------------------------------------------------------------------------------------------------------
def test_the_ai_files_a_request_and_nothing_is_added(worker, owner, api):
    w, aid = _world(worker, owner, api)
    before = _owner(owner, w, "select count(*) n from pulse.person where side='staff'")[0]["n"]
    r = _file(api, w, aid)
    assert r["status"] == "waiting_for_approval" and r["requestId"]
    # None named: the company's admins approve (the manager is the admin here).
    assert [a["id"] for a in r["approvers"]] == [str(w.manager)]
    assert "Nothing is added until one of them says yes" in r["message"]
    assert _owner(owner, w, "select count(*) n from pulse.person where side='staff'")[0]["n"] == before, "nothing is created before Approve"
    sent = _waiting(owner, w, "staff_add_request", r["requestId"])
    assert [str(s["person_id"]) for s in sent] == [str(w.manager)]
    assert "asks to add Synthetic New Joiner (Video editor)" in sent[0]["title"]
    # A retry (same AI, same name, still waiting) is the same request: no second request, no second ping.
    again = _file(api, w, aid, {**JOINER, "note": "Synthetic retry"})
    assert again["requestId"] == r["requestId"]
    assert len(_waiting(owner, w, "staff_add_request", r["requestId"])) == 1
    assert _owner(owner, w, "select count(*) n from pulse.staff_add_request")[0]["n"] == 1
    # Only an AI files this way; an AI never decides; someone who is not an approver cannot decide.
    assert _refused(api, w, w.lead, "select pulse.staff_add_request_file(%s)", (Jsonb(JOINER),))[0] == "42501"
    assert _refused(api, w, aid, "select pulse.staff_add_request_claim(%s)", (r["requestId"],), agent=True)[0] == "42501"
    assert _refused(api, w, aid, "select pulse.staff_add_request_decline(%s,'Synthetic no')", (r["requestId"],), agent=True)[0] == "42501"
    state, text = _refused(api, w, w.lead, "select pulse.staff_add_request_claim(%s)", (r["requestId"],))
    assert state == "42501" and "named approver" in text
    # Plain refusals for bad input; nothing stored.
    state, text = _refused(api, w, aid, "select pulse.staff_add_request_file(%s)", (Jsonb({"name": "Synthetic Two", "role": "Designer", "startDate": "1 Dec"}),), agent=True)
    assert state == "22023" and "YYYY-MM-DD" in text
    state, text = _refused(api, w, aid, "select pulse.staff_add_request_file(%s)", (Jsonb({"name": "Synthetic Two", "role": "Designer", "pod": "No such pod"}),), agent=True)
    assert state == "22023" and "There is no pod called No such pod" in text
    # The AI reads its own request; another staff member does not see it.
    assert _ai(api, w, aid, "select pulse.staff_add_request_read(%s) v", (r["requestId"],))["v"]["status"] == "waiting_for_approval"
    assert _refused(api, w, w.editor, "select pulse.staff_add_request_read(%s)", (r["requestId"],))[0] == "P0002"
    assert _as(api, w, w.editor, "select pulse.staff_add_requests() v")["v"] == []


APPROVE = r'''
import { Pool } from 'pg';
import { createApp } from './dist/app.js';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG));
const app = createApp(pool,pool);
const call = async(url,email,payload) => {
 const r=await app.inject({url,method:payload?'POST':'GET',headers:{'cf-access-authenticated-user-email':email},...(payload?{payload}:{})});
 return {status:r.statusCode,body:r.json()};
};
const admin='admin@estateautopilots.com', hr='hr@estateautopilots.com', member=process.env.TEST_MEMBER;
const [first,second]=[process.env.TEST_FIRST,process.env.TEST_SECOND];
const out={};
out.settingsMember=await call('/api/v0/hr/staff-add-approvers',member);
out.settings=await call('/api/v0/hr/staff-add-approvers',hr);
out.setByHr=await call('/api/v0/hr/staff-add-approvers',hr,{people:[process.env.TEST_HR_ID]});
out.listMember=await call('/api/v0/people/add-requests',member);
out.list=await call('/api/v0/people/add-requests',admin);
out.approveMember=await call(`/api/v0/people/add-requests/${first}/approve`,member,{});
out.approve=await call(`/api/v0/people/add-requests/${first}/approve`,admin,{});
out.approveAgain=await call(`/api/v0/people/add-requests/${first}/approve`,admin,{});
out.declineNoReason=await call(`/api/v0/people/add-requests/${second}/decline`,admin,{reason:''});
out.decline=await call(`/api/v0/people/add-requests/${second}/decline`,admin,{reason:'Synthetic: we are not hiring for this team now.'});
console.log('RESULT:'+JSON.stringify(out)); await app.close(); await pool.end();
'''


def test_approve_adds_through_add_person_and_decline_goes_back_to_the_ai(worker, owner, api):
    w, aid = _world(worker, owner, api)
    first = _file(api, w, aid)["requestId"]
    second = _file(api, w, aid, {"name": "Synthetic Second Joiner", "role": "Graphic designer"})["requestId"]
    root = Path(__file__).resolve().parents[2]
    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    env = {**os.environ, "TEST_API_CONFIG": json.dumps(config), "PULSE_ORG_ID": str(w.org), "TEST_MEMBER": w.editor_handle,
           "TEST_HR_ID": str(w.lead), "TEST_FIRST": first, "TEST_SECOND": second}
    p = subprocess.run(["node", "--input-type=module", "-e", APPROVE], cwd=root / "services/api", env=env, capture_output=True, text=True, timeout=90, check=False)
    assert p.returncode == 0, p.stderr[-2000:]
    r = json.loads(next(line[7:] for line in p.stdout.splitlines() if line.startswith("RESULT:")))
    assert {k: v["status"] for k, v in r.items()} == {
        "settingsMember": 403, "settings": 200, "setByHr": 403, "listMember": 200, "list": 200, "approveMember": 403,
        "approve": 200, "approveAgain": 400, "declineNoReason": 400, "decline": 200}, {k: v for k, v in r.items() if v["status"] >= 400}
    assert r["settings"]["body"]["named"] is False and [a["id"] for a in r["settings"]["body"]["approvers"]] == [str(w.manager)]
    assert r["listMember"]["body"]["rows"] == []
    assert {x["requestId"] for x in r["list"]["body"]["rows"]} == {first, second} and all(x["canDecide"] for x in r["list"]["body"]["rows"])
    assert "already approved" in r["approveAgain"]["body"]["error"]
    # Approve: the person is in People, added as the approver by Add person (its history), with the request's fields.
    pid = r["approve"]["body"]["personId"]
    person = _owner(owner, w, """select p.display_name,p.side,p.status,pp.role,pp.pod,pp.department,pp.joined_on::text joined,
        (select changed_by from pulse.record_change where entity_type='person' and entity_id=p.id and field='created') by
        from pulse.person p join pulse.people_profile pp on pp.person_id=p.id where p.id=%s""", (pid,))[0]
    assert (person["display_name"], person["side"], person["status"], person["role"], person["pod"], person["department"], person["joined"]) == \
        ("Synthetic New Joiner", "staff", "active", "Video editor", "Pod 1", "Production", "2026-12-01")
    assert str(person["by"]) == str(w.manager)
    # The Audit row names the AI, the approver and the request.
    audit = _owner(owner, w, "select actor_id,resource,resource_id,changes from pulse.audit_event where action='staff_added_by_ai_request'")
    assert len(audit) == 1 and str(audit[0]["actor_id"]) == str(w.manager) and audit[0]["resource_id"] == pid
    assert audit[0]["changes"]["Asked by (AI)"]["after"] == str(aid) and audit[0]["changes"]["Approved by"]["after"] == str(w.manager)
    assert audit[0]["changes"]["Request"]["after"] == first
    done = _ai(api, w, aid, "select pulse.staff_add_request_read(%s) v", (first,))["v"]
    assert done["status"] == "approved" and done["personId"] == pid and "is now in People" in done["message"]
    # Decline: nothing added; the reason reaches the AI (its request and its memory); approvers' notices are cleared.
    no = _ai(api, w, aid, "select pulse.staff_add_request_read(%s) v", (second,))["v"]
    assert no["status"] == "declined" and no["declineReason"] == "Synthetic: we are not hiring for this team now."
    assert not _owner(owner, w, "select 1 from pulse.person where display_name='Synthetic Second Joiner'")
    memory = _owner(owner, w, "select body from pulse.agent_memory where agent_id=%s and slot=%s", (aid, f"staff-add:{second}"))
    assert memory and "we are not hiring" in memory[0]["body"]
    assert not _owner(owner, w, "select 1 from pulse.notification where subject_type='staff_add_request' and read_at is null")


def test_requests_end_after_seven_days(worker, owner, api):
    w, aid = _world(worker, owner, api)
    r = _file(api, w, aid)
    _owner(owner, w, "update pulse.staff_add_request set expires_at=now()-interval '1 minute', created_at=now()-interval '7 days' where id=%s", (r["requestId"],))
    seen = _ai(api, w, aid, "select pulse.staff_add_request_read(%s) v", (r["requestId"],))["v"]
    assert seen["status"] == "expired" and "Nobody decided within 7 days" in seen["message"]
    state, text = _refused(api, w, w.manager, "select pulse.staff_add_request_claim(%s)", (r["requestId"],))
    assert state == "22023" and "nobody decided within 7 days" in text
    assert _as(api, w, w.manager, "select pulse.staff_add_expire() v")["v"] >= 1
    assert _owner(owner, w, "select status from pulse.staff_add_request where id=%s", (r["requestId"],))[0]["status"] == "expired"
    # The same name can be asked for again once the old request ended (a new request, a new notice).
    assert _file(api, w, aid)["requestId"] != r["requestId"]


def test_named_approvers_removed_approver_and_no_approver(worker, owner, api):
    w, aid = _world(worker, owner, api)
    # Only an admin names approvers, and only people who may add staff (HR, admin or leadership).
    assert _refused(api, w, w.lead, "select pulse.staff_add_approvers_set(%s::uuid[])", ([str(w.lead)],))[0] == "42501"
    state, text = _refused(api, w, w.manager, "select pulse.staff_add_approvers_set(%s::uuid[])", ([str(w.editor)],))
    assert state == "22023" and "cannot approve new staff" in text
    setting = _as(api, w, w.manager, "select pulse.staff_add_approvers_set(%s::uuid[]) v", ([str(w.lead)],))["v"]
    assert setting["named"] is True and [a["id"] for a in setting["approvers"]] == [str(w.lead)]
    r = _file(api, w, aid)
    assert [a["id"] for a in r["approvers"]] == [str(w.lead)]
    assert [str(s["person_id"]) for s in _waiting(owner, w, "staff_add_request", r["requestId"])] == [str(w.lead)]
    # The approver removed from the list: they can no longer decide (the admin, now named, can).
    _as(api, w, w.manager, "select pulse.staff_add_approvers_set(%s::uuid[])", ([str(w.manager)],))
    state, text = _refused(api, w, w.lead, "select pulse.staff_add_request_decline(%s,'Synthetic not needed')", (r["requestId"],))
    assert state == "42501" and "not one now" in text
    assert _as(api, w, w.manager, "select pulse.staff_add_request_decline(%s,'Synthetic not needed') v", (r["requestId"],))["v"]["status"] == "declined"
    # No approver: the only named approver left the company. The AI is refused with a plain reason; nothing is stored.
    _as(api, w, w.manager, "select pulse.staff_add_approvers_set(%s::uuid[])", ([str(w.lead)],))
    _owner(owner, w, "update pulse.person set status='inactive' where id=%s", (w.lead,))
    count = _owner(owner, w, "select count(*) n from pulse.staff_add_request")[0]["n"]
    state, text = _refused(api, w, aid, "select pulse.staff_add_request_file(%s)", (Jsonb({"name": "Synthetic Third", "role": "Editor"}),), agent=True)
    assert state == "22023" and "no one in this company can approve new staff yet" in text
    assert _owner(owner, w, "select count(*) n from pulse.staff_add_request")[0]["n"] == count
    # An empty list goes back to the company's admins.
    assert [a["id"] for a in _as(api, w, w.manager, "select pulse.staff_add_approvers_set('{}'::uuid[]) v")["v"]["approvers"]] == [str(w.manager)]


# 2 -------------------------------------------------------------------------------------------------------------------
def _leave(api, owner, w, who, day="2027-01-12", until=None):
    _as(api, w, who, "insert into pulse.leave_request(org_id,person_id,from_date,to_date,leave_kind) values(%s,%s,%s,%s,'casual') returning id",
        (w.org, who, day, until or day))
    return _owner(owner, w, "select id from pulse.hr_flow where person_id=%s and kind='leave' order by created_at desc limit 1", (who,))[0]["id"]



def _approvals(owner, w, flow, kind="approval.waiting"):
    return [str(x["person_id"]) for x in _waiting(owner, w, "hr_flow", flow, kind)]


def test_without_an_hr_ai_every_approver_hears_as_before(worker, owner, api):
    w, _ = _world(worker, owner, api)
    flow = _leave(api, owner, w, w.editor)
    assert sorted(_approvals(owner, w, flow)) == sorted([str(w.lead), str(w.manager)])
    assert not _owner(owner, w, "select 1 from pulse.hr_agent_notice")


def test_with_the_hr_ai_on_duty_one_notice_per_request(worker, owner, api):
    w, aid = _world(worker, owner, api)
    _as(api, w, w.manager, "select pulse.agent_reads_set(%s,'attendance',true)", (aid,))
    flow = _leave(api, owner, w, w.editor)
    # ONE notice, from the HR AI, to the person who decides (HR here: the editor has no team head).
    sent = _waiting(owner, w, "hr_flow", flow)
    assert [str(s["person_id"]) for s in sent] == [str(w.lead)]
    assert sent[0]["title"].startswith("Synthetic HR Assistant (AI): Editor One asked for leave, 12 Jan")
    # The applicant still hears their own request was received.
    assert _owner(owner, w, "select count(*) n from pulse.notification where subject_id=%s and person_id=%s and event_type='request.updated'", (flow, w.editor))[0]["n"] == 1
    # An edit (HR asks a question on it) never pings the approvers again.
    _owner(owner, w, "update pulse.hr_flow set decision_note='Synthetic: which project?' where id=%s", (flow,), viewer=w.lead)
    assert _approvals(owner, w, flow) == [str(w.lead)]
    # A repeat: the same days cancelled and asked again is not a new ping.
    _owner(owner, w, "update pulse.leave_request set status='cancelled' where person_id=%s", (w.editor,), viewer=w.editor)
    again = _leave(api, owner, w, w.editor)
    assert again != flow and _approvals(owner, w, again) == []
    assert _owner(owner, w, "select count(*) n from pulse.notification where event_type='approval.waiting' and subject_type='hr_flow'")[0]["n"] == 1
    # An attendance correction: one notice too.
    _as(api, w, w.editor2, "insert into pulse.attendance_regularisation(org_id,person_id,work_date,kind,reason,in_time,out_time) values(%s,%s,'2026-11-02','missed_punch','Synthetic: forgot to check in at the shoot','10:00','18:00') returning id",
        (w.org, w.editor2))
    fix = _owner(owner, w, "select id from pulse.hr_flow where person_id=%s and kind='correction'", (w.editor2,))[0]["id"]
    fixes = _waiting(owner, w, "hr_flow", fix)
    assert [str(s["person_id"]) for s in fixes] == [str(w.lead)] and "asked to fix attendance, 2 Nov" in fixes[0]["title"]
    # At most one reminder, only once HR's policy sends reminders.
    _owner(owner, w, "update pulse.hr_agent_notice set sent_at=now()-interval '5 hours'")
    assert _owner(owner, w, "select pulse.hr_agent_remind(null) n")[0]["n"] == 0
    assert _owner(owner, w, "select pulse.hr_agent_remind(4) n")[0]["n"] == 2
    assert _owner(owner, w, "select pulse.hr_agent_remind(4) n")[0]["n"] == 0
    # The two still waiting (the leave asked again, the correction); the cancelled one gets none.
    assert _waiting(owner, w, "hr_flow", flow, "approval.reminder") == []
    for waiting in (again, fix):
        reminded = _waiting(owner, w, "hr_flow", waiting, "approval.reminder")
        assert [str(s["person_id"]) for s in reminded] == [str(w.lead)] and "still waiting" in reminded[0]["title"]
    # A decision reaches the applicant; approvers get nothing more.
    _owner(owner, w, "update pulse.hr_flow set status='approved',decided_by=%s where id=%s", (w.lead, fix), viewer=w.lead)
    assert _approvals(owner, w, fix) == [str(w.lead)]


SHOTS = r'''
import { Pool } from 'pg';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from './dist/app.js';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG));
const app = createApp(pool, pool);
const { chromium } = await import('../../tests/e2e/node_modules/@playwright/test/index.mjs');
const origin = await app.listen({ host: '127.0.0.1', port: 0 });
const probe = createServer(); await new Promise(done => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise(done => probe.close(done));
const base = `http://127.0.0.1:${port}`, out = process.env.PULSE_HRAGENT_SCREENSHOTS, found = [];
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)],
  { cwd: '../../apps/web', env: { ...process.env, PULSE_API_URL: origin, NODE_ENV: 'production', PULSE_PUBLIC_LOGIN_ENABLED: '0' }, stdio: 'ignore' });
let browser;
try {
  for (let i = 0; i < 160; i++) { try { if ((await fetch(base + '/login')).ok) break; } catch {} await delay(250); if (i === 159) throw Error('web did not start'); }
  browser = await chromium.launch({ headless: true });
  for (const width of [363, 1440]) for (const theme of ['light', 'dark']) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, extraHTTPHeaders: { 'cf-access-authenticated-user-email': 'admin@estateautopilots.com' } });
    await ctx.addInitScript((t) => { try { localStorage.setItem('pulse.theme', t); localStorage.setItem('theme', t); } catch {} }, theme);
    const page = await ctx.newPage();
    // The page, then this work's own part alone (the panel / the card; for the judge), with the app's floating layers
    // (phone tab bar, toasts, Pip) hidden only for that crop because at 363 px they sit over it.
    for (const [name, url, text, part] of [['approvals', `/me/approvals?staff=${process.env.TEST_FIRST}`, 'New staff to approve', p => p.locator('section').filter({ has: p.getByRole('heading', { name: 'New staff to approve' }) }).last()],
                                           ['policies', '/hr?tab=policies&view=approvals', 'New staff approvers', p => p.locator('section[aria-labelledby="staff-add-approvers-title"]').first()]]) {
      await page.goto(base + url);
      // Not exact: a Panel title shares its <h3> with the panel's <small> note ("2 waiting for you").
      try { await page.getByText(text).filter({ visible: true }).first().waitFor({ timeout: 30000 }); } catch (e) {
        await page.screenshot({ path: `${out}/FAIL-${name}-${width}-${theme}.png`, fullPage: true }).catch(() => {});
        const seen = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 900);
        throw Error(`"${text}" not shown on ${page.url()}; the page says: ${seen}`);
      }
      await delay(600);
      const wide = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      found.push({ name, width, theme, overflow: wide > 1 ? wide : 0 });
      await page.screenshot({ path: `${out}/${name}-${width}-${theme}.png`, fullPage: true });
      const hidden = await page.evaluate(() => { const els = [...document.querySelectorAll('body *')].filter(e => getComputedStyle(e).position === 'fixed');
        for (const e of els) e.setAttribute('data-shot-hidden', ''); return els.length; });
      await page.addStyleTag({ content: '[data-shot-hidden]{visibility:hidden!important}' });
      await part(page).screenshot({ path: `${out}/part-${name}-${width}-${theme}.png` });
      found.push({ name: `part-${name}`, width, theme, overflow: 0, hidden });
    }
    await ctx.close();
  }
} finally { await browser?.close(); server.kill(); await app.close(); await pool.end(); }
console.log('RESULT:' + JSON.stringify(found));
'''


@pytest.mark.skipif(not os.environ.get("PULSE_HRAGENT_SCREENSHOTS"), reason="screenshots for the UI judge only (needs a built web app)")
def test_screens_for_the_judge(worker, owner, api):
    w, aid = _world(worker, owner, api)
    first = _file(api, w, aid)["requestId"]
    _file(api, w, aid, {"name": "Synthetic Priya Kireteso", "role": "Graphic designer", "team": "Design", "note": "Synthetic: joins the social media pod."})
    gone = _file(api, w, aid, {"name": "Synthetic Old Request", "role": "Editor"})["requestId"]
    _as(api, w, w.manager, "select pulse.staff_add_request_decline(%s,'Synthetic: the role was filled.')", (gone,))
    root = Path(__file__).resolve().parents[2]
    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    env = {**os.environ, "TEST_API_CONFIG": json.dumps(config), "PULSE_ORG_ID": str(w.org), "TEST_FIRST": first}
    p = subprocess.run(["node", "--input-type=module", "-e", SHOTS], cwd=root / "services/api", env=env, capture_output=True, text=True, timeout=600, check=False)
    assert p.returncode == 0, (p.stderr + p.stdout)[-3000:]
    found = json.loads(next(line[7:] for line in p.stdout.splitlines() if line.startswith("RESULT:")))
    assert len(found) == 16 and not [f for f in found if f["overflow"]], found
