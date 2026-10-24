"""Live finance sync for one tenant. Database URLs and keys come from the environment and are never printed.

    python -m pulse_workers.finance_live sync --org UUID [--dry-run] [--no-drive] [--no-mail] [--today YYYY-MM-DD]
    python -m pulse_workers.finance_live remodel --org UUID [--today YYYY-MM-DD]
    python -m pulse_workers.finance_live wa-screens --org UUID [--no-images] [--limit-images N] [--refresh-images]

`remodel` rebuilds the model and the CA desk rows from the stored records and the invoices issued in Pulse ERP, without
reading Drive or Gmail (after ERP invoices are issued, or on a dev database).

EA_INDEX_DATABASE_URL: the read-only EA index. PULSE_DATABASE_URL_WORKER: Pulse (worker role, row-level security).
PULSE_FINANCE_KEY: service-account key path (default /etc/estate-autopilots/google/indexer-sa.json).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import uuid
from datetime import UTC, date, datetime
from zoneinfo import ZoneInfo

from . import erp, model, sync


def run(args) -> dict:
    import psycopg
    from psycopg.rows import dict_row
    from psycopg.types.json import Jsonb

    from pulse_sdk.db import connect, tenant_tx

    org = uuid.UUID(args.org)
    today = date.fromisoformat(args.today) if args.today else datetime.now(ZoneInfo("Asia/Kolkata")).date()
    key_path = os.environ.get("PULSE_FINANCE_KEY", sync.KEY_PATH)
    receipt = {"org": str(org)[:8], "today": today.isoformat(), "dryRun": args.dry_run}
    with (
        psycopg.connect(os.environ["EA_INDEX_DATABASE_URL"], row_factory=dict_row, autocommit=True) as index,
        connect("worker") as conn,
    ):
        with tenant_tx(conn, org):
            run_id = conn.execute(
                "insert into pulse_priv.finance_live_run(org_id) values(%s) returning id", (org,)
            ).fetchone()["id"]
        try:
            with tenant_tx(conn, org):
                existing = sync.load_existing(conn)
                people = sync.people_from_db(conn)
                filed = {
                    r["key"]: dict(r)
                    for r in conn.execute("select key,file_id,path,name from pulse_priv.finance_live_filed").fetchall()
                }
            result = sync.Result()
            readers = {}

            def opener(meta):
                if meta["subject"] not in readers:
                    readers[meta["subject"]] = sync.readonly_drive(key_path, meta["subject"])
                return sync.open_workbook(readers[meta["subject"]], meta)

            gmails = {}

            def gmail_for(mailbox):
                if mailbox not in gmails:
                    gmails[mailbox] = sync.readonly_gmail(key_path, mailbox)
                return gmails[mailbox]

            workbooks = sync.discover(index)
            sync.read_sheets(result, workbooks, opener, people)
            sync.read_handoff(result, sync.env_path("PULSE_FINANCE_HANDOFF", sync.HANDOFF))
            sync.read_meta(result, index)
            # A message is fetched again only while its PDF is not yet filed in the Shared Drive.
            known = set()
            for row in existing.get("invoice", {}).values():
                if row["body"].get("drive"):
                    known.update(row["body"].get("messages") or [row["source"].get("message")])
            for key, row in existing.get("bill", {}).items():
                # A newer bill parser re-reads PDFs once; mail-header bills have nothing to re-read.
                if row["body"].get("basis") == "mail-header" or (
                    row["body"].get("drive") and row["body"].get("parser") == sync.mail.BILL_PARSER
                ):
                    known.add(key)
            sync.read_mail(result, index, gmail_for, known, existing, fetch=not args.no_mail)
            drive = (
                None
                if (args.dry_run or args.no_drive)
                else sync.SharedDrive(sync.drive_service(key_path), sync.FINANCE_DRIVE)
            )
            receipt["drive"] = sync.file_pdfs_each(conn, org, drive, result, filed, tenant_tx)
            with tenant_tx(conn, org):
                receipt["stored"] = sync.store(conn, org, run_id, result, existing)
                receipt["ads"] = sync.store_ads(conn, org, result.ads)
                merged = sync.merge(existing, result)
                records = sync.flat(merged)
                receipt["erp"] = erp.merge_into(records, erp.erp_invoices(conn))
                sources = [{"key": k, **v} for k, v in sorted(result.sources.items())]
                built = model.build(records, today, sources)
                sync.link_clients(conn, built)
                conn.execute(
                    "insert into pulse_priv.finance_live_model(org_id,body,run_id,computed_at) values(%s,%s,%s,now()) "
                    "on conflict(org_id) do update set body=excluded.body,run_id=excluded.run_id,computed_at=now()",
                    (org, Jsonb(json.loads(json.dumps(built, default=sync._json))), run_id),
                )
                receipt["desk"] = sync.store_desk(conn, sync.desk_rows(records, built))
                receipt["records"] = {kind: len(rows) for kind, rows in sorted(merged.items())}
                receipt["brief"] = len(built["brief"])
                receipt["counts"] = dict(result.counts)
                receipt["sources"] = {k: v.get("records") for k, v in sorted(result.sources.items())}
                conn.execute(
                    "update pulse_priv.finance_live_run set finished_at=now(),ok=true,counts=%s where id=%s",
                    (
                        Jsonb(
                            {k: v for k, v in receipt.items() if k in ("records", "drive", "stored", "ads", "counts")}
                        ),
                        run_id,
                    ),
                )
                if args.dry_run:
                    raise sync.DryRun
            receipt["ok"] = True
        except sync.DryRun:
            receipt["ok"] = True
        except Exception as exc:
            conn.rollback()
            with tenant_tx(conn, org):
                conn.execute(
                    "update pulse_priv.finance_live_run set finished_at=now(),ok=false,error=%s where id=%s",
                    (type(exc).__name__, run_id),
                )
            receipt.update(ok=False, error=type(exc).__name__)
        if args.dry_run:
            with tenant_tx(conn, org):
                conn.execute("delete from pulse_priv.finance_live_run where id=%s", (run_id,))
    receipt["finishedAt"] = datetime.now(UTC).isoformat()
    return receipt


def remodel(args) -> dict:
    """The model and desk rows again from stored records plus Pulse ERP invoices; no source is read."""
    from psycopg.types.json import Jsonb

    from pulse_sdk.db import connect, tenant_tx

    org = uuid.UUID(args.org)
    today = date.fromisoformat(args.today) if args.today else datetime.now(ZoneInfo("Asia/Kolkata")).date()
    receipt = {"org": str(org)[:8], "today": today.isoformat(), "remodel": True}
    with connect("worker") as conn, tenant_tx(conn, org):
        existing = sync.load_existing(conn)
        records = sync.flat(existing)
        receipt["erp"] = erp.merge_into(records, erp.erp_invoices(conn))
        sources = [
            {"key": r["key"], **r["body"]}
            for r in conn.execute("select key,body from pulse_priv.finance_live_source order by key").fetchall()
        ]
        run_id = conn.execute("select run_id from pulse_priv.finance_live_model where org_id=%s", (org,)).fetchone()
        built = model.build(records, today, sources)
        sync.link_clients(conn, built)
        conn.execute(
            "insert into pulse_priv.finance_live_model(org_id,body,run_id,computed_at) values(%s,%s,%s,now()) "
            "on conflict(org_id) do update set body=excluded.body,computed_at=now()",
            (org, Jsonb(json.loads(json.dumps(built, default=sync._json))), run_id["run_id"] if run_id else None),
        )
        receipt["desk"] = sync.store_desk(conn, sync.desk_rows(records, built))
        receipt["records"] = {kind: len(rows) for kind, rows in sorted(records.items())}
    receipt["ok"] = True
    receipt["finishedAt"] = datetime.now(UTC).isoformat()
    return receipt


def wa_screens(args) -> dict:
    """FIN-ENTRY: copy the WhatsApp payment screenshots (read-only ea_index, read-only Drive thumbnails) into Pulse."""
    import re

    import psycopg
    from psycopg.rows import dict_row

    from pulse_sdk.db import connect, tenant_tx

    from . import wa_screens as wa

    org = uuid.UUID(args.org)
    key = os.environ.get("PULSE_FINANCE_KEY", sync.KEY_PATH)
    service = None if args.no_images else sync.readonly_drive(key, wa.SUBJECT)
    with (
        psycopg.connect(os.environ["EA_INDEX_DATABASE_URL"], row_factory=dict_row, autocommit=True) as index,
        connect("worker") as conn,
    ):
        if args.set_role:
            # A dev database reached through its migration login acts as its owner role
            # (row-level security still applies).
            if not re.fullmatch(r"pulse_[a-z]+_owner|pulse_worker", args.set_role):
                raise SystemExit("--set-role takes pulse_worker or a pulse_<env>_owner role")
            conn.execute(f"set role {args.set_role}")
            conn.commit()
        receipt = wa.run(
            index,
            conn,
            org,
            tenant_tx,
            service=service,
            limit_images=args.limit_images,
            refresh_images=args.refresh_images,
        )
    return {"org": str(org)[:8], "ok": True, **receipt, "finishedAt": datetime.now(UTC).isoformat()}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="python -m pulse_workers.finance_live", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    s = sub.add_parser("sync")
    s.add_argument("--org", required=True)
    s.add_argument("--dry-run", action="store_true", help="read and model everything, then roll back; no Drive filing")
    s.add_argument("--no-drive", action="store_true", help="store records but do not file PDFs")
    s.add_argument("--no-mail", action="store_true", help="do not fetch Gmail attachments")
    s.add_argument("--today")
    r = sub.add_parser("remodel", help="rebuild the model from stored records and Pulse ERP invoices; reads no source")
    r.add_argument("--org", required=True)
    r.add_argument("--today")
    w = sub.add_parser("wa-screens", help="copy WhatsApp payment screenshots from the EA index for Finance → Entries")
    w.add_argument("--org", required=True)
    w.add_argument("--no-images", action="store_true", help="copy the rows only, no Drive thumbnails")
    w.add_argument("--limit-images", type=int, default=1000)
    w.add_argument("--refresh-images", action="store_true")
    w.add_argument("--set-role", help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    if args.command == "remodel":
        receipt = remodel(args)
    elif args.command == "wa-screens":
        receipt = wa_screens(args)
    else:
        receipt = run(args)
    print(json.dumps(receipt, sort_keys=True), flush=True)
    return 0 if receipt.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
