#!/usr/bin/env python3
"""Retire a test, demo or suspended company, or put it back (PROFILE-2, owner, 17 Nov 2026: "EA Sales Test, Savuzo HQ,
Pulse Demo and Pulse should not be on my profile").

    python3 tools/admin/org-retire.py --org easalestest --accounts savuzo --approver "Owner Name (owner)" --words "..." \\
        --dsn-env /etc/estate-autopilots/db/pulse.env:PULSE_DATABASE_URL_MIGRATE [--apply]
    python3 tools/admin/org-retire.py --org easalestest --restore --approver ... --words ... [--apply]

  * Retire: pulse.platform_org_retire (migration 2215), as a Pulse platform admin (--as, default savuzo) in the install's
    organisation: status archived, purpose test, its sign-ins ended, and the seats of the --accounts named ended the way
    leaving a company ends one (person inactive, an alumni row, an account_leave note in the company's Audit). A real,
    active company, the install's own, a personal space and a merged organisation are refused by the database.
  * Restore: pulse.platform_org_restore: the status and purpose it had, and every seat it ended.
  * Nothing is deleted. Both write the platform audit log and the company's Audit (who approved, their words).
  * One transaction; without --apply it does everything and rolls back. Runs only on the Pulse server.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import socket
import sys

import psycopg

APP = "pulse-org-retire"
DEFAULT_HOSTS = "host-49a12d.internal.example"
HANDLE = re.compile(r"^[a-z0-9][a-z0-9._-]{1,62}$")


def dsn(args) -> str:
    if args.database:
        return args.database
    path, _, key = (args.dsn_env or "").partition(":")
    if not path or not key:
        raise SystemExit("Give --database or --dsn-env <file>:<variable>")
    for line in open(path, encoding="utf-8"):
        if line.startswith(key + "="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise SystemExit(f"{key} is not in {path}")


def refuse(msg: str) -> int:
    print(f"Refused (nothing was written): {msg}", file=sys.stderr)
    return 2


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--org", required=True, help="the company's handle")
    ap.add_argument("--accounts", default="", help="comma-separated @handles whose seats end (retire only)")
    ap.add_argument("--restore", action="store_true", help="put a retired company back")
    ap.add_argument("--as", dest="as_handle", default="savuzo", help="the platform admin who acts (@handle)")
    ap.add_argument("--approver", required=True, help='who approved, e.g. "Owner Name (owner)"')
    ap.add_argument("--words", required=True, help="the approver's words, verbatim (they go in the audit log)")
    ap.add_argument("--apply", action="store_true", help="commit (default: dry run, rolled back)")
    ap.add_argument("--database")
    ap.add_argument("--dsn-env")
    args = ap.parse_args(argv)

    allowed = {h.strip() for h in os.environ.get("PULSE_ADMIN_TOOL_HOSTS", DEFAULT_HOSTS).split(",") if h.strip()}
    if socket.gethostname() not in allowed:
        return refuse(f"this tool runs only on {', '.join(sorted(allowed))}")
    approver, words = args.approver.strip()[:120], args.words.strip()[:380]
    if len(approver) < 3 or len(words) < 4:
        return refuse("name the approver and give their words")
    org = args.org.strip().lstrip("@").lower()
    who = args.as_handle.strip().lstrip("@").lower()
    accounts = [a.strip().lstrip("@").lower() for a in args.accounts.split(",") if a.strip()]
    if not HANDLE.match(org) or not HANDLE.match(who) or not all(HANDLE.match(a) for a in accounts):
        return refuse("--org, --as and --accounts take handles")
    if args.restore and accounts:
        return refuse("--restore gives back every seat the retire ended; it takes no --accounts")
    actor = f"org-retire.py · approver: {approver}"[:120]
    try:
        with psycopg.connect(dsn(args), application_name=APP) as c:
            c.execute("set lock_timeout = '15s'")
            c.execute("set statement_timeout = '120s'")
            # The acting platform admin's staff seat in the install's organisation (as grant-access.py's org-purpose).
            seat = c.execute("""select m.person_id, o.id from pulse.org o
                  join pulse_priv.account_member m on m.member_org = o.id join pulse_priv.pulse_account a on a.id = m.account_id
                  join pulse.person p on p.id = m.person_id and p.org_id = o.id
                 where o.id = pulse.install_org() and a.handle = %s and p.status = 'active' and p.side = 'staff' limit 1""", (who,)).fetchone()
            if not seat:
                return refuse(f"@{who} has no active staff seat in the install's organisation")
            target = c.execute("select id from pulse.org where handle = %s", (org,)).fetchone()
            if not target:
                return refuse(f"no organisation @{org}")
            c.execute("""select set_config('pulse.org_id', %s, true), set_config('pulse.viewer_id', %s, true),
                                set_config('pulse.actor_account', %s, true), set_config('pulse.agent_session', '', true)""",
                      (str(seat[1]), str(seat[0]), actor))
            if args.restore:
                result = c.execute("select pulse.platform_org_restore(%s, %s)", (target[0], f"{words} (approved by {approver})")).fetchone()[0]
            else:
                result = c.execute("select pulse.platform_org_retire(%s, %s, %s)", (target[0], accounts, f"{words} (approved by {approver})")).fetchone()[0]
            if args.apply:
                c.commit()
            else:
                c.rollback()
    except psycopg.Error as e:
        msg = (e.diag.message_primary or str(e)).strip()
        if e.sqlstate in ("42501", "22023", "P0002"):
            return refuse(msg)
        print(f"The database failed (nothing was written): {msg}", file=sys.stderr)
        return 1
    print(json.dumps({"applied": args.apply, **result}, default=str))
    print("Applied. Written to the platform audit log and the company's Audit." if args.apply
          else "Dry run (rolled back). Run again with --apply.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
