"""pulse-drive-extract: capture useful text from approved Drive roots, and its reviewed operator actions.

Off unless PULSE_DRIVE_EXTRACT=1. Output is counts and codes only: no file name, captured text, connection string,
credential or token is printed.
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

from pulse_gdrive_changes.connect import CredentialUnbound
from pulse_gdrive_changes.drive import CredentialUnavailable, DriveError, credential_file
from pulse_sdk.db import active_orgs, url_for

from . import extract, synthetic, worker
from .content import GoogleDriveContent

ENABLED_ENV = "PULSE_DRIVE_EXTRACT"
INTERVAL_ENV = "PULSE_DRIVE_EXTRACT_INTERVAL"
DEFAULT_INTERVAL = 600


class ScopeNotGranted(CredentialUnavailable):
    code = "scope_not_granted"


def content_for(install_org: uuid.UUID | None) -> Callable[[Mapping[str, Any]], GoogleDriveContent]:
    """R52: contents are read only from the install company's own roots, with its own credential. A company connector's
    root (EA Connect v1 asks for metadata only) and another company's root are refused before anything is read."""
    def google_content(policy: Mapping[str, Any]) -> GoogleDriveContent:
        if policy.get("install_id") is not None:
            raise ScopeNotGranted()
        if install_org is None or str(policy["org_id"]) != str(install_org):
            raise CredentialUnbound()
        return GoogleDriveContent(credential_file(str(policy["credential_ref"])), policy["subject"])
    return google_content


def _connect() -> psycopg.Connection:
    return psycopg.connect(url_for("worker"), autocommit=True, row_factory=dict_row,
                           application_name="pulse-drive-extract")


def _org(conn: psycopg.Connection, wanted: str | None) -> uuid.UUID:
    installed = conn.execute("select pulse.install_org() as org_id").fetchone()["org_id"]
    # R51: this reads with the install company's own Google credential, so it writes into that company only; another
    # company on this Pulse connects its own Drive (R52), it never borrows this one.
    if wanted and installed and uuid.UUID(wanted) != uuid.UUID(str(installed)):
        raise SystemExit("Drive text is read for this install's own company only; "
                         "another company connects its own Drive")
    if wanted:
        return uuid.UUID(wanted)
    if not installed:
        raise SystemExit("Pulse install is not initialised; pass --org-id")
    return uuid.UUID(str(installed))


def _print(value: Any) -> None:
    print(json.dumps(value, sort_keys=True, default=str), flush=True)


def _interval(value: Any) -> int:
    try:
        return max(60, int(value))
    except (TypeError, ValueError, OverflowError):
        return DEFAULT_INTERVAL


def run(args: argparse.Namespace) -> int:
    if os.environ.get(ENABLED_ENV) != "1":
        _print({"drive_extract": "off",
                "hint": f"set {ENABLED_ENV}=1 once a root's content approval is recorded (owner errands E08/E13)"})
        return 0
    limits = worker.Limits(files_per_run=args.files, bytes_per_run=args.megabytes * 1024 * 1024)
    stop = threading.Event()
    if args.loop:
        signal.signal(signal.SIGTERM, lambda *_: stop.set())
        signal.signal(signal.SIGINT, lambda *_: stop.set())
    while not stop.is_set():
        try:
            with _connect() as conn:
                orgs = [uuid.UUID(args.org_id)] if args.org_id else active_orgs(conn)
                installed = conn.execute("select pulse.install_org() as org_id").fetchone()["org_id"]
                google_content = content_for(uuid.UUID(str(installed)) if installed else None)
                for org in orgs:
                    for result in worker.run_once(conn, org, google_content, limits=limits):
                        _print(result.summary())
        except extract.SandboxUnavailable:
            print("pulse-drive-extract: the required bubblewrap sandbox does not work here; nothing was read",
                  file=sys.stderr, flush=True)
            return 1
        except Exception as exc:
            # Database and provider exceptions can carry connection details: report the type only.
            print(f"pulse-drive-extract failed ({type(exc).__name__}); check database access.", file=sys.stderr,
                  flush=True)
            if not args.loop:
                return 1
        if not args.loop or stop.wait(_interval(os.environ.get(INTERVAL_ENV))):
            break
    return 0


def selftest_cases() -> list[tuple[str, bytes, str, str | None]]:
    return [
        ("docx", synthetic.docx(table=synthetic.TABLE), "extracted", None),
        ("pdf", synthetic.pdf(), "extracted", None),
        ("csv", synthetic.sheet_csv(), "extracted", None),
        ("text", synthetic.slides_text(), "extracted", None),
        ("docx", synthetic.macro_docx(), "quarantined", "macro"),
        ("docx", synthetic.entity_docx(), "quarantined", "hostile_xml"),
        ("docx", synthetic.bomb_docx(), "quarantined", "hostile_archive"),
        ("docx", synthetic.encrypted_docx(), "quarantined", "encrypted"),
        ("pdf", synthetic.scanned_pdf(), "unsupported", "no_text_layer"),
        ("pdf", synthetic.corrupt_pdf(), "quarantined", "corrupt"),
        ("pdf", synthetic.docx(), "quarantined", "type_mismatch"),
        ("pdf", synthetic.encrypted_pdf(), "quarantined", "encrypted"),
    ]


def selftest() -> int:
    """Run the synthetic documents through the sandbox on this host (no database, no Drive)."""
    passed = failed = 0
    for kind, data, status, reason in selftest_cases():
        outcome = extract.run_extractor(kind, data)
        ok = outcome.status == status and outcome.reason == reason
        passed += ok
        failed += not ok
        if not ok:
            print(f"selftest: {kind} expected {status}/{reason}, got {outcome.status}/{outcome.reason}",
                  file=sys.stderr, flush=True)
    _print({"selftest": "pass" if not failed else "fail", "passed": passed, "failed": failed,
            "sandbox": extract.sandbox_mode()})
    return 0 if not failed else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="pulse-drive-extract",
                                     description="Useful text from approved Drive roots (off by default)")
    parser.add_argument("--org-id", default=os.environ.get("PULSE_ORG_ID"), help="tenant (default: the installed one)")
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("run", help="capture due roots once, or every 10 minutes with --loop")
    p.add_argument("--loop", action="store_true")
    p.add_argument("--files", type=int, default=worker.DEFAULT_FILES_PER_RUN, help="files per root per run")
    p.add_argument("--megabytes", type=int, default=worker.DEFAULT_BYTES_PER_RUN // (1024 * 1024),
                   help="bytes read per root per run")
    sub.add_parser("status", help="approvals, outcome counts and held files (counts and codes only)")
    sub.add_parser("verify", help="decode every stored payload and compare its length and hash")
    sub.add_parser("selftest", help="run synthetic documents through the sandbox (no database, no Drive)")
    p = sub.add_parser("approve", help="record a root's content approval (formats, audience, size), or new terms")
    p.add_argument("--source", required=True)
    p.add_argument("--approved-by", required=True, help="the admin recording the approval (person id)")
    p.add_argument("--approval-ref", required=True, help="where the approval is recorded, e.g. the E08/E13 errands")
    p.add_argument("--formats", required=True, help=f"comma-separated: {','.join(extract.FORMAT_KEYS)}")
    p.add_argument("--audience", required=True, help="comma-separated Pulse role keys that may read the text")
    p.add_argument("--max-megabytes", type=int, default=10)
    p.add_argument("--retention-note", help="the retention proposal under legal review (no automatic purge)")
    p = sub.add_parser("withdraw", help="stop extraction and reads for a root; captured text stays")
    p.add_argument("--source", required=True)
    p.add_argument("--withdrawn-by", required=True)
    p = sub.add_parser("keep-readable", help="after review: text of a file gone from Drive stays readable")
    p.add_argument("--source", required=True)
    p.add_argument("--file", required=True)
    p.add_argument("--reviewed-by", required=True)
    p.add_argument("--note", required=True)
    args = parser.parse_args(argv)

    if args.command == "selftest":
        return selftest()
    if args.command == "run":
        if not 1 <= args.files <= 500 or not 1 <= args.megabytes <= 2048:
            parser.error("--files is 1-500 and --megabytes is 1-2048")
        return run(args)
    try:
        with _connect() as conn:
            org = _org(conn, args.org_id)
            if args.command == "status":
                _print({"drive_extract": "on" if os.environ.get(ENABLED_ENV) == "1" else "off",
                        "sandbox": extract.sandbox_mode(), "roots": worker.status(conn, org)})
            elif args.command == "verify":
                result = worker.verify(conn, org)
                _print(result)
                return 1 if result["corrupt"] else 0
            elif args.command == "approve":
                if not 1 <= args.max_megabytes <= 25:
                    parser.error("--max-megabytes is 1-25")
                worker.approve(conn, org, args.source, approved_by=args.approved_by, approval_ref=args.approval_ref,
                               formats=[f.strip() for f in args.formats.split(",") if f.strip()],
                               audience=[r.strip() for r in args.audience.split(",") if r.strip()],
                               max_bytes=args.max_megabytes * 1024 * 1024, retention_note=args.retention_note)
                _print({"source": args.source, "content": "approved"})
            elif args.command == "withdraw":
                worker.withdraw(conn, org, args.source, withdrawn_by=args.withdrawn_by)
                _print({"source": args.source, "content": "withdrawn"})
            elif args.command == "keep-readable":
                review = worker.keep_readable(conn, org, args.source, args.file, reviewed_by=args.reviewed_by,
                                              note=args.note)
                _print({"review": str(review)})
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
