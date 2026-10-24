"""Leadership-authorized Finance import of the credential-free Kazuk Tools exports.

Only Tools.csv and Office.csv are opened. Diagnostics and audit entries contain counts/field names only.
Original receipt observations and manual metadata are archived in restricted Finance evidence before merging.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
import sys
from collections import defaultdict
from decimal import Decimal
from pathlib import Path

from psycopg.types.json import Jsonb

from pulse_sdk.db import connect, tenant_tx

SOURCE = "Kazuk Tools sheet"
READ_DATE = "2026-10-06"
SHEET = "1SYNTH76c00ddef6c198c8279c60c79eb68fea95e2e2"
ALIASES = {
    "chatgpt": "openai",
    "claude": "anthropic",
    "google workshop": "google workspace",
    "11 lab": "elevenlabs",
    "11 labs": "elevenlabs",
    "zoho inovice": "zoho",
    "zoho invoice": "zoho",
    "rent": "office rent",
    "maintaince": "maintenance",
}


def vendor(value):
    key = " ".join(str(value or "").lower().split())
    if re.search(r"electric|eletric|elec\b", key):
        return "electricity"
    return ALIASES.get(key, key)


def numeric(value):
    if not str(value).strip():
        return None
    result = Decimal(str(value).strip().replace(",", ""))
    if not result.is_finite() or result < 0:
        raise ValueError("Invalid non-negative cost or quantity; values omitted")
    return str(result)


def read_exports(directory):
    exports = []
    for filename in ("Tools.csv", "Office.csv"):
        raw = (directory / filename).read_bytes()
        rows = list(csv.reader(raw.decode("utf-8-sig").splitlines()))
        tool = filename == "Tools.csv"
        if tool:
            if rows[0] != ["Tools Name", "Quantity", "per month"]:
                raise ValueError("Unexpected Tools columns; credential-bearing exports are prohibited")
            rows = rows[1:]
        records = []
        for line, row in enumerate(rows, 2 if tool else 1):
            if len(row) != (3 if tool else 2):
                raise ValueError("Unexpected export width")
            name = row[0].strip()
            if not name or name.lower() == "total":
                continue
            cost = numeric(row[-1])
            if cost is None:
                raise ValueError("Named cost has no monthly value")
            seats = numeric(row[1]) if tool else None
            if seats is not None and (Decimal(seats) != int(Decimal(seats)) or Decimal(seats) > 100000):
                raise ValueError("Invalid seat count")
            records.append(
                {
                    "vendor": vendor(name),
                    "name": name,
                    "planned_monthly_cost": cost,
                    "seats": int(Decimal(seats)) if seats is not None else None,
                    "file": filename,
                    "row": line,
                    "tool": tool,
                }
            )
        if len({r["vendor"] for r in records}) != len(records):
            raise ValueError("Duplicate export vendor requires review")
        exports.append(
            {
                "file": filename,
                "sha256": hashlib.sha256(raw).hexdigest(),
                "raw_rows": len(rows),
                "skipped": len(rows) - len(records),
                "records": records,
            }
        )
    return exports


def flag(c, org, key, fields):
    title = "Finance source conflict: " + key
    c.execute(
        """insert into pulse.review_item(org_id,source_key,kind,entity_type,title,proposed,evidence)
        values(%s,%s,'correction','money',%s,%s,%s) on conflict(org_id,source_key) do update
        set proposed=excluded.proposed,evidence=excluded.evidence where review_item.status='pending'""",
        (
            org,
            "kazuk-tools:conflict:" + key,
            title,
            Jsonb(
                {
                    "vendor": key,
                    "fields": sorted(fields),
                    "instruction": (
                        "Open Money with amount permission to compare sources; confirm contract and vendor details."
                    ),
                }
            ),
            Jsonb({"sources": [SOURCE, "Prior Finance observations"], "read_date": READ_DATE}),
        ),
    )


def seed_money_observation(c, org, dataset, row, evidence, batch):
    """Source replay refreshes merged evidence without recreating aliases or erasing monthly plans."""
    alias = [{"dataset": dataset, "source_key": row["id"]}]
    canonical = c.execute(
        """select * from pulse_priv.money_observation where
        (dataset=%s and source_key=%s) or payload->'source_aliases' @> %s::jsonb
        order by (payload ? 'canonical_vendor') desc limit 1""",
        (dataset, row["id"], Jsonb(alias)),
    ).fetchone()
    if canonical and "canonical_vendor" in canonical["payload"]:
        merged = dict(canonical["evidence"])
        sources = {(r["dataset"], r["source_key"]): r for r in merged.get("source_observations", [])}
        sources[(dataset, row["id"])] = {
            "dataset": dataset,
            "source_key": row["id"],
            "payload": row,
            "evidence": evidence,
            "import_id": str(batch),
            "approved": False,
        }
        merged["source_observations"] = list(sources.values())
        payload = dict(canonical["payload"])
        apply_latest_charge(payload, sources.values())
        c.execute(
            "update pulse_priv.money_observation set payload=%s,evidence=%s where dataset=%s and source_key=%s",
            (Jsonb(payload), Jsonb(merged), canonical["dataset"], canonical["source_key"]),
        )
        return
    c.execute(
        """insert into pulse_priv.money_observation(org_id,dataset,source_key,payload,evidence,import_id)
        values(%s,%s,%s,%s,%s,%s) on conflict(org_id,dataset,source_key) do update
        set payload=excluded.payload,evidence=excluded.evidence,import_id=excluded.import_id""",
        (org, dataset, row["id"], Jsonb(row), Jsonb(evidence), batch),
    )


def apply_latest_charge(payload, observations):
    dated = sorted(
        observations,
        key=lambda r: str(r["payload"].get("last_charge_date") or r["payload"].get("last_observed_date") or ""),
        reverse=True,
    )
    for row in dated:
        p = row["payload"]
        value = p.get("last_charge_amount")
        if value in (None, ""):
            value = p.get("last_amount")
        if value not in (None, ""):
            payload["last_charge_amount"] = value
            payload["last_charge_date"] = p.get("last_charge_date") or p.get("last_observed_date") or ""
            payload["observed_currency"] = p.get("currency") or ""
            if not payload.get("currency") and p.get("currency"):
                payload["currency"] = p["currency"]
            break


def import_exports(c, org, exports):
    # The named principal must already have leadership/admin authority AND each separate Money grant.
    allowed = c.execute("""select exists(select 1 from pulse.role_assignment where person_id=pulse.current_viewer()
        and role_key in ('admin','leadership') and current_date between valid_from and coalesce(valid_to,'infinity'))
        and (select count(distinct permission)=3 from pulse.money_permission where person_id=pulse.current_viewer()
        and revoked_at is null
        and permission in ('money.read','money.amount.read','money.plan.write')) ok""").fetchone()
    if not allowed["ok"]:
        raise PermissionError("Existing leadership Finance grants are required")
    c.execute("select pg_advisory_xact_lock(hashtext(%s))", ("kazuk-tools:" + str(org),))
    existing = c.execute("""select * from pulse_priv.money_observation
        where dataset in ('subscriptions','recurring') order by dataset,source_key for update""").fetchall()
    groups = defaultdict(list)
    for row in existing:
        groups[vendor(row["payload"].get("tool") or row["payload"].get("vendor"))].append(row)
    incoming = {r["vendor"]: r for e in exports for r in e["records"]}
    batches = {}
    for e in exports:
        batches[e["file"]] = c.execute(
            """insert into pulse.import_batch(org_id,dataset,sha256,row_count)
            values(%s,%s,%s,%s) on conflict(org_id,dataset,sha256) do update set row_count=excluded.row_count
            returning id""",
            (org, "kazuk_tools_" + e["file"].split(".")[0].lower(), e["sha256"], len(e["records"])),
        ).fetchone()["id"]
    counts = {
        "tools": len(exports[0]["records"]),
        "office": len(exports[1]["records"]),
        "new": 0,
        "matched": 0,
        "duplicates_merged": 0,
        "conflicts": 0,
    }
    for key in sorted(set(groups) | set(incoming)):
        prior, item = groups[key], incoming.get(key)
        conflicts = set()
        # Prefer a manually edited canonical record, then the subscriptions dataset, then its stable key.
        details = []
        for row in prior:
            detail = c.execute(
                "select * from pulse_priv.money_tool_detail where dataset=%s and source_key=%s",
                (row["dataset"], row["source_key"]),
            ).fetchone()
            if detail:
                details.append(detail)
        prior.sort(
            key=lambda r: (
                not any(d["dataset"] == r["dataset"] and d["source_key"] == r["source_key"] for d in details),
                r["dataset"] != "subscriptions",
                r["source_key"],
            )
        )
        base = prior[0] if prior else None
        ds = base["dataset"] if base else ("subscriptions" if item["tool"] else "recurring")
        source_key = base["source_key"] if base else "kazuk:" + hashlib.sha256(key.encode()).hexdigest()[:20]
        payload = (
            dict(base["payload"]) if base else {"id": source_key, "tool" if item["tool"] else "vendor": item["name"]}
        )
        archive = []
        for row in prior:
            evidence = row["evidence"]
            if isinstance(evidence, dict) and "source_observations" in evidence:
                archive.extend(evidence["source_observations"])
            else:
                archive.append(
                    {
                        "dataset": row["dataset"],
                        "source_key": row["source_key"],
                        "payload": row["payload"],
                        "evidence": evidence,
                        "approved": row["approved"],
                        "import_id": str(row["import_id"] or ""),
                    }
                )
        archive = list({(r["dataset"], r["source_key"]): r for r in archive}.values())
        payload["canonical_vendor"] = key
        payload["source_aliases"] = [{"dataset": r["dataset"], "source_key": r["source_key"]} for r in archive]
        for field in ("currency", "cycle", "last_charge_amount", "last_amount"):
            vals = {
                str(r["payload"].get(field)) for r in archive if r["payload"].get(field) not in (None, "", "unknown")
            }
            if len(vals) > 1:
                conflicts.add(field)
        evidence = dict(base["evidence"]) if base and isinstance(base["evidence"], dict) else {}
        evidence["source_observations"] = archive
        # Keep the most recent receipt's charge separate from the planned monthly total.
        charges = sorted(
            archive,
            key=lambda r: str(r["payload"].get("last_charge_date") or r["payload"].get("last_observed_date") or ""),
            reverse=True,
        )
        apply_latest_charge(payload, charges)
        if key == "electricity":
            payload["vendor"] = "Electricity"
        if item:
            counts["matched" if base else "new"] += 1
            for r in archive:
                p = r["payload"]
                observed = p.get("last_charge_amount") or p.get("last_amount")
                if observed not in (None, "") and Decimal(str(observed)) != Decimal(item["planned_monthly_cost"]):
                    conflicts.add("planned_monthly_cost_vs_observed_charge")
                if p.get("cycle") not in (None, "", "unknown") and "month" not in str(p["cycle"]):
                    conflicts.add("cycle")
            if details and item["seats"] is not None and any(d["seats"] not in (None, item["seats"]) for d in details):
                conflicts.add("seats")
            if key in ("wifi", "sim recharge"):
                conflicts.add("vendor_identity")
            if item["seats"] is None:
                conflicts.add("missing_seats")
            payload.update(
                planned_monthly_cost=item["planned_monthly_cost"],
                planned_currency="INR",
                planned_cadence="monthly",
                planned_source=SOURCE,
                planned_as_of=READ_DATE,
                seats=item["seats"],
                category="Subscriptions"
                if item["tool"] and key not in ("electricity", "wifi", "sim recharge")
                else "Office",
                sources=[SOURCE]
                + (["Gmail receipts"] if any(r["dataset"] == "subscriptions" for r in archive) else [])
                + (["Finance recurring observations"] if any(r["dataset"] == "recurring" for r in archive) else []),
            )
            if not item["tool"] or payload.get("cycle") in (None, "", "unknown"):
                payload["cycle"] = "monthly"
                payload["cycle_basis"] = "planned monthly cost"
            evidence["kazuk_tools"] = {
                "source": SOURCE,
                "sheet_id": SHEET,
                "read_date": READ_DATE,
                "file": item["file"],
                "row": item["row"],
                "quantity_basis": "seats",
                "cost_basis": "total planned monthly cost, not cost per seat",
                "currency_basis": "INR local cost plan; confirm against contracts",
            }
        elif base and isinstance(base["evidence"], dict):
            evidence.update({k: v for k, v in base["evidence"].items() if k != "source_observations"})
        c.execute(
            """insert into pulse_priv.money_observation(org_id,dataset,source_key,payload,evidence,import_id)
            values(%s,%s,%s,%s,%s,%s) on conflict(org_id,dataset,source_key) do update
            set payload=excluded.payload,evidence=excluded.evidence,import_id=excluded.import_id""",
            (
                org,
                ds,
                source_key,
                Jsonb(payload),
                Jsonb(evidence),
                batches[item["file"]] if item else base["import_id"],
            ),
        )
        for row in prior[1:]:
            # All metadata survives inside restricted evidence, including conflicting manual edits.
            for table in ("money_tool_detail", "money_category", "money_match"):
                metadata = c.execute(
                    f"select * from pulse_priv.{table} where dataset=%s and source_key=%s",
                    (row["dataset"], row["source_key"]),
                ).fetchone()
                if metadata:
                    evidence.setdefault("merged_metadata", []).append(
                        {"table": table, "record": json.loads(json.dumps(metadata, default=str))}
                    )
                    present = c.execute(
                        f"select * from pulse_priv.{table} where dataset=%s and source_key=%s", (ds, source_key)
                    ).fetchone()
                    if not present:
                        c.execute(
                            f"update pulse_priv.{table} set dataset=%s,source_key=%s "
                            "where dataset=%s and source_key=%s",
                            (ds, source_key, row["dataset"], row["source_key"]),
                        )
                    else:
                        conflicts.add(table)
                        c.execute(
                            f"delete from pulse_priv.{table} where dataset=%s and source_key=%s",
                            (row["dataset"], row["source_key"]),
                        )
            c.execute(
                "delete from pulse_priv.money_observation where dataset=%s and source_key=%s",
                (row["dataset"], row["source_key"]),
            )
            counts["duplicates_merged"] += 1
        if "merged_metadata" in evidence:
            c.execute(
                "update pulse_priv.money_observation set evidence=%s where dataset=%s and source_key=%s",
                (Jsonb(evidence), ds, source_key),
            )
        if conflicts:
            flag(c, org, key, conflicts)
            counts["conflicts"] += 1
    c.execute(
        """insert into pulse.audit_event(org_id,actor_id,actor_account,action,resource,resource_id,fields,source)
        values(%s,pulse.current_viewer(),current_setting('pulse.actor_account'),'import','money.kazuk_tools',%s,
        array['tools','office','planned_monthly_cost','seats','provenance','vendor_merge'],'pulse')""",
        (org, ":".join(e["sha256"] for e in exports)),
    )
    counts["final"] = {
        r["dataset"]: r["n"]
        for r in c.execute("""select dataset,count(*)::int n
        from pulse_priv.money_observation where dataset in ('subscriptions','recurring') group by dataset""")
    }
    return counts


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dir", type=Path, required=True)
    parser.add_argument("--org", required=True)
    parser.add_argument("--viewer", required=True)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    exports = read_exports(args.dir)
    with connect("worker") as conn, conn.transaction(force_rollback=args.dry_run):
        with tenant_tx(conn, args.org, args.viewer) as c:
            c.execute("set local role pulse_worker")
            c.execute("select set_config('pulse.actor_account','codex:authorized-kazuk-tools-import',true)")
            result = import_exports(c, args.org, exports)
    print(json.dumps({"dry_run": args.dry_run, **result}))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print("Finance Tools import failed: " + type(exc).__name__ + "; values omitted", file=sys.stderr)
        raise SystemExit(1) from None
