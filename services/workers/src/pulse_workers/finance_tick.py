"""RF1 founder reminders and 9 pm IST brief, through the existing private notification outbox."""

import io
import json
import os
import zipfile
from datetime import UTC, datetime

from psycopg.types.json import Jsonb

from .finance_desk import CA, REGISTER_FIELDS, csv_bytes, reconcile, schedule


def refresh_payroll(c, org):
    # Worker already has the approved salary-import privilege. Only financial fields
    # cross into Finance; the Accountant gets no new privilege on any HR table.
    rows = c.execute(
        "select distinct on (h.person_id,h.effective_month,h.kind) h.person_id,h.effective_month,h.kind,h.id, "
        "jsonb_build_object('month',h.effective_month,'name',p.display_name,'kind',h.kind,'amount',h.amount, "
        "'currency',h.currency,'components',h.components,'basis',"
        "'Salary register; not bank-confirmed payroll settlements') body "
        "from pulse_priv.hr_compensation h join pulse.person p on p.org_id=h.org_id and p.id=h.person_id "
        "where h.org_id=%s order by h.person_id,h.effective_month,h.kind,h.imported_at desc,h.id",
        (org,),
    ).fetchall()
    for row in rows:
        c.execute(
            "insert into pulse_priv.finance_desk_payroll(org_id,person_id,month,kind,source_id,body) "
            "values(%s,%s,%s,%s,%s,%s) on conflict(org_id,person_id,month,kind) do update "
            "set source_id=excluded.source_id,body=excluded.body "
            "where finance_desk_payroll.source_id is distinct from excluded.source_id "
            "or finance_desk_payroll.body is distinct from excluded.body",
            (org, row["person_id"], row["effective_month"], row["kind"], row["id"], Jsonb(row["body"])),
        )


def close_pack(records, files, month):
    selected = [
        {**r["body"], "kind": r["kind"], "key": r.get("key") or r["body"].get("fileKey")}
        for r in records
        if r["kind"] in ("purchase", "sales", "reimbursement") and str(r["body"].get("date", "")).startswith(month)
    ]
    selected = list({i.get("purchaseKey") or i["key"]: i for i in selected}.values())
    exceptions = [
        r["body"] for r in records if r["kind"] == "exception" and r["body"].get("kind") != "weekly_exceptions"
    ]
    bank = [r["body"] for r in records if r["kind"] == "bank" and str(r["body"].get("date", "")).startswith(month)]
    reconciliation = reconcile(selected, bank)
    evidence = selected + bank + [e for e in exceptions if str(e.get("date", "")).startswith(month)]
    pack = io.BytesIO()
    with zipfile.ZipFile(pack, "w", zipfile.ZIP_DEFLATED) as archive:

        def add(name, content):
            info = zipfile.ZipInfo(name, (2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, content)

        add("register.csv", csv_bytes(selected, REGISTER_FIELDS))
        add("reconciliation.json", json.dumps(reconciliation))
        add(
            "payroll.csv",
            csv_bytes(
                [
                    r["body"]
                    for r in records
                    if r["kind"] == "payroll" and str(r["body"].get("month", "")).startswith(month)
                ],
                ["month", "name", "kind", "amount", "currency", "components"],
            ),
        )
        add("open-exceptions.json", json.dumps(exceptions))
        for file in files:
            if any(i.get("fileKey") == file["key"] for i in evidence):
                add("Evidence/" + file["name"], bytes(file["bytes"]))
    return pack.getvalue(), {
        "month": month,
        "to": CA,
        "subject": "Vikriya Solutions LLP — " + month + " close pack",
        "emailBody": (
            f"Please review the {month} register, invoice PDFs, "
            "reconciliation and open exceptions in the attached pack."
        ),
        "packKey": "pack:" + month,
        "exceptions": exceptions,
        "invoiceCount": len(selected),
        "coverage": "Uploaded statements only; check bank coverage and outstanding extraction reviews before approval",
        "status": "draft_founder_approval_required",
    }


def tick(c, org, at=None):
    at = at or datetime.now(UTC)
    refresh_payroll(c, org)
    snapshot = c.execute("select pulse.finance_desk_snapshot(%s) data", (at,)).fetchone()["data"]
    records = snapshot["records"]
    pt_dates = [d.strip() for d in os.environ.get("PULSE_FINANCE_PT_DATES", "").split(",") if d.strip()]
    for job in schedule(at, records, pt_dates, snapshot["facts"]):
        kind = (
            "close"
            if job["kind"] == "close_due"
            else "exception"
            if job["kind"] == "weekly_exceptions"
            else job["kind"]
        )
        title = job.get("title", "")
        if kind == "close":
            if any(r["kind"] == "close" and r["key"] == job["key"] for r in records):
                continue
            files = c.execute(
                "select key,name,bytes from pulse_priv.finance_desk_file where org_id=%s and not synthetic", (org,)
            ).fetchall()
            content, body = close_pack(records, files, job["month"])
            c.execute(
                "insert into pulse_priv.finance_desk_file(org_id,key,name,mime,bytes,synthetic) "
                "values(%s,%s,%s,'application/zip',%s,false) on conflict do nothing",
                (org, body["packKey"], job["month"] + "-close.zip", content),
            )
            title = "Monthly close pack ready for founder review: " + job["month"]
        else:
            body = job
        if kind == "brief":
            title = (
                "9 pm brief · "
                + job["date"]
                + "\n"
                + "\n".join(
                    label + ": " + ("unknown" if job[field] is None else json.dumps(job[field], ensure_ascii=False))
                    for field, label in [
                        ("deliveries", "Deliveries"),
                        ("whoWorked", "Who worked"),
                        ("moneyIn", "Money in"),
                        ("moneyOut", "Money out"),
                        ("openApprovals", "Open approvals"),
                        ("risks", "Risks"),
                    ]
                )
            )
        if kind == "exception":
            title = (
                "Weekly finance exceptions: "
                + str(len(job["exceptions"]))
                + "; check missing invoices, payments and company GSTIN"
            )
        c.execute(
            "insert into pulse_priv.finance_desk_record(org_id,kind,key,body,synthetic) "
            "values(%s,%s,%s,%s,false) on conflict do nothing",
            (org, kind, job["key"], Jsonb(body)),
        )
        view = (
            "brief"
            if kind == "brief"
            else "close"
            if kind == "close"
            else "exception"
            if kind == "exception"
            else "reminder"
        )
        for founder in snapshot["founders"]:
            c.execute(
                "select pulse.finance_desk_notify(%s,%s,%s,%s)",
                (founder, job["key"], title, "/finance/desk?view=" + view),
            )
