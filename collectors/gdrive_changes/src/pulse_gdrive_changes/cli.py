"""pulse-drive-changes: run the Drive changes worker and its reviewed operator actions.

Off unless PULSE_DRIVE_CHANGES=1. Output is counts and codes only; connection strings, credentials, page tokens and
channel tokens are never printed.
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import sys
import threading
import uuid
from collections.abc import Callable, Mapping
from typing import Any

import psycopg
from psycopg.rows import dict_row

from pulse_sdk.db import active_orgs, tenant_tx, url_for

from . import connect, feed
from .drive import DriveError, GoogleDrive

ENABLED_ENV = "PULSE_DRIVE_CHANGES"
HOOK_ENV = "PULSE_DRIVE_CHANGES_HOOK_URL"
POLL_ENV = "PULSE_DRIVE_CHANGES_POLL"
TICK_SECONDS = 30


def _poll_seconds(value: Any) -> int:
    try:
        return max(60, int(value))
    except (TypeError, ValueError, OverflowError):
        return feed.DEFAULT_POLL_SECONDS


def api_for(install_org: uuid.UUID | str | None) -> Callable[[Mapping[str, Any]], GoogleDrive]:
    """Opens each root with its own company's credential (R52: connect.credential_for), never another company's."""
    def google_api(source: Mapping[str, Any]) -> GoogleDrive:
        return GoogleDrive(*connect.credential_for(source, install_org))
    return google_api


def _install_org(conn: psycopg.Connection) -> uuid.UUID | None:
    with conn.transaction():
        org = conn.execute("select pulse.install_org() as org_id").fetchone()["org_id"]
    return uuid.UUID(str(org)) if org else None


def _connect() -> psycopg.Connection:
    return psycopg.connect(url_for("worker"), autocommit=True, row_factory=dict_row,
                           application_name="pulse-drive-changes")


def _org(conn: psycopg.Connection, wanted: str | None) -> uuid.UUID:
    installed = conn.execute("select pulse.install_org() as org_id").fetchone()["org_id"]
    # R51: this reads with the install company's own Google credential, so it writes into that company only; another
    # company on this Pulse connects its own Drive (R52), it never borrows this one.
    if wanted and installed and uuid.UUID(wanted) != uuid.UUID(str(installed)):
        raise SystemExit("Drive changes are read for this install's own company only; "
                         "another company connects its own Drive")
    if wanted:
        return uuid.UUID(wanted)
    if not installed:
        raise SystemExit("Pulse install is not initialised; pass --org-id")
    return uuid.UUID(str(installed))


def _print(value: Any) -> None:
    print(json.dumps(value, sort_keys=True, default=str), flush=True)


def run(args: argparse.Namespace) -> int:
    if os.environ.get(ENABLED_ENV) != "1":
        _print({"drive_changes": "off", "hint": f"set {ENABLED_ENV}=1 once roots are approved (owner errand E13)"})
        return 0
    hook = os.environ.get(HOOK_ENV) or None
    if hook and not hook.startswith("https://"):
        hook = None
        print(f"{HOOK_ENV} is not an https address; polling without push channels", file=sys.stderr, flush=True)
    poll = _poll_seconds(os.environ.get(POLL_ENV))
    stop = threading.Event()
    channel_hold: dict = {}
    if args.loop:
        signal.signal(signal.SIGTERM, lambda *_: stop.set())
        signal.signal(signal.SIGINT, lambda *_: stop.set())
    while not stop.is_set():
        try:
            with _connect() as conn:
                orgs = [uuid.UUID(args.org_id)] if args.org_id else active_orgs(conn)
                google_api = api_for(_install_org(conn))
                for org in orgs:
                    for result in feed.run_once(conn, org, google_api, address=hook, poll_seconds=poll,
                                                page_size=args.page_size, max_pages=args.max_pages,
                                                channel_hold=channel_hold):
                        _print(result.summary())
        except Exception as exc:
            # Database and provider exceptions can carry connection details: report the type only.
            print(f"pulse-drive-changes failed ({type(exc).__name__}); check database access.", file=sys.stderr,
                  flush=True)
            if not args.loop:
                return 1
        if not args.loop or stop.wait(TICK_SECONDS):
            break
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="pulse-drive-changes",
                                     description="Direct Google Drive changes for approved roots (off by default)")
    parser.add_argument("--org-id", default=os.environ.get("PULSE_ORG_ID"), help="tenant (default: the installed one)")
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("run", help="poll due roots once, or every 30 s with --loop")
    p.add_argument("--loop", action="store_true")
    p.add_argument("--page-size", type=int, default=feed.DEFAULT_PAGE_SIZE)
    p.add_argument("--max-pages", type=int, default=feed.DEFAULT_MAX_PAGES)
    sub.add_parser("status", help="health of every root (counts and codes only)")
    p = sub.add_parser("add", help="register a root; it stays off until approved")
    p.add_argument("--kind", choices=("shared_drive", "folder"), required=True)
    p.add_argument("--label", required=True)
    p.add_argument("--credential-ref", required=True, help="name of the credential file, not its contents")
    p.add_argument("--drive-id")
    p.add_argument("--root-id")
    p.add_argument("--subject", help="Workspace account to read as (domain-wide delegation); omit for a member account")
    p = sub.add_parser("approve", help="record the owner's approval of a root and switch it on")
    p.add_argument("--source", required=True)
    p.add_argument("--approved-by", required=True, help="the admin recording the approval (person id)")
    p.add_argument("--approval-ref", required=True, help="where the approval is recorded, e.g. the E13 errand")
    p = sub.add_parser("disable", help="stop reading a root; its cursor, files and events stay")
    p.add_argument("--source", required=True)
    p = sub.add_parser("recover", help="after a refused cursor: restart at Google's position and record the gap")
    p.add_argument("--source", required=True)
    p.add_argument("--reviewed-by", required=True, help="the admin who reviewed the gap (person id)")
    p.add_argument("--note", required=True)
    args = parser.parse_args(argv)

    if args.command == "run":
        if not 1 <= args.page_size <= feed.MAX_PAGE_SIZE or not 1 <= args.max_pages <= 100:
            parser.error(f"--page-size is 1-{feed.MAX_PAGE_SIZE} and --max-pages is 1-100")
        return run(args)
    try:
        with _connect() as conn:
            org = _org(conn, args.org_id)
            if args.command == "status":
                _print({"drive_changes": "on" if os.environ.get(ENABLED_ENV) == "1" else "off",
                        "sources": feed.status(conn, org)})
            elif args.command == "add":
                _print({"source": feed.add_source(conn, org, kind=args.kind, label=args.label,
                                                  credential_ref=args.credential_ref, drive_id=args.drive_id,
                                                  root_id=args.root_id, subject=args.subject), "enabled": False})
            elif args.command == "approve":
                feed.approve_source(conn, org, args.source, approved_by=args.approved_by,
                                    approval_ref=args.approval_ref)
                _print({"source": args.source, "enabled": True})
            elif args.command == "disable":
                feed.disable_source(conn, org, args.source)
                _print({"source": args.source, "enabled": False})
            elif args.command == "recover":
                with tenant_tx(conn, org):
                    source = feed.load_source(conn, args.source)
                if source is None:
                    parser.error("no such root in this organisation")
                api = api_for(_install_org(conn))(source)
                _print(feed.recover(conn, api, org, args.source, reviewed_by=args.reviewed_by,
                                    note=args.note))
    except (PermissionError, LookupError, ValueError) as exc:
        print(f"refused: {exc}", file=sys.stderr, flush=True)
        return 2
    except DriveError as exc:
        print(f"Drive refused the request ({exc.code})", file=sys.stderr, flush=True)
        return 1
    except psycopg.Error as exc:
        print(f"database refused the request ({type(exc).__name__})", file=sys.stderr, flush=True)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
