# ruff: noqa: E501
"""Import de-identified, cleaned research outputs. Counts only. Manual values always win.

Stable replay is within the supplied pseudonymised snapshot. Its per-run buyer keys must never be regenerated
and silently appended; a changed lead export is rejected pending source-row identity migration.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import uuid
from collections import defaultdict
from datetime import date
from pathlib import Path

from pulse_sdk.db import connect, tenant_tx
from pulse_workers.research_clean import locality_key, parse_ts, project_key
from pulse_workers.research_engine import store_outcomes

NS = uuid.UUID("b0d9df43-13f5-413b-a608-3698566939df")


def rid(org, kind, key):
    return uuid.uuid5(NS, f"{org}:{kind}:{key}")


def load(c, org, directory: Path, as_of: date):
    c.execute("select pg_advisory_xact_lock(hashtext(%s))", (f"research:{org}",))
    datasets = {}
    for name in (
        "engagements_clean",
        "meta_ad_accounts",
        "meta_spend_txn",
        "leads_clean",
        "meta_ad_events",
        "make_errors",
        "privyr_daily",
        "invoices_monthly",
        "mail_monthly",
    ):
        raw = (directory / f"{name}.csv").read_bytes()
        datasets[name] = (hashlib.sha256(raw).hexdigest(), list(csv.DictReader(io.StringIO(raw.decode("utf-8-sig")))))
    old = c.execute("select sha256 from pulse.research_import where dataset='leads_clean'").fetchone()
    if old and old["sha256"] != datasets["leads_clean"][0]:
        raise ValueError("Changed per-run lead pseudonyms require explicit source-row migration; import cancelled")
    projects = defaultdict(list)
    folders = {}
    for p in c.execute("""select p.id,p.project_key,p.storage_root,m.folder_id from pulse.project p
      left join pulse.project_location_member m on m.project_id=p.id"""):
        key = project_key(p["project_key"])
        if p["id"] not in projects[key]:
            projects[key].append(p["id"])
        if p["folder_id"]:
            folders[p["folder_id"]] = p["id"]
        if str(p["storage_root"] or "").startswith("gdrive:"):
            folders[p["storage_root"][7:]] = p["id"]
    clients = {}
    for r in c.execute(
        "select source_key,entity_id from pulse.identity_link where source='drive_folder_name' and entity_type='client'"
    ):
        clients[r["source_key"].removeprefix("c:")] = r["entity_id"]
    skipped_locked = updated = 0
    for r in datasets["engagements_clean"][1]:
        pid = folders.get(r["folder_id"])
        key = project_key(r["project_key"])
        c.execute(
            """insert into pulse.research_engagement(org_id,folder_id,project_id,project_key,client_key,segment,locality,month,flags)
          values(%s,%s,%s,%s,%s,%s,%s,%s,%s) on conflict(org_id,folder_id) do update set
          project_id=excluded.project_id,project_key=excluded.project_key,client_key=excluded.client_key,
          segment=excluded.segment,locality=excluded.locality,month=excluded.month,flags=excluded.flags""",
            (
                org,
                r["folder_id"],
                pid,
                key,
                r["client_key"] or None,
                r["segment_class"],
                locality_key(r["locality"]) or None,
                r["month"] + "-01" if r["month"] else None,
                r["flags"].split(";") if r["flags"] else [],
            ),
        )
        if pid:
            p = c.execute("select segment,location,locked from pulse.project where id=%s", (pid,)).fetchone()
            for field, value in [("segment", r["segment_class"]), ("location", locality_key(r["locality"]))]:
                if not value or value == "unknown":
                    continue
                if field in p["locked"]:
                    skipped_locked += 1
                    continue
                if p[field] != value:
                    # field is from the fixed allowlist above, never input SQL.
                    c.execute(f"update pulse.project set {field}=%s where id=%s", (value, pid))
                    updated += 1
    account_rows = []
    for r in datasets["meta_ad_accounts"][1]:
        key = project_key(r["project_key"]) or None
        ids = projects.get(key, [])
        account_rows.append(
            (
                org,
                r["account_id"],
                r["name"],
                key,
                clients.get(r["client_key"]),
                ids[0] if len(ids) == 1 else None,
                r["match"],
                float(r["score"] or 0),
            )
        )
    with c.cursor() as cur:
        cur.executemany(
            """insert into pulse_priv.ad_account(org_id,account_id,name,project_key,client_id,project_id,match_method,confidence)
          values(%s,%s,%s,%s,%s,%s,%s,%s) on conflict(org_id,account_id) do update set
          name=excluded.name,project_key=excluded.project_key,client_id=excluded.client_id,project_id=excluded.project_id,
          match_method=excluded.match_method,confidence=excluded.confidence where not ad_account.manual""",
            account_rows,
        )
        cur.executemany(
            """insert into pulse_priv.ad_funding(org_id,txn_key,account_id,kind,day,amount,currency,source_ref)
          values(%s,%s,%s,%s,%s,%s,%s,%s) on conflict(org_id,txn_key) do nothing""",
            [
                (
                    org,
                    r["txn_key"],
                    r["account_id"],
                    r["kind"],
                    r["day"],
                    r["amount"],
                    r["currency"],
                    f"meta_receipt:{r['txn_key']}",
                )
                for r in datasets["meta_spend_txn"][1]
            ],
        )
    leads = []
    answers = []
    touches = []
    buyers = {}
    for r in datasets["leads_clean"][1]:
        bid = rid(org, "buyer", r["buyer"])
        buyers[bid] = r["buyer"]
        lid = rid(org, "lead", r["lead_id"])
        key = project_key(r["project_key"]) or None
        ids = projects.get(key, [])
        ts = parse_ts(r["created_ist"])
        if ts and not (date(2023, 1, 1) <= ts.date() <= as_of):
            ts = None
        leads.append((lid, org, bid, ids[0] if len(ids) == 1 else None, ts, r["kind"], "research:" + r["lead_id"], key))
        answers.append(
            (
                org,
                lid,
                key,
                r["platform"] or None,
                r["creative_type"],
                r["creative_no"] or None,
                r["language"] or None,
                float(r["budget_lakh"]) if r["budget_lakh"] else None,
                r["visit_intent"] or None,
                r["config_bhk"] or None,
                r["sheet_id"],
                r["lead_id"],
            )
        )
        touches.append((org, lid, int(r["touches"] or 0), r["outcome"] or None))
    with c.cursor() as cur:
        cur.executemany(
            "insert into pulse_priv.buyer(id,org_id,phone_hash) values(%s,%s,%s) on conflict(org_id,phone_hash) do nothing",
            [(bid, org, bhash) for bid, bhash in buyers.items()],
        )
        cur.executemany(
            """insert into pulse.lead(id,org_id,buyer_id,project_id,created_at,kind,platform_lead_id,research_key)
          values(%s,%s,%s,%s,%s,%s,%s,%s) on conflict(id) do update set
          project_id=case when 'project_id'=any(lead.locked) then lead.project_id else excluded.project_id end""",
            leads,
        )
        cur.executemany(
            """insert into pulse.lead_answer(org_id,lead_id,project_key,platform,creative_type,creative_no,language,budget_lakh,visit_intent,bhk,sheet_ref,source_ref)
          values(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) on conflict(lead_id) do nothing""",
            answers,
        )
        cur.executemany(
            """insert into pulse.lead_touch(org_id,lead_id,touches,outcome) values(%s,%s,%s,%s)
          on conflict(lead_id) do update set touches=excluded.touches,outcome=excluded.outcome where not lead_touch.manual""",
            touches,
        )
    notices = []
    for i, r in enumerate(datasets["meta_ad_events"][1]):
        notices.append((org, f"meta:{i}", r["day"], r["event"], int(r["n"] or 1), r["account_id"] or None, None))
    for i, r in enumerate(datasets["make_errors"][1]):
        notices.append((org, f"make:{i}", r["day"], "pipe_error", 1, None, project_key(r["project_key"]) or None))
    for i, r in enumerate(datasets["privyr_daily"][1]):
        if r["fb_permissions_expired"] == "1":
            notices.append((org, f"privyr:{i}", r["day"], "permission_expired", 1, None, None))
    with c.cursor() as cur:
        cur.executemany(
            """insert into pulse.research_notice(org_id,source_key,day,kind,occurrences,account_ref,project_key)
          values(%s,%s,%s,%s,%s,%s,%s) on conflict(org_id,source_key) do update set day=excluded.day,
          kind=excluded.kind,occurrences=excluded.occurrences,account_ref=excluded.account_ref,project_key=excluded.project_key""",
            notices,
        )
        monthly = [(org, r["month"] + "-01", "invoices", int(r["invoices"])) for r in datasets["invoices_monthly"][1]]
        for r in datasets["mail_monthly"][1]:
            for key in ("outbound_case_study_mails", "sales_replies_received", "job_applicant_notices"):
                monthly.append((org, r["month"] + "-01", key, int(r[key] or 0)))
        cur.executemany(
            """insert into pulse.research_month(org_id,month,kind,n) values(%s,%s,%s,%s)
          on conflict(org_id,month,kind) do update set n=excluded.n""",
            monthly,
        )
    for name, (sha, rows) in datasets.items():
        c.execute(
            """insert into pulse.research_import(org_id,dataset,sha256,row_count,source_as_of)
          values(%s,%s,%s,%s,%s) on conflict(org_id,dataset) do update set sha256=excluded.sha256,
          row_count=excluded.row_count,source_as_of=excluded.source_as_of,imported_at=now()""",
            (org, name, sha, len(rows), as_of),
        )
    scores = store_outcomes(c, org, as_of)
    c.execute(
        "select pulse.audit_write('import','research.cleaning',null,array['source_hashes','deduplicated_receipts','pseudonymised_leads','manual_values_preserved'])"
    )
    return {
        **{name: len(rows) for name, (_, rows) in datasets.items()},
        "outcome_score_projections": scores,
        "updated_fields": updated,
        "manual_fields_preserved": skipped_locked,
        "engagements_linked": len([r for r in datasets["engagements_clean"][1] if r["folder_id"] in folders]),
    }


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--dir", type=Path, required=True)
    p.add_argument("--org", required=True)
    p.add_argument("--as-of", type=date.fromisoformat, required=True)
    args = p.parse_args()
    with connect("worker", autocommit=True) as c, tenant_tx(c, args.org):
        print(json.dumps(load(c, args.org, args.dir, args.as_of)))


if __name__ == "__main__":
    main()
