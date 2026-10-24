# ruff: noqa: E501  (SQL kept on one line per statement)
"""R55: what a project's own documents say about its market and its developer, for the map.

- Market prices: "₹11,395/sq.ft", "Rs. 1,800 per sq ft" in the text of files inside a project's Drive folder (research
  notes, brochures, scripts). One row per file and price, with the words around it and the kind of property (a plotting
  project's price is a plot rate). Pulse never reads outside the project's own folder for this.
- Invoice parties: Zoho invoices name the developer's legal entity ("Kairos Landmarks LLP"); the project folders that
  name it in their documents tell the map which project the invoice was for. Only the distinctive words of the party
  are searched (pulse.money_words), and a party named in more than three projects is too generic to count.

Reads the EA index (read-only) and Pulse; writes pulse.market_price and pulse_priv.money_party_evidence, then refreshes
pulse_priv.money_party. Sends nothing; no figure leaves the database except as counts in the printed receipt.

    python -m pulse_workers.place_index --org UUID [--dry-run]
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import uuid
from collections import defaultdict

PRICE = re.compile(r"(?i)(?:₹|rs\.?|inr)\s*([0-9][0-9,]{2,7}(?:\.[0-9]+)?)\s*(?:/-)?\s*(?:per|/)\s*(?:sq\.?\s*\.?\s*(?:ft|feet)|sqft|sft|square\s*(?:feet|foot))")
PLOT = re.compile(r"(?i)\b(plots?|n\.?a\.?\s*plot|land)\b")
SHOP = re.compile(r"(?i)\b(shops?|office|commercial|showroom)\b")


def prices(text: str, segment: str | None) -> list[tuple[int, str, str]]:
    """Every plausible price per sq ft in a text, its kind and the words around it (at most five per file)."""
    out: dict[int, tuple[str, str]] = {}
    seg = f" {(segment or '').lower()} "
    for m in PRICE.finditer(text or ""):
        try:
            value = int(round(float(m.group(1).replace(",", ""))))
        except ValueError:
            continue
        if not 300 <= value <= 100000 or value in out:
            continue
        around = text[max(0, m.start() - 70): m.end() + 40]
        kind = "plot" if PLOT.search(around) or re.search(r"\b(p|sp|plotting|na plots?)\b", seg) else "commercial" if SHOP.search(around) or re.search(r"\bc\b", seg) else "apartment"
        out[value] = (kind, re.sub(r"\s+", " ", around).strip()[:200])
        if len(out) >= 5:
            break
    return [(v, k, q) for v, (k, q) in out.items()]


def run(args) -> dict:
    import psycopg
    from psycopg.rows import dict_row

    from pulse_sdk.db import connect, tenant_tx

    org = uuid.UUID(args.org)
    counts: dict[str, int] = defaultdict(int)
    with psycopg.connect(os.environ["EA_INDEX_DATABASE_URL"], row_factory=dict_row, autocommit=True, options="-c default_transaction_read_only=on") as index, connect("worker") as conn:
        with tenant_tx(conn, org):
            projects = conn.execute("select id,segment,storage_root from pulse.project where kind='client_work' and storage_root like 'index-path:%'").fetchall()
            parties = conn.execute("""select distinct on (pulse.value_key(body->>'client')) pulse.value_key(body->>'client') k,body->>'client' party,pulse.money_words(body->>'client') words
                from pulse_priv.finance_live_record where kind='invoice' and not coalesce((body->>'test')::boolean,false) and coalesce(btrim(body->>'client'),'')<>''
                order by pulse.value_key(body->>'client')""").fetchall()
        roots = sorted(((p["storage_root"].removeprefix("index-path:").rstrip("/") + "/", p["id"], p["segment"]) for p in projects), key=lambda x: -len(x[0]))

        def project_of(path: str | None):
            return next(((pid, seg) for root, pid, seg in roots if (path or "").startswith(root)), (None, None))

        # Prices: only files whose text holds a rupee price per square foot.
        found = []
        for f in index.execute("select f.id,f.name,f.path,f.modified,t.body from drive_file f join drive_text t on t.file_id=f.id where not coalesce(f.trashed,false) "
                               "and f.path like 'Client Video Shoot/%%' and t.body ~* %s", (r"(₹|rs\.?|inr)\s*[0-9][0-9,]{2,7}(\.[0-9]+)?\s*(/-)?\s*(per|/)\s*(sq|sft|square)",)).fetchall():
            pid, seg = project_of(f["path"])
            if not pid:
                continue
            for value, kind, quote in prices(f["body"], seg):
                found.append((f["id"], value, pid, kind, quote, f["name"][:200], f["modified"].date() if f["modified"] else None))
        counts["price_files"] = len({x[0] for x in found})
        counts["prices"] = len(found)
        counts["price_projects"] = len({x[2] for x in found})

        # Parties: the project folders whose documents (or file and folder names) carry every distinctive word.
        evidence = []
        for p in parties:
            words = [w for w in (p["words"] or []) if len(w) >= 4]
            if not words:
                continue
            query = " & ".join(re.sub(r"[^a-z0-9]", "", w) for w in words)
            hits: dict[uuid.UUID, list[str]] = defaultdict(list)
            for f in index.execute("select f.name,f.path from drive_file f left join drive_text t on t.file_id=f.id where not coalesce(f.trashed,false) and f.path like 'Client Video Shoot/%%' "
                                   "and (t.tsv @@ to_tsquery('english',%s) or (f.name_tsv @@ to_tsquery('english',%s)) or lower(f.path) like %s) limit 400",
                                   (query, query, "%" + "%".join(words) + "%")).fetchall():
                pid, _ = project_of(f["path"])
                if pid:
                    hits[pid].append(f["name"])
            if 0 < len(hits) <= 3:
                for pid, names in hits.items():
                    evidence.append((p["k"], p["party"], pid, len(names), names[0][:300]))
        counts["party_evidence"] = len(evidence)
        counts["parties_with_evidence"] = len({e[0] for e in evidence})

        try:
            with tenant_tx(conn, org):
                store(conn, org, found, evidence, counts)
                if args.dry_run:
                    raise _DryRun()
        except _DryRun:
            pass
    return {"org": str(org)[:8], "dryRun": args.dry_run, "counts": dict(counts)}


class _DryRun(Exception):
    pass


def store(conn, org, found, evidence, counts) -> None:
    """Prices and party evidence are rebuilt from the documents each run; the parties and the map's geocode suggestions
    are refreshed from them (decisions people took are kept by those functions)."""
    conn.execute("delete from pulse.market_price where org_id=%s", (org,))
    for row in found:
        conn.execute("insert into pulse.market_price(org_id,file_id,price,project_id,kind,quote,file_name,observed_on) values(%s,%s,%s,%s,%s,%s,%s,%s) on conflict do nothing", (org, *row))
    conn.execute("delete from pulse_priv.money_party_evidence where org_id=%s", (org,))
    for row in evidence:
        conn.execute("insert into pulse_priv.money_party_evidence(org_id,party_key,party,project_id,files,sample) values(%s,%s,%s,%s,%s,%s) on conflict do nothing", (org, *row))
    counts["parties_refreshed"] = conn.execute("select pulse.money_party_refresh() n").fetchone()["n"]
    counts["geocode_suggestions"] = conn.execute("select pulse.geo_review_scan() n").fetchone()["n"]


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="pulse_workers.place_index", description=__doc__.split("\n\n")[0])
    parser.add_argument("--org", required=True)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    print(json.dumps(run(args), default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
