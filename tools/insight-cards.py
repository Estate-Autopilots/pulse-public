"""INSIGHTS-2: load insight cards, patterns and mining rounds into Pulse (migration 1082), data only. Company-neutral: the
rows are built outside this repository (for example by a pattern-mining job) and this tool only stores them, so new
insights reach a running database without a code ship.

  Load directory (each file optional, one JSON object per line):
    runs.jsonl      {"id", "source", "kind": "round"|"load", "round", "version", "started_at", "finished_at", "counts", "saturation", "stats", "note"}
    patterns.jsonl  {"id", "status", "family", "area", "unit", "statement", "detail", "outcome", "feature", "segment", "direction",
                     "effect_kind", "effect", "ci_low", "ci_high", "support", "exposed", "p_value", "q_value", "replication", "stability",
                     "novelty_key", "value_inr", "value_days", "value_basis", "action", "evidence", "chart", "data", "scope",
                     "audience", "tags", "rank", "run_id", "version"}
    cards.jsonl     {"id", "area", "tab", "ord", "title", "so_what", "action", "kpis", "chart", "data", "evidence", "pattern_ids",
                     "scope", "audience", "source", "version", "run_id"}

    PULSE_DATABASE_URL_MIGRATE=... uv run --all-packages python tools/insight-cards.py load <dir> [--commit] [--retire-missing] [--source patterns]
    ... tools/insight-cards.py status

A load upserts by id in one transaction; a row whose content is unchanged is left alone, a changed one gets version + 1
(unless the file gives a higher version). --retire-missing retires the source's patterns and cards that the load does not
carry (never deletes). Without --commit nothing is written (a dry run with the same counts). Prints counts only.
"""
import argparse
import importlib.util
import json
import sys
from collections import Counter
from decimal import Decimal
from pathlib import Path

from psycopg.types.json import Jsonb

spec = importlib.util.spec_from_file_location("wa_import", Path(__file__).with_name("wa-import.py"))
wa_import = importlib.util.module_from_spec(spec); spec.loader.exec_module(wa_import)

DEFAULTED = {"counts", "saturation", "stats", "segment", "evidence", "data", "scope", "audience", "kpis", "tags", "pattern_ids", "status", "source", "ord", "version"}
JSON = {"counts", "saturation", "stats", "segment", "replication", "stability", "evidence", "chart", "data", "scope", "audience", "kpis"}
RUN = ["id", "source", "kind", "round", "version", "started_at", "finished_at", "counts", "saturation", "stats", "note"]
PATTERN = ["id", "run_id", "status", "family", "area", "unit", "statement", "detail", "outcome", "feature", "segment", "direction", "effect_kind", "effect",
           "ci_low", "ci_high", "support", "exposed", "p_value", "q_value", "replication", "stability", "novelty_key", "value_inr", "value_days",
           "value_basis", "action", "evidence", "chart", "data", "scope", "audience", "tags", "rank"]
CARD = ["id", "area", "tab", "ord", "title", "so_what", "action", "kpis", "chart", "data", "evidence", "pattern_ids", "scope", "audience", "source", "run_id"]
ALIAS = {"soWhat": "so_what", "patternIds": "pattern_ids", "p": "p_value", "q": "q_value", "run": "run_id", "effectKind": "effect_kind", "ciLow": "ci_low",
         "ciHigh": "ci_high", "valueInr": "value_inr", "valueDays": "value_days", "valueBasis": "value_basis", "noveltyKey": "novelty_key", "pattern": "pattern_ids"}


def rows(path):
    if not path.exists():
        return []
    out = []
    for n, line in enumerate(path.read_text().split("\n"), 1):
        if not line.strip():
            continue
        try:
            r = json.loads(line)
        except json.JSONDecodeError:
            sys.exit(f"{path.name}:{n}: not JSON")
        out.append({ALIAS.get(k, k): v for k, v in r.items()})
    return out


def shape(r, cols, source):
    o = {k: r.get(k) for k in cols if k in r}
    if "value" in r and isinstance(r["value"], dict):          # contract v1: {"value": {"score", "money"|"inr", "days", "arithmetic"}}
        v = r["value"]; o.setdefault("value_inr", v.get("inr", v.get("money"))); o.setdefault("value_days", v.get("days")); o.setdefault("value_basis", v.get("arithmetic"))
    if "effect" in r and isinstance(r["effect"], dict):
        e = r["effect"]; o["effect"] = e.get("size"); o.setdefault("effect_kind", e.get("kind"))
        if isinstance(e.get("ci"), list) and len(e["ci"]) == 2: o.setdefault("ci_low", e["ci"][0]); o.setdefault("ci_high", e["ci"][1])
    if isinstance(o.get("pattern_ids"), str): o["pattern_ids"] = [o["pattern_ids"]]
    if isinstance(o.get("audience"), str): o["audience"] = {"rule": "leadership"} if o["audience"] in ("leaders", "leadership") else {"rule": o["audience"]}
    if "subject" in r and isinstance(r["subject"], dict) and "scope" not in o:
        s = r["subject"]; o["scope"] = {f"{s.get('kind')}_id": s.get("id")} if s.get("kind") in ("person", "client", "project") else {s.get("kind"): s.get("id")} if s.get("kind") == "pod" else {}
    if "source" in cols and not o.get("source"): o["source"] = source
    # a null for a column with a default (lists, objects, the audience) means "the default", never a null
    o = {k: v for k, v in o.items() if not (v is None and k in DEFAULTED)}
    return {k: (Jsonb(v) if k in JSON and v is not None else v) for k, v in o.items()}


def eq(a, b):
    """The stored value equals the loaded one (numerics compared as numbers, tags as lists)."""
    if isinstance(a, Decimal) and isinstance(b, (int, float)):
        return float(a) == float(b)
    return a == b


def put(cur, table, row, counts, kind, vin=None):
    """Insert a new row, leave an unchanged one alone, update a changed (or retired, now back) one with version + 1."""
    cols = list(row)
    versioned = table != "insight_run"
    old = cur.execute(f"select * from pulse_priv.{table} where org_id = pulse.current_org() and id = %s", (row["id"],)).fetchone()
    if old is None:
        vcols = cols + (["version"] if versioned and vin else [])
        vals = [row[c] for c in cols] + ([vin] if versioned and vin else [])
        cur.execute(f"insert into pulse_priv.{table} (org_id, {', '.join(vcols)}) values (pulse.current_org(), {', '.join(['%s'] * len(vcols))})", vals)
        counts[f"{kind}_new"] += 1
        return
    same = all(eq(old.get(c), row[c].obj if isinstance(row[c], Jsonb) else row[c]) for c in cols)
    revived = (table == "insight_card" and old.get("retired_at") is not None) or (table == "insight_pattern" and old.get("status") == "retired" and row.get("status", "candidate") != "retired")
    if same and not revived:
        counts[f"{kind}_same"] += 1
        return
    sets = ", ".join(f"{c} = %s" for c in cols if c != "id")
    args = [row[c] for c in cols if c != "id"]
    if versioned:
        sets += ", refreshed_at = now(), version = greatest(version + 1, coalesce(%s, 0))"; args.append(vin)
    if table == "insight_card":
        sets += ", retired_at = null"
    cur.execute(f"update pulse_priv.{table} set {sets} where org_id = pulse.current_org() and id = %s", args + [row["id"]])
    counts[f"{kind}_changed"] += 1


def load(a):
    d = Path(a.dir)
    runs, patterns, cards = rows(d / "runs.jsonl"), rows(d / "patterns.jsonl"), rows(d / "cards.jsonl")
    for name, rs in (("patterns", patterns), ("cards", cards), ("runs", runs)):
        ids = [r.get("id") for r in rs]
        if any(not isinstance(i, str) or not i for i in ids): sys.exit(f"{name}: every row needs an id")
        if len(set(ids)) != len(ids): sys.exit(f"{name}: an id appears twice")
    con = wa_import.connect(a.org)
    counts = Counter()
    try:
        with con.cursor() as cur:
            for r in runs:
                put(cur, "insight_run", shape(r, RUN, a.source), counts, "runs")
            for r in patterns:
                put(cur, "insight_pattern", shape(r, PATTERN, a.source), counts, "patterns", r.get("version"))
            for r in cards:
                put(cur, "insight_card", shape(r, CARD, a.source), counts, "cards", r.get("version"))
            if a.retire_missing:
                keep_p = [r["id"] for r in patterns]
                if patterns:
                    cur.execute("""update pulse_priv.insight_pattern set status = 'retired', refreshed_at = now() where org_id = pulse.current_org()
                                   and status <> 'retired' and not (id = any(%s))""", (keep_p,))
                    counts["patterns_retired"] = cur.rowcount
                if cards:
                    cur.execute("""update pulse_priv.insight_card set retired_at = now() where org_id = pulse.current_org() and source = %s and retired_at is null
                                   and not (id = any(%s))""", (a.source, [r["id"] for r in cards]))
                    counts["cards_retired"] = cur.rowcount
        if a.commit:
            con.commit()
        else:
            con.rollback()
    except Exception:
        con.rollback(); raise
    print(json.dumps({"committed": bool(a.commit), "rows": {"runs": len(runs), "patterns": len(patterns), "cards": len(cards)}, **dict(sorted(counts.items()))}))


def status(a):
    con = wa_import.connect(a.org)
    r = con.execute("""select (select count(*) from pulse_priv.insight_pattern where org_id = pulse.current_org() and status = 'confirmed') confirmed,
                              (select count(*) from pulse_priv.insight_pattern where org_id = pulse.current_org() and status = 'candidate') candidate,
                              (select count(*) from pulse_priv.insight_pattern where org_id = pulse.current_org() and status = 'retired') retired,
                              (select count(*) from pulse_priv.insight_card where org_id = pulse.current_org() and retired_at is null) cards,
                              (select count(*) from pulse_priv.insight_run where org_id = pulse.current_org()) runs,
                              (select max(refreshed_at)::text from pulse_priv.insight_pattern where org_id = pulse.current_org()) refreshed""").fetchone()
    print(json.dumps(r))


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--org")
    sub = p.add_subparsers(dest="cmd", required=True)
    l = sub.add_parser("load"); l.add_argument("dir"); l.add_argument("--commit", action="store_true"); l.add_argument("--retire-missing", action="store_true")
    l.add_argument("--source", default="patterns")
    sub.add_parser("status")
    a = p.parse_args()
    {"load": load, "status": status}[a.cmd](a)


if __name__ == "__main__":
    main()
