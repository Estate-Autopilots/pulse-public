#!/usr/bin/env python3
"""Merge an organisation one person made for themselves into that person's personal space, at the Pulse server's
terminal (PERSONAL-MERGE, owner, 16 Nov 2026: "Savuzo HQ should be dissolved into the personal account itself ...
Similarly for other people who have created their own organisation: merge that into their own personal account").

    python3 tools/admin/org-merge-personal.py --approver "Owner Name (owner)" --words "..." \\
        --org <handle, slug or id> --account <account handle> [--with-clients] [--handle <new handle>] [--apply]
    python3 tools/admin/org-merge-personal.py --approver ... --words ... --undo <merge id> [--apply]

  * Through migration 2181's pulse.org_merge_into_personal(org, account, actor, words): every row of the organisation
    moves to the account's personal space (made first when there is none) with the same ids; the person's old seat and
    the organisation's id are rewritten to the personal ones; rows the personal space already has its own copy of stay
    with the old organisation; module switches carry over; one audit note per moved kind of record; the emptied
    organisation is archived (not deleted) and old links say where it went. Real companies are refused by the database.
  * --with-clients (SAKOBE-MERGE, migration 2182; only on the owner's word that the clients are the person's own, e.g.
    a freelancer's): an organisation with clients is merged too, and its clients move with everything that points at
    them (contacts, client projects, quotations, invoices, files). Without it an organisation with a client is refused.
    Still refused: another person signs in, other staff, a client signs in to the portal, a link to another organisation.
  * --handle <new> (SAKOBE-MERGE): in the same transaction, after the merge, the account's @handle becomes <new> through
    the product's own "Change your @handle" (pulse.acct_claim_core, as the person's personal seat): reserved and taken
    names are refused, the old handle keeps finding the person (sign-in, the e-mailed code), every seat's username
    follows with the old one kept as an alias there, open invitations follow. Refused (nothing written) when taken.
  * --undo <merge id> puts a merge back through pulse.org_merge_undo (the one-command restore).
  * One transaction. A dry run (the default) does all of it and rolls back, printing what would move; the dry run is
    written to the platform ledger as its own committed row (admin.org_merge_personal_dry_run). With --apply it commits
    and writes the platform audit (admin.org_merge_personal / admin.org_merge_personal_undo).
  * The database: --database <connection string>, or --dsn-env <env file>:<variable> (read at run time, never printed).
    The role must own the tables (the migration role). Refused on any other host and without the approver's words.
    There is no web route for it. Nothing is sent to anyone.

Exit codes: 0 done (or the dry run worked); 2 refused; 1 the database failed.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import socket
import sys

import psycopg

APP = "pulse-org-merge-personal"
DEFAULT_HOSTS = "host-49a12d.internal.example"
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


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
    ap.add_argument("--approver", required=True, help='who approved, e.g. "Owner Name (owner)"')
    ap.add_argument("--words", required=True, help="the approver's words")
    ap.add_argument("--org", help="the organisation's handle, slug or id")
    ap.add_argument("--account", help="the person's Pulse account handle")
    ap.add_argument("--undo", help="put this merge back instead")
    ap.add_argument("--with-clients", action="store_true",
                    help="the organisation's clients are the person's own (owner's word): move them too")
    ap.add_argument("--handle", help="after the merge, the account's new @handle (the old one stays an alias)")
    ap.add_argument("--apply", action="store_true", help="commit (default: dry run, rolled back)")
    ap.add_argument("--database")
    ap.add_argument("--dsn-env")
    args = ap.parse_args(argv)

    allowed = {h.strip() for h in os.environ.get("PULSE_ADMIN_TOOL_HOSTS", DEFAULT_HOSTS).split(",") if h.strip()}
    if socket.gethostname() not in allowed:
        return refuse(f"this tool runs only on {', '.join(sorted(allowed))}")
    if len(args.approver.strip()) < 3 or len(args.words.strip()) < 3:
        return refuse("name the approver and give their words")
    if bool(args.undo) == bool(args.org or args.account):
        return refuse("give --org and --account, or --undo")
    if args.undo and (args.with_clients or args.handle):
        return refuse("--with-clients and --handle are for a merge; an undo puts back whatever the merge moved")
    new_handle = (args.handle or "").strip().lstrip("@").lower()
    if args.handle is not None and not re.match(r"^[a-z0-9][a-z0-9._]{2,29}$", new_handle):
        return refuse("a handle is 3 to 30 lower-case letters, digits, dots or underscores")
    if args.undo and not UUID.match(args.undo):
        return refuse("--undo takes a merge id")
    if not args.undo and not (args.org and args.account):
        return refuse("give both --org and --account")

    actor = args.approver.strip()[:120]
    try:
        with psycopg.connect(dsn(args), application_name=APP) as c:
            c.execute("set lock_timeout = '15s'")
            c.execute("set statement_timeout = '600s'")
            if args.undo:
                result = c.execute("select pulse.org_merge_undo(%s, %s, %s)", (args.undo, actor, args.words)).fetchone()[0]
                target, kind = result["org"], "admin.org_merge_personal_undo"
            else:
                ref = args.org.strip().lower()
                org = c.execute("""select pulse.org_merge_find(%s)""", (ref,)).fetchone()[0]
                acct = c.execute("select id from pulse_priv.pulse_account where handle = %s", (args.account.strip().lower(),)).fetchone()
                if not org:
                    c.rollback(); return refuse(f"no active organisation {args.org}")
                if not acct:
                    c.rollback(); return refuse(f"no account @{args.account}")
                if args.with_clients:
                    result = c.execute("select pulse.org_merge_into_personal(%s, %s, %s, %s, true)", (org, acct[0], actor, args.words)).fetchone()[0]
                else:
                    result = c.execute("select pulse.org_merge_into_personal(%s, %s, %s, %s)", (org, acct[0], actor, args.words)).fetchone()[0]
                target, kind = result["to"], "admin.org_merge_personal"
                if new_handle:
                    # The product's own handle change, as the person's personal seat (row security and rules as theirs).
                    old = c.execute("select handle from pulse_priv.pulse_account where id = %s", (acct[0],)).fetchone()[0]
                    c.execute("select set_config('pulse.org_id', %s, true), set_config('pulse.viewer_id', %s, true)",
                              (result["to"], result["toPerson"]))
                    c.execute("select pulse.acct_claim_core(%s, '')", (new_handle,))
                    c.execute("select set_config('pulse.org_id', '', true), set_config('pulse.viewer_id', '', true)")
                    now = c.execute("select handle from pulse_priv.pulse_account where id = %s", (acct[0],)).fetchone()[0]
                    if now != new_handle:
                        c.rollback(); return refuse(f"the handle did not change to @{new_handle}")
                    result = {**result, "handle": {"from": old, "to": now}}
            detail = {k: result.get(k) for k in ("merge", "from", "fromName", "to", "moved", "kept", "withClients", "handle", "back", "org")}
            if args.apply:
                c.execute("""insert into pulse_priv.platform_audit(actor, action, target_org, target_kind, target_id, target_label, reason, detail)
                             values (%s, %s, %s, 'org', %s, %s, %s, %s)""",
                          (actor, kind, target, str(result.get("from") or result.get("org")), str(result.get("fromName") or "")[:200],
                           args.words[:400], json.dumps(detail)))
                c.commit()
            else:
                c.rollback()
                c.execute("""insert into pulse_priv.platform_audit(actor, action, target_kind, target_id, reason, detail)
                             values (%s, %s, 'org', %s, %s, %s)""",
                          (actor, kind + "_dry_run", str(result.get("from") or result.get("org")), args.words[:400],
                           json.dumps({"moved": result.get("moved") or result.get("back"), "kept": result.get("kept"),
                                       "withClients": result.get("withClients"), "handle": result.get("handle")})))
                c.commit()
    except psycopg.Error as e:
        msg = (e.diag.message_primary or str(e)).strip()
        if e.sqlstate in ("42501", "22023", "P0002", "23505"):
            return refuse(msg)
        print(f"The database failed (nothing was written): {msg}", file=sys.stderr)
        return 1
    print(json.dumps({"applied": args.apply, **detail}, indent=1, default=str))
    print("APPLIED" if args.apply else "DRY RUN: rolled back (add --apply to commit)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
