#!/usr/bin/env python3
"""QA-2 (QA system stage 1, step 9; research §4.5 "Customer-setup check"): a read-only rule pack per organisation.

    python3 tools/qa/vitals/setup-check.py --org willowlane --org naturesolutions --org atlascrest --org estateautopilots \\
        [--dsn-env /etc/estate-autopilots/db/pulse.env:PULSE_DATABASE_URL_MIGRATE] [--out report.md] [--json out.json]

One read-only transaction per organisation (begin read only; role pulse_owner; the organisation's own row security).
Nothing is written, nobody is messaged. Output: a red / amber / green list per organisation (markdown, with the
names of the people a rule is about, for the owner's eyes: keep it in private reports), and a JSON copy; stdout prints
only counts.

Rules (each one is a setup gap a person meets as a dead end, not a code bug):
  S1  every active staff member can sign in (a password login or an account seat)            red
  S2  nobody's password is locked or waiting on a first change they never made                 amber
  S3  who holds no role beyond member (a member's menu)                                       info
  S4  everyone titled as sales holds the sales seat (sales or sales_head)                     red
  S5  the sellers' role does not hide their own screens (Billing when the company bills; their home)  red
  S6  the owner: who holds admin and leadership (there is one)                                 info / red when none
  S7  each AI employee has a brief, an approver inside the company, and an owner who is still here  red / amber
  S8  Billing: the company's GSTIN, legal name, address and state are set once it bills         red
  S9  a document template that shows bank details has them                                    red
  S10 staff with neither a work e-mail nor a phone (Forgot password cannot reach them)          amber
  S11 staff with no manager (besides admins and leadership)                                    amber
  S12 modules switched off                                                                     info
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import psycopg
from psycopg.rows import dict_row

SELLER_TITLE = r"sales|seller|business development|bde|bdm"


def dsn(spec: str) -> str:
    path, _, key = spec.partition(":")
    for line in Path(path).read_text().splitlines():
        if line.startswith(key + "="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise SystemExit(f"{key} not found in {path}")


def check(c, org: dict) -> list[dict]:
    q = lambda sql, *a: c.execute(sql, a).fetchall()  # noqa: E731
    one = lambda sql, *a: c.execute(sql, a).fetchone()  # noqa: E731
    out: list[dict] = []

    def add(rule, level, title, people=None, detail=""):
        out.append({"rule": rule, "level": level, "title": title, "people": sorted(people or []), "detail": detail})

    staff = q("""select p.id, p.display_name name, pp.role title, pp.email, pp.phone, pp.manager_id from pulse.person p
                 left join pulse.people_profile pp on pp.person_id = p.id where p.side = 'staff' and p.status = 'active'""")
    roles = {}
    for r in q("""select person_id, array_agg(distinct role_key) keys from pulse.role_assignment
                  where current_date between valid_from and coalesce(valid_to, 'infinity') group by 1"""):
        roles[r["person_id"]] = set(r["keys"])
    # S1
    no_login = [s["name"] for s in staff if not one("""select 1 from pulse.login_credential l where l.person_id = %s and l.status = 'active'
        union all select 1 from pulse_priv.account_member m where m.person_id = %s limit 1""", s["id"], s["id"])]
    add("S1", "red" if no_login else "green", f"{len(staff) - len(no_login)} of {len(staff)} active staff can sign in", no_login,
        "no password login and no account seat: they cannot open the app at all")
    # S2
    stuck = q("""select p.display_name name, l.locked_until > now() locked, l.must_change and l.last_login_at is null never from pulse.login_credential l
                 join pulse.person p on p.id = l.person_id where p.side = 'staff' and p.status = 'active' and l.status = 'active'
                 and (l.locked_until > now() or (l.must_change and l.last_login_at is null and l.issued_at < now() - interval '3 days'))""")
    add("S2", "amber" if stuck else "green", "nobody is locked out or stuck on a first password", [f"{s['name']} ({'locked' if s['locked'] else 'never signed in'})" for s in stuck])
    # S3
    no_role = [s["name"] for s in staff if not roles.get(s["id"])]
    add("S3", "info", f"{len(no_role)} active staff hold no role beyond member (their menu is a member's)", no_role)
    # S4
    titled = [s for s in staff if s["title"] and re.search(SELLER_TITLE, s["title"], re.I)]
    unseated = [f"{s['name']} ({s['title']})" for s in titled if not (roles.get(s["id"], set()) & {"sales", "sales_head"})]
    add("S4", "red" if unseated else "green", f"{len(titled) - len(unseated)} of {len(titled)} people titled as sales hold the sales seat", unseated,
        "without the seat they get no sales home, no My sales and no quotation tools (check: are they sellers in this app?)")
    # S5: the sellers' screen role is 'person' (a sales seat is a person with salesSeat); HR is never a home role.
    view = one("select pulse.org_screen_view_get() v")["v"] or {}
    hidden = view.get("hidden", {}) or {}
    known = set(view.get("known", []) or [])
    nonfixed = ["work", "clients", "acquisition", "contacts", "map", "sops", "network", "team", "leadership", "finance", "erp", "review", "audit"]
    def hid(role):
        h = set(hidden.get(role, []) or [])
        if view.get("newScreensHidden"):
            h |= {k for k in nonfixed if k not in known}
        return h
    bills = one("select exists(select 1 from pulse.erp_document) b")["b"]
    sellers = [s for s in staff if roles.get(s["id"], set()) & {"sales", "sales_head"}]
    gaps = []
    if sellers and bills and "erp" in hid("person"):
        gaps.append("Billing is hidden from the sellers' role (person) while the company bills")
    if sellers and "work" in hid("person"):
        gaps.append("Tasks (work) is hidden from the sellers' role")
    home = (view.get("home") or {}).get("person")
    add("S5", "red" if gaps else "green", "the sellers' role shows their own screens", [], "; ".join(gaps) or
        f"sellers' home: {home or 'dashboard'}; hidden for them: {', '.join(sorted(hid('person'))) or 'nothing'}")
    # S6
    owners = [s["name"] for s in staff if {"admin", "leadership"} <= roles.get(s["id"], set())]
    admins = [s["name"] for s in staff if "admin" in roles.get(s["id"], set())]
    add("S6", "info" if owners else "red", f"{len(owners)} hold admin and leadership (the owner); {len(admins)} admins in all", owners,
        "check that the owner here is the intended person")
    # S7
    agents = q("""select p.display_name name, coalesce(btrim(m.instructions), '') = '' no_brief, m.approver_person_id, m.owner_person_id,
                  (select p2.side = 'staff' and p2.status = 'active' from pulse.person p2 where p2.id = m.approver_person_id) approver_ok,
                  (select p3.status = 'active' from pulse.person p3 where p3.id = m.owner_person_id) owner_ok, m.paused_reason
                  from pulse.agent_member m join pulse.person p on p.id = m.person_id where m.disabled_at is null""")
    for a in agents:
        probs = []
        if a["no_brief"]:
            probs.append("no brief (instructions empty)")
        if not a["approver_person_id"]:
            probs.append("no approver")
        elif not a["approver_ok"]:
            probs.append("its approver is not an active staff member here")
        if a["owner_person_id"] and not a["owner_ok"]:
            probs.append("its owner has left")
        level = "red" if any(p.startswith(("no brief", "no approver", "its approver")) for p in probs) else "amber" if probs else "green"
        add("S7", level, f"AI employee {a['name']}: " + ("; ".join(probs) if probs else "brief, approver and owner in place")
            + (f" (paused: {a['paused_reason']})" if a["paused_reason"] else ""))
    if not agents:
        add("S7", "info", "no AI employees")
    # S8
    st = one("select company from pulse.erp_settings")
    comp = (st or {}).get("company") or {}
    if bills:
        missing = [k for k in ("gstin", "legalName", "address", "stateCode") if not str(comp.get(k) or "").strip()]
        add("S8", "red" if missing else "green", "Billing: the company's own details", [], f"missing: {', '.join(missing)}" if missing else "GSTIN, legal name, address, state set")
    else:
        add("S8", "info", "Billing: no documents yet")
    # S9
    for t in q("""select name, doc_types, design from pulse.erp_template where not archived"""):
        d = t["design"] or {}
        show = (d.get("show") or {}).get("bank")
        bank = d.get("bank") if isinstance(d.get("bank"), dict) else {}
        filled = [k for k, v in bank.items() if str(v or "").strip()]
        if show and not filled:
            add("S9", "red", f"template \"{t['name']}\" shows bank details but has none", [], f"used for: {', '.join(t['doc_types'] or [])}; empty: {', '.join(bank) or 'all'}")
        elif show:
            add("S9", "green", f"template \"{t['name']}\" shows bank details ({len(filled)} fields set)")
    # S10
    unreachable = [s["name"] for s in staff if not (s["email"] or "").strip() and not (s["phone"] or "").strip()]
    add("S10", "amber" if unreachable else "green", "staff that Forgot password can reach (work e-mail or phone)", unreachable)
    # S11
    lead = {"admin", "leadership"}
    no_mgr = [s["name"] for s in staff if not s["manager_id"] and not (roles.get(s["id"], set()) & lead)]
    add("S11", "amber" if no_mgr else "green", "staff with a manager (besides admins and leadership)", no_mgr)
    # S12
    off = [r["module"] for r in q("select module from pulse.org_module where not enabled order by 1")]
    add("S12", "info", "modules switched off: " + (", ".join(off) or "none"))
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--org", action="append", required=True, help="organisation handle")
    ap.add_argument("--dsn-env", default="/etc/estate-autopilots/db/pulse.env:PULSE_DATABASE_URL_MIGRATE")
    ap.add_argument("--out", type=Path)
    ap.add_argument("--json", type=Path)
    args = ap.parse_args()
    report, md = {}, [f"# Customer-setup check ({datetime.now(timezone.utc):%Y-%m-%d %H:%M} UTC, read only)\n"]
    with psycopg.connect(dsn(args.dsn_env), row_factory=dict_row, autocommit=True, application_name="qa-2-setup-check") as conn:
        for handle in args.org:
            with conn.transaction(force_rollback=True):  # read only, and rolled back all the same
                c = conn.cursor()
                c.execute("set transaction read only")
                c.execute("set local role pulse_owner")
                org = c.execute("select id, name, purpose, status from pulse.org where handle = %s", (handle,)).fetchone()
                if not org:
                    print(f"{handle}: not found")
                    continue
                c.execute("select set_config('pulse.org_id', %s, true)", (str(org["id"]),))
                rows = check(c, org)
            report[handle] = {"org": org["name"], "rules": rows}
            counts = {lv: sum(1 for r in rows if r["level"] == lv) for lv in ("red", "amber", "green", "info")}
            print(f"{org['name']}: {counts['red']} red, {counts['amber']} amber, {counts['green']} green, {counts['info']} info")
            md.append(f"\n## {org['name']} (@{handle}): {counts['red']} red, {counts['amber']} amber, {counts['green']} green\n")
            for r in sorted(rows, key=lambda r: ("red", "amber", "info", "green").index(r["level"])):
                who = f" — {', '.join(r['people'][:15])}{' …' if len(r['people']) > 15 else ''}" if r["people"] else ""
                md.append(f"- **{r['level'].upper()}** {r['rule']} {r['title']}{(': ' + r['detail']) if r['detail'] and r['level'] != 'green' else ''}{who}")
    if args.out:
        args.out.write_text("\n".join(md) + "\n")
    if args.json:
        args.json.write_text(json.dumps(report, indent=1, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
