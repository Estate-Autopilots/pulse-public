#!/usr/bin/env python3
"""WL-FLOWS (owner order, 19 Nov 2026): Willow Lane's working day, checked on PRODUCTION, read only. The journeys
(wl-flows.mjs) prove each workflow on dev in the QA company; this says, for Willow Lane itself, whether each one is set up
to work and whether it is being used: lead, quotation (PDF in chat), approval (auto up to ₹10 lakh), proforma, tasks,
follow-up, reminders, attendance. One read-only transaction as the database owner inside Willow Lane (row security), rolled
back; nothing is written and nobody is told. Names are not printed (counts and settings only).

    python3 tools/qa/vitals/wl-prod-check.py [--out DIR] [--org willowlane]

Each check: ok true (set up), false (a gap a person meets), null (for information). Output: <out>/wl-prod.json and one
line per check. Exit 0 every check true or null, 1 a gap, 2 could not run.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

DSN = ("/etc/estate-autopilots/db/pulse.env", "PULSE_DATABASE_URL_MIGRATE")
LIMIT = 100_000_000  # ₹10,00,000 in paise


def dsn() -> str:
    return next(l.split("=", 1)[1].strip().strip('"') for l in Path(DSN[0]).read_text().splitlines() if l.startswith(DSN[1] + "="))


def checks(c, org: str) -> list[dict]:
    q = lambda sql, *a: c.execute(sql, a).fetchone()  # noqa: E731
    out: list[dict] = []

    def add(flow, name, ok, detail):
        out.append({"flow": flow, "name": name, "ok": ok, "detail": detail})

    agents = {r["title_kind"]: r for r in c.execute("""
        select case when m.finance_role_at is not null then 'finance' else 'sellers' end title_kind, p.display_name name, p.status,
               m.disabled_at is null live, m.access, m.tools, pulse.agent_acts(m.person_id) acts, m.catalogue_keeper_at is not null keeper,
               m.runtime_state, m.runtime_seen_at, pulse.agent_final_approver(m.person_id,'quotation',null) approver
          from pulse.agent_member m join pulse.person p on p.id = m.person_id where p.status = 'active' and m.disabled_at is null""").fetchall()}
    b, a = agents.get("sellers"), agents.get("finance")
    s = q("select quote_auto_approve, quote_auto_limit, followup_days, followup_hour, quote_approval from pulse.erp_settings") or {}

    # lead
    add("lead", "the sellers' assistant can add a customer (create_quote_lead)", bool(b and b["acts"] and "billing" in (b["tools"] or [])),
        f"access {b and b['access']}, billing tool {'billing' in (b['tools'] or []) if b else None}")
    r = q("select count(*) filter (where source='assistant') ai, count(*) filter (where created_at > now() - interval '7 days') week, count(*) n from pulse.client")
    add("lead", "customers added (7 days / by an AI employee / all)", None, f"{r['week']} / {r['ai']} / {r['n']}")

    # quotation
    add("quote", "quotations at catalogue prices are approved at once up to ₹10 lakh", bool(s.get("quote_auto_approve")) and s.get("quote_auto_limit") == LIMIT,
        f"auto {s.get('quote_auto_approve')}, limit ₹{(s.get('quote_auto_limit') or 0) / 1e7:g} lakh")
    r = q("select count(*) filter (where status='active' and price > 0) priced, count(*) filter (where status='active' and price = 0) zero from pulse.erp_item")
    add("quote", "active catalogue items priced", r["zero"] == 0, f"{r['priced']} priced, {r['zero']} at ₹0 (a quotation with one goes to the approver)")
    r = q("""select count(*) filter (where kind='approved_by_rule') rule, count(*) filter (where kind='pdf_to_chat') pdf,
                    max(at) filter (where kind='pdf_to_chat') last_pdf from pulse.erp_event where subject_type='document' and at > now() - interval '7 days'""")
    add("quote", "quotations approved by the rule / PDFs posted in chat (7 days)", None, f"{r['rule']} / {r['pdf']}, last PDF {r['last_pdf'] or 'never'}")
    r = q("""select count(*) filter (where status='draft') drafts, count(*) filter (where status in ('issued','sent','accepted','converted')) approved,
                    count(*) filter (where status='draft' and updated_at < now() - interval '7 days') stale,
                    count(*) filter (where status in ('issued','sent','accepted','converted') and salesperson_id is null) no_seller
               from pulse.erp_document where doc_type='quotation'""")
    add("quote", "approved quotations with a salesperson", r["no_seller"] == 0, f"{r['approved']} approved, {r['no_seller']} without a salesperson; {r['drafts']} drafts ({r['stale']} untouched 7+ days)")
    live = q("select position('relationship_owner_id' in pg_get_functiondef('pulse.erp_sales_seat_insert()'::regprocedure)) > 0 v")["v"]
    add("quote", "an AI employee's quotation for a seller's customer is that seller's (2404)", live, "live" if live else "not on production yet")

    # approval
    add("approval", "the AI employees' quotations go to an approver", bool(b and b["approver"]), "set" if b and b["approver"] else "nobody")
    r = q("select count(*) n, min(updated_at) oldest from pulse.erp_document where doc_type='quotation' and status='draft' and approval_to is not null")
    add("approval", "quotations waiting for approval", None, f"{r['n']}, oldest {r['oldest'] or '-'}")

    # proforma
    add("proforma", "the finance AI employee can make a proforma (create_proforma)", bool(a and a["acts"] and "billing" in (a["tools"] or [])),
        f"access {a and a['access']}, Finance role {a is not None}")
    r = q("select count(*) n, count(*) filter (where status <> 'draft') issued from pulse.erp_document where doc_type='proforma'")
    add("proforma", "proformas (all / issued)", None, f"{r['n']} / {r['issued']}")
    # The document templates that print bank details (QA-2's setup check S9): a proforma asks to be paid into them.
    empty = [t["name"] for t in c.execute("select name, design from pulse.erp_template where not archived").fetchall()
             if ((t["design"] or {}).get("show") or {}).get("bank")
             and not any(str(v or "").strip() for v in ((t["design"] or {}).get("bank") or {}).values())]
    add("proforma", "bank details for payment on the documents", not empty,
        f"{len(empty)} template(s) print empty bank details (Willow Lane to give: bank, account, IFSC, branch, UPI)" if empty else "set where shown")

    # tasks
    add("tasks", "the sellers' assistant creates a task for a colleague (operations access)", bool(b and b["acts"]), f"access {b and b['access']}")
    r = q("""select count(*) filter (where t.status in ('open','in_progress','blocked')) open,
                    count(*) filter (where t.status in ('open','in_progress','blocked') and t.due_at < now()) overdue,
                    count(*) filter (where t.created_at > now() - interval '7 days') week
               from pulse.task t where t.deleted_at is null""")
    add("tasks", "tasks (open / overdue / made in 7 days)", None, f"{r['open']} / {r['overdue']} / {r['week']}")
    r = q("""select count(distinct ra.person_id) sellers,
                    count(distinct ra.person_id) filter (where exists(select 1 from pulse.task t where t.deleted_at is null and coalesce(t.assignee_person_id,t.owner_id)=ra.person_id
                      and t.status in ('open','in_progress','blocked'))) with_work
               from pulse.role_assignment ra join pulse.person p on p.id=ra.person_id and p.status='active'
              where ra.role_key in ('sales','sales_head') and current_date between ra.valid_from and coalesce(ra.valid_to,'infinity')""")
    add("tasks", "sellers with open work", None, f"{r['with_work']} of {r['sellers']}")

    # follow-up
    on = (s.get("followup_days") or 0) > 0
    add("follow-up", "a sent quotation comes back to its seller (follow-up ladder)", on,
        f"every {s.get('followup_days')} days at {s.get('followup_hour')}:00" if on else "off (erp_settings.followup_days = 0): Willow Lane to say yes and how often")
    r = q("select count(*) filter (where state='scheduled') scheduled, count(*) n from pulse.erp_followup")
    add("follow-up", "follow-ups (scheduled / all)", None, f"{r['scheduled']} / {r['n']}")

    # reminders
    live = q("select position('chat_reminder' in pg_get_functiondef('pulse.notification_recipient_allowed(uuid,text,text,uuid)'::regprocedure)) > 0 v")["v"]
    add("reminders", "\"remind me about this message\" reaches the bell (2404)", live, "live" if live else "not on production yet: only the chat list's chip shows it")
    r = q("select count(*) n, count(*) filter (where fired_at is not null) fired from pulse.chat_reminder")
    add("reminders", "chat reminders (all / rung)", None, f"{r['n']} / {r['fired']}")

    # attendance
    h = q("select attendance_enabled on_, confirmed_at, presence_sites, shift_start, shift_end, work_days from pulse.hr_policy") or {}
    add("attendance", "attendance is on", bool(h.get("on_")), f"{h.get('shift_start')}–{h.get('shift_end')}, days {h.get('work_days')}")
    add("attendance", "HR confirmed the attendance policy", h.get("confirmed_at") is not None, "confirmed" if h.get("confirmed_at") else "never confirmed by Willow Lane HR")
    r = q("select count(*) n from pulse.place")
    add("attendance", "an office site for automatic check-in", not h.get("presence_sites") or r["n"] > 0, f"site-based presence {'on' if h.get('presence_sites') else 'off'}, {r['n']} sites")
    r = q("""select count(distinct e.person_id) filter (where e.work_date = (now() at time zone pulse.org_time_zone())::date) today,
                    count(distinct e.person_id) filter (where e.work_date > (now() at time zone pulse.org_time_zone())::date - 7) week,
                    (select count(*) from pulse.person p where p.side='staff' and p.status='active') staff
               from pulse.attendance_entry e where e.voided_at is null""")
    add("attendance", "people who checked in (today / 7 days / active staff)", None, f"{r['today']} / {r['week']} / {r['staff']}")
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path)
    ap.add_argument("--org", default="willowlane")
    args = ap.parse_args()
    import psycopg
    from psycopg.rows import dict_row
    try:
        with psycopg.connect(dsn(), row_factory=dict_row, autocommit=True, application_name="wl-flows-prod-check") as conn:
            with conn.transaction(force_rollback=True):
                c = conn.cursor()
                c.execute("set transaction read only")
                c.execute("set local role pulse_owner")
                org = c.execute("select id from pulse.org where handle = %s", (args.org,)).fetchone()
                if not org:
                    raise RuntimeError(f"no company {args.org}")
                c.execute("select set_config('pulse.org_id', %s, true)", (str(org["id"]),))
                res = checks(c, str(org["id"]))
    except Exception as e:  # noqa: BLE001
        print(f"wl-prod-check: could not run: {e}")
        return 2
    if args.out:
        args.out.mkdir(parents=True, exist_ok=True)
        (args.out / "wl-prod.json").write_text(json.dumps({"at": datetime.now(timezone.utc).isoformat(), "org": args.org, "checks": res}, indent=1, default=str))
    for r in res:
        mark = "ok  " if r["ok"] is True else "GAP " if r["ok"] is False else "info"
        print(f"{mark} {r['flow']:10} {r['name']}: {r['detail']}")
    return 1 if any(r["ok"] is False for r in res) else 0


if __name__ == "__main__":
    sys.exit(main())
