# ruff: noqa: E501
"""ERP-INVOICE: a draft catalog from what the company already wrote down, for the owner to approve.

    python -m pulse_workers.erp_catalog_seed --org UUID [--dry-run] [--no-drive]

- Packages and their parts from the package cost model ("Per client expenses", read-only through Drive like FIN-LIVE):
  the "4 Month"-style columns of Sheet1 (parts with units and per-task cost, the desired price) and the service sheets
  ("4 Month (3 MMV - Google ads)", "Just Model Video", ...: each service with its team, quantity, cost and 3X price).
  Only those tabs are read: the workbook also holds team salaries and model fees, which are never opened.
- Services from those sheets, with the per-service prices of "Service wise charges", and from the descriptions on
  FIN-LIVE's sales invoices ("Ad Agency Fees", ...) with their typical taxable value.

Everything is written as a draft with its source (file, tab, row); SAC codes are proposals for the CA. An item a person
has edited or approved is never changed again. Figures stay in the database; this prints counts and names only.
EA_INDEX_DATABASE_URL: the EA index. PULSE_DATABASE_URL_WORKER: Pulse (worker role). PULSE_FINANCE_KEY: service account.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import statistics
import sys
import uuid
from collections import Counter
from decimal import Decimal

from .finance_live.common import money
from .finance_live.sheets import cell, provenance, rows_of

SEEDED_BY = "erp_catalog_seed"
NOTE = "Draft from the package cost model; prices, parts and SAC need the owner's approval"
# The only tabs of "Per client expenses" this reads. Everything else (salaries, model fees, the 3X rule) is skipped.
PACKAGE_TABS = (re.compile(r"^Sheet1$"),)
SERVICE_TABS = (re.compile(r"^\d+ Month \("), re.compile(r"^Just Model Video$"), re.compile(r"^Service wise charges"))
# Proposed SAC codes by what the service is (the CA confirms them).
SAC_RULES = (
    (re.compile(r"landing page|website", re.I), "998314"),  # IT design and development
    (re.compile(r"edit", re.I), "999613"),  # audiovisual editing
    (re.compile(r"advertis|search ads|google|youtube|meta\b|portal|lead|nurtur|engine", re.I), "998361"),  # advertising
    (re.compile(r"video|film|vov|model|shoot|videograph|script|testimonial", re.I), "999612"),  # video production
    (re.compile(r"graphic|design|carousel|single image|creative", re.I), "998391"),  # specialty (graphic) design
    (re.compile(r"training|guidance", re.I), "999293"),  # commercial training
    (re.compile(r".", re.I), "998361"),  # advertising services
)


def sac_for(name: str) -> str:
    return next(code for pattern, code in SAC_RULES if pattern.search(name))


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:32] or "item"


def paise(value) -> int | None:
    m = money(value)
    return int((m * 100).to_integral_value()) if m is not None else None


def quantity(value) -> tuple[float, str | None]:
    """'3.0' → (3, None); '4 Month' → (4, 'month'); anything else → (1, None)."""
    if isinstance(value, (int, float, Decimal)) and not isinstance(value, bool):
        return (float(value) if value > 0 else 1.0), None
    m = re.match(r"^\s*(\d+(?:\.\d+)?)\s*([A-Za-z]+)?", str(value or ""))
    return (float(m.group(1)), (m.group(2) or "").lower() or None) if m else (1.0, None)


def months_plan(name: str) -> list[dict]:
    """A package named "N Month..." is billed in N monthly instalments; anything else on delivery."""
    m = re.match(r"^(\d+)\s*Month", name, re.I)
    n = int(m.group(1)) if m else 1
    if n <= 1:
        return [{"label": "On delivery", "percent": 100, "offsetDays": 0}]
    base = round(100 / n, 2)
    plan = [{"label": f"Month {i + 1}", "percent": base, "offsetDays": 30 * i} for i in range(n)]
    plan[-1]["percent"] = round(100 - base * (n - 1), 2)
    return plan


def package_columns(wb, meta) -> list[dict]:
    """Sheet1: each "N Month..." column is a package; its rows up to a "Total" row are the parts. A later block in the
    same column (more parts, another Total) is another package, named for its price."""
    out = []
    for ws in wb.worksheets:
        if not any(p.match(ws.title.strip()) for p in PACKAGE_TABS):
            continue
        rows = list(rows_of(ws))
        if not rows:
            continue
        header = [str(c or "").strip() for c in rows[0][1]]
        for col, name in enumerate(header):
            if not re.match(r"^\d+ Month", name) or col < 2:
                continue
            parts, block = [], 0
            for row_no, row in rows[1:]:
                label = str(cell(row, 0) or "").strip()
                if label.lower().startswith("total"):
                    price = paise(cell(row, col - 2))
                    if parts and price:
                        cost = paise(cell(row, col)) or sum(p["cost"] for p in parts)
                        block += 1
                        out.append(
                            {
                                "name": name if block == 1 else "Premium package (unnamed in the cost sheet)",
                                "price": price,
                                "cost": cost,
                                "parts": parts,
                                "milestones": months_plan(name),
                                "source": provenance(meta, ws, row_no),
                            }
                        )
                    parts = []
                    continue
                cost = paise(cell(row, col))
                if not label or not cost or cost <= 0:
                    continue
                qty, unit = quantity(cell(row, col - 1))
                overhead = bool(re.search(r"overhead|salary|sales & marketing", label, re.I))
                parts.append(
                    {
                        "label": "Overhead allocation" if re.search(r"overhead|salary", label, re.I) else label,
                        "quantity": qty,
                        "unit": unit,
                        "cost": cost,
                        "deliverables": [] if overhead else [f"{qty:g} × {label}" if qty != 1 else label],
                        "derives": "Cost share, not a deliverable" if overhead else "",
                        "row": row_no,
                    }
                )
    return out


def service_sheets(wb, meta) -> tuple[list[dict], dict[str, dict]]:
    """The service tabs: each a package of numbered services, each service with its team rows (role, per-task cost,
    expense, 3X price). Returns the packages and the services with any per-service list price."""
    packages, services = [], {}
    for ws in wb.worksheets:
        title = ws.title.strip()
        if not any(p.match(title) for p in SERVICE_TABS):
            continue
        rows = list(rows_of(ws))
        head = next(((n, r) for n, r in rows[:4] if any(str(c or "").strip() == "List Of Services" for c in r)), None)
        if not head:
            continue
        texts = [str(c or "").strip() for c in head[1]]
        name_col = texts.index("List Of Services")
        role_col, per_col = (
            name_col + 1,
            next((i for i, t in enumerate(texts) if t.startswith("Per Task")), name_col + 2),
        )
        exp_col, sell_col = per_col + 1, per_col + 2
        list_col = next((i for i, t in enumerate(texts) if t.startswith("Total For Each")), None)
        price, total_sell, current, parts = None, None, None, []

        for row_no, row in rows:
            if row_no <= head[0]:
                continue
            label = str(cell(row, name_col) or "").strip()
            role = str(cell(row, role_col) or "").strip()
            if label.upper().startswith("HOO"):
                price = paise(cell(row, per_col))
                parts.append(
                    {
                        "label": "HOO & HR allocation",
                        "roles": [],
                        "cost": paise(cell(row, sell_col)) or 0,
                        "overhead": True,
                        "row": row_no,
                    }
                )
                continue
            if label.lower() == "total":
                total_sell = paise(cell(row, sell_col))
                continue
            first = cell(row, 0)
            if label and not role and isinstance(first, (int, float)):  # a numbered service
                if current and current["roles"]:
                    parts.append(current)
                current = {
                    "label": label,
                    "roles": [],
                    "row": row_no,
                    "listPrice": paise(cell(row, list_col)) if list_col is not None else None,
                }
                continue
            if current and role:
                per, exp, sell = (
                    paise(cell(row, per_col)) or 0,
                    paise(cell(row, exp_col)) or 0,
                    paise(cell(row, sell_col)) or 0,
                )
                current["roles"].append({"role": role, "per": per, "expense": exp, "sell": sell, "label": label})
        if current and current["roles"]:
            parts.append(current)
        out_parts = []
        for p in parts:
            if p.get("overhead"):
                out_parts.append(
                    {
                        "label": p["label"],
                        "quantity": 1,
                        "unit": None,
                        "cost": p["cost"],
                        "deliverables": [],
                        "derives": "Cost share, not a deliverable",
                        "row": p["row"],
                    }
                )
                continue
            lead = p["roles"][0]
            qty = max(1, round(lead["expense"] / lead["per"])) if lead["per"] else 1
            cost = sum(r["expense"] for r in p["roles"])
            sell = sum(r["sell"] for r in p["roles"])
            team = ", ".join(dict.fromkeys(r["role"] for r in p["roles"]))
            unit = "month" if re.search(r"per month", " ".join(r["label"] for r in p["roles"]), re.I) else None
            out_parts.append(
                {
                    "label": p["label"],
                    "quantity": qty,
                    "unit": unit,
                    "cost": cost,
                    "price": sell or None,
                    "deliverables": [f"{qty} × {p['label']}" if qty > 1 else p["label"]],
                    "setup": f"Team: {team}",
                    "row": p["row"],
                }
            )
            key = p["label"].lower()
            known = services.setdefault(
                key,
                {
                    "name": p["label"],
                    "unitCost": cost // qty if qty else cost,
                    "unit": unit or "nos",
                    "listPrice": None,
                    "source": provenance(meta, ws, p["row"]),
                },
            )
            if p.get("listPrice"):
                known["listPrice"] = p["listPrice"]
        sell_price = price or total_sell
        # Tab names are cut at 31 characters ("Service wise charges (6 Month W"): name that one from its price column.
        name = (
            (re.sub(r"^3X\s*-\s*", "", texts[sell_col]) + " · service-wise")
            if title.lower().startswith("service wise") and sell_col < len(texts)
            else title
        )
        if sell_price and out_parts:
            packages.append(
                {
                    "name": name,
                    "price": sell_price,
                    "cost": sum(p["cost"] for p in out_parts),
                    "parts": out_parts,
                    "milestones": months_plan(title),
                    "source": provenance(meta, ws, head[0]),
                }
            )
    return packages, services


def invoice_service(description: str) -> tuple[str, int] | None:
    """A sales invoice line as a catalog service and the months it covers: "4 Months Meta Ad Fees" is four months of
    the agency retainer, "2 Month Ad Management Fees" two months of ads management. One-offs give None."""
    low = (description or "").lower()
    m = re.search(r"(\d+)\s*months?", low)
    months = int(m.group(1)) if m else 1
    if "management" in low:
        return "Meta ads management (monthly fee)", months
    if "agency" in low or re.search(r"meta ads? fees", low):
        return "Ad agency fees (monthly retainer)", months
    return None


def invoice_services(conn) -> list[dict]:
    """The recurring services on FIN-LIVE's sales invoices (from Zoho mail), each with the median monthly taxable
    value of the invoices that bill it (two invoices at least)."""
    groups: dict[str, list[float]] = {}
    for r in conn.execute(
        "select body->>'description' d,(body->>'taxable')::numeric t from pulse_priv.finance_live_record "
        "where kind='invoice' and not coalesce((body->>'test')::boolean,false) and coalesce(body->>'description','')<>''"
    ).fetchall():
        found = invoice_service(r["d"])
        if found and r["t"] is not None:
            groups.setdefault(found[0], []).append(float(r["t"]) / found[1])
    out = [
        {"name": name, "price": int(round(statistics.median(v) / 100) * 100 * 100), "count": len(v)}
        for name, v in groups.items()
        if len(v) >= 2
    ]
    return sorted(out, key=lambda x: -x["count"])


def upsert_item(conn, org, code, fields, parts=None) -> str:
    """Inserts or refreshes a draft; returns 'added', 'updated' or 'kept' (a person owns it now)."""
    row = conn.execute("select id,status,updated_by from pulse.erp_item where code=%s", (code,)).fetchone()
    from psycopg.types.json import Jsonb

    if row and (row["status"] != "draft" or row["updated_by"] is not None):
        return "kept"
    values = (
        fields["kind"],
        fields["name"][:160],
        fields.get("description", ""),
        fields.get("sac"),
        fields.get("unit") or "nos",
        fields.get("price") or 0,
        fields.get("cost"),
        Jsonb(fields.get("milestones", [])),
        fields.get("setup", ""),
        Jsonb(fields["source"]),
    )
    if row:
        item_id = row["id"]
        conn.execute(
            "update pulse.erp_item set kind=%s,name=%s,description=%s,sac=%s,unit=%s,price=%s,cost=%s,milestones=%s,setup=%s,source=%s where id=%s",
            (*values, item_id),
        )
        outcome = "updated"
    else:
        item_id = conn.execute(
            "insert into pulse.erp_item(org_id,code,kind,name,description,sac,unit,price,cost,milestones,setup,source,status) "
            "values(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'draft') returning id",
            (org, code, *values),
        ).fetchone()["id"]
        outcome = "added"
    same = parts is not None and [
        (
            r["label"],
            float(r["quantity"]),
            r["unit"],
            list(r["deliverables"]),
            r["setup"],
            r["derives"],
            r["price"],
            r["cost"],
        )
        for r in conn.execute(
            "select label,quantity,unit,deliverables,setup,derives,price,cost from pulse.erp_package_part where package_id=%s order by position",
            (item_id,),
        ).fetchall()
    ] == [
        (
            p["label"][:160],
            float(p["quantity"]),
            p.get("unit"),
            list(p.get("deliverables", [])),
            p.get("setup", ""),
            p.get("derives", ""),
            p.get("price"),
            p.get("cost"),
        )
        for p in parts
    ]
    if parts is not None and not same:  # a new version only when the parts changed
        conn.execute("delete from pulse.erp_package_part where package_id=%s", (item_id,))
        for n, p in enumerate(parts):
            conn.execute(
                "insert into pulse.erp_package_part(org_id,package_id,position,item_id,label,quantity,unit,deliverables,setup,derives,price,cost) "
                "values(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                (
                    org,
                    item_id,
                    n,
                    p.get("itemId"),
                    p["label"][:160],
                    p["quantity"],
                    p.get("unit"),
                    p.get("deliverables", []),
                    p.get("setup", ""),
                    p.get("derives", ""),
                    p.get("price"),
                    p.get("cost"),
                ),
            )
        conn.execute("update pulse.erp_item set version=version+1 where id=%s", (item_id,))
    if outcome == "added" or (parts is not None and not same):  # the log says when the seed changed something
        conn.execute(
            "insert into pulse.erp_event(org_id,subject_type,subject_id,kind,detail) values(%s,'item',%s,'seeded',%s)",
            (org, item_id, Jsonb({"by": SEEDED_BY, "outcome": outcome})),
        )
    return outcome


def seed(conn, org, workbook_meta=None, workbook=None) -> dict:
    """Writes the draft catalog in the open transaction. Returns counts and the names written (no figures)."""
    counts, names = Counter(), []
    packages, services = [], {}
    if workbook is not None:
        packages += package_columns(workbook, workbook_meta)
        sheet_packages, services = service_sheets(workbook, workbook_meta)
        packages += sheet_packages
    else:  # no Drive: FIN-LIVE's stored package cost records (price and cost, no parts)
        for r in conn.execute(
            "select key,body,source from pulse_priv.finance_live_record where kind='package_cost'"
        ).fetchall():
            packages.append(
                {
                    "name": r["key"],
                    "price": paise(r["body"].get("price")),
                    "cost": paise(r["body"].get("deliveryCost")),
                    "parts": [],
                    "milestones": months_plan(r["key"]),
                    "source": r["source"],
                }
            )
    codes = {}
    for key, s in sorted(services.items()):
        code = "svc-" + slug(s["name"])
        fields = {
            "kind": "service",
            "name": s["name"],
            "sac": sac_for(s["name"]),
            "unit": s["unit"],
            "price": s.get("listPrice") or 0,
            "cost": s.get("unitCost"),
            "description": "",
            "source": {**s["source"], "seededBy": SEEDED_BY, "note": NOTE},
        }
        counts["service_" + upsert_item(conn, org, code, fields)] += 1
        codes[key] = code
        names.append(s["name"])
    for inv in invoice_services(conn):
        code = "svc-" + slug(inv["name"])
        fields = {
            "kind": "service",
            "name": inv["name"],
            "sac": "998361",
            "unit": "month",
            "price": inv["price"],
            "description": f"As billed on {inv['count']} sales invoices (Zoho)",
            "source": {
                "type": "finance-live",
                "kind": "invoice",
                "invoices": inv["count"],
                "seededBy": SEEDED_BY,
                "note": "Typical taxable value of past invoices; draft",
            },
        }
        counts["invoice_service_" + upsert_item(conn, org, code, fields)] += 1
        names.append(inv["name"])
    ids = {
        r["code"]: r["id"]
        for r in conn.execute("select code,id from pulse.erp_item where code like 'svc-%%'").fetchall()
    }
    for p in packages:
        if not p.get("price"):
            continue
        parts = [{**part, "itemId": ids.get(codes.get(part["label"].lower(), ""))} for part in p["parts"]]
        fields = {
            "kind": "package",
            "name": p["name"],
            "sac": "998361",
            "unit": "package",
            "price": p["price"],
            "cost": p.get("cost"),
            "milestones": p["milestones"],
            "description": "Real-estate marketing package",
            "setup": "",
            "source": {**p["source"], "seededBy": SEEDED_BY, "note": NOTE},
        }
        counts["package_" + upsert_item(conn, org, "pkg-" + slug(p["name"]), fields, parts)] += 1
        names.append(p["name"])
    return {"counts": dict(counts), "names": names}


def run(args) -> dict:
    import psycopg
    from psycopg.rows import dict_row

    from pulse_sdk.db import connect, tenant_tx

    from .finance_live import sync

    org = uuid.UUID(args.org)
    meta = wb = None
    if not args.no_drive:
        with psycopg.connect(os.environ["EA_INDEX_DATABASE_URL"], row_factory=dict_row, autocommit=True) as index:
            meta = next(
                (w for w in sync.discover(index) if w["family"] == "packages" and not w["trashed"] and w["subject"]),
                None,
            )
        if meta:
            reader = sync.readonly_drive(os.environ.get("PULSE_FINANCE_KEY", sync.KEY_PATH), meta["subject"])
            wb = sync.open_workbook(reader, meta)
    with connect("worker") as conn:

        class DryRun(Exception):
            pass

        out = {}
        try:
            with tenant_tx(conn, org):
                out = seed(conn, org, meta, wb)
                if args.dry_run:
                    raise DryRun
        except DryRun:
            out["dryRun"] = True
    out["workbook"] = meta["name"] if meta else None
    return out


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="python -m pulse_workers.erp_catalog_seed", description=__doc__)
    parser.add_argument("--org", required=True)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--no-drive", action="store_true", help="use FIN-LIVE's stored package costs only (no parts)")
    print(json.dumps(run(parser.parse_args(argv)), sort_keys=True), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
