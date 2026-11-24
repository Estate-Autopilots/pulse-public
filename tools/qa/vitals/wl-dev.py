#!/usr/bin/env python3
"""WL-FLOWS (19 Nov 2026): what the Willow Lane journeys (journeys.mjs wl-*) need from DEV's database, in the QA company only.
Synthetic people only; it refuses any database but pulse_dev and any company but the QA company of the credentials.

    wl-dev.py fixture              attendance on for the QA company, as Willow Lane has it (an operator's switch: no screen sets it)
    wl-dev.py followup-due DOC     the QA quotation DOC's next follow-up is due now (the minute tick then makes the seller's
                                   follow-up task and notice; the follow-up days themselves are at least a day)

Prints one JSON line. Exit 0 done, 2 refused or failed.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ENV = Path("/etc/estate-autopilots/db/pulse_dev.env")
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


def connect():
    import psycopg
    dsn = next(l.split("=", 1)[1].strip().strip('"') for l in ENV.read_text().splitlines() if l.startswith("MIGRATE_DATABASE_URL="))
    return psycopg.connect(dsn, application_name="wl-flows-dev")


def as_owner(c, org: str) -> None:
    """The pulse schema's owner (row security is forced; the migrate login is not the owner), inside the QA company."""
    import psycopg.sql
    db, owner, sup = c.execute("""select current_database(), pg_get_userbyid(n.nspowner), r.rolsuper from pg_namespace n, pg_roles r
                                  where n.nspname = 'pulse' and r.rolname = session_user""").fetchone()
    if db != "pulse_dev":
        raise SystemExit(json.dumps({"ok": False, "error": f"refused: database {db} is not pulse_dev"}))
    if not sup:
        c.execute(psycopg.sql.SQL("set local role {}").format(psycopg.sql.Identifier(owner)))
    c.execute("select set_config('pulse.org_id', %s, true), set_config('pulse.actor_account', 'wl-flows journeys (QA company, dev)', true)", (org,))
    name = c.execute("select name from pulse.org where id = %s", (org,)).fetchone()
    if not name or "(TEST)" not in name[0]:
        raise SystemExit(json.dumps({"ok": False, "error": "refused: not the QA (TEST) company"}))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("what", choices=["fixture", "followup-due"])
    ap.add_argument("doc", nargs="?")
    ap.add_argument("--credentials", type=Path, default=Path.home() / ".config/vitals-qa/dev.json")
    a = ap.parse_args()
    creds = json.loads(a.credentials.read_text())
    if "dev." not in creds.get("baseUrl", ""):
        print(json.dumps({"ok": False, "error": "refused: these are not dev's QA credentials"}))
        return 2
    org = creds["org"]["id"]
    with connect() as c:
        as_owner(c, org)
        if a.what == "fixture":
            was = c.execute("select attendance_enabled from pulse.hr_policy where org_id = %s", (org,)).fetchone()
            c.execute("""insert into pulse.hr_policy(org_id, attendance_enabled) values (%s, true)
                         on conflict (org_id) do update set attendance_enabled = true""", (org,))
            out = {"ok": True, "attendance": {"was": was[0] if was else None, "now": True}}
        else:
            if not a.doc or not UUID.match(a.doc):
                print(json.dumps({"ok": False, "error": "give the quotation's id"}))
                return 2
            row = c.execute("""update pulse.erp_followup f set next_due_at = now() - interval '1 minute'
                               from pulse.erp_document d where d.id = f.document_id and d.org_id = %s and f.org_id = %s
                                 and f.document_id = %s and f.state = 'scheduled' returning f.occurrences""", (org, org, a.doc)).fetchone()
            out = {"ok": row is not None, "doc": a.doc, **({} if row else {"error": "no scheduled follow-up for that QA quotation"})}
        c.commit()
    print(json.dumps(out))
    return 0 if out["ok"] else 2


if __name__ == "__main__":
    sys.exit(main())
