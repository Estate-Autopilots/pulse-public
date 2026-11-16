"""Read explicit HR carry-forward columns and seed provisional Oct 2026 balances. No salaries/source rows logged.
Run with the existing enrichment Python and dev DB environment. HR can correct via balance adjustments.
"""

import os
import re
import sys

sys.path.insert(0, "/home/eadev/ea-research/data/enrich")
from sources import export_sheet  # authorised read-only helper, no app writes

sys.path.insert(0, os.path.abspath("packages/sdk-py/src"))
from pulse_sdk.db import active_orgs, connect, tenant_tx
from pulse_sdk.ids import entity_id

FILE = "1SYNTH3e069a5aecdfe4b2397fe742933d0a845414f1"
MONTHS = {
    "jan": 1,
    "feb": 2,
    "mar": 3,
    "apr": 4,
    "may": 5,
    "jun": 6,
    "jul": 7,
    "aug": 8,
    "sep": 9,
    "oct": 10,
    "nov": 11,
    "dec": 12,
}


def norm(x):
    return re.sub(
        r"\s+",
        " ",
        re.sub(r"^(mr\.?|mrs\.?|ms\.?)\s+", "", str(x or "").strip().lower()),
    )


try:
    tabs, _ = export_sheet(
        {
            "id": FILE,
            "owner": "hr@estateautopilots.com",
            "mime": "application/vnd.google-apps.spreadsheet",
        }
    )
    seen = {}
    for tab in tabs:
        m = MONTHS.get(tab["title"][:3].lower())
        if not m or m > 10:
            continue
        for ri, row in enumerate(tab["rows"]):
            columns = [
                i
                for i, x in enumerate(row)
                if re.fullmatch(
                    r"(?i)carry\s*forward(?:\s*leaves[.]?)?", str(x).strip()
                )
            ]
            if not columns or not any("name" in str(x).lower() for x in row):
                continue
            ni = next(i for i, x in enumerate(row) if "name" in str(x).lower())
            ci = columns[0]
            for source_row, values in enumerate(tab["rows"][ri + 1 :], ri + 2):
                if len(values) <= max(ni, ci) or not values[ni]:
                    continue
                value = str(values[ci]).strip()
                leave = re.search(
                    r"(?i)(?:\b(\d+(?:\.\d+)?)\s*-?\s*leaves?\b|\bleaves?\s*-?\s*(\d+(?:\.\d+)?))",
                    value,
                )
                days = (
                    float(leave.group(1) or leave.group(2))
                    if leave
                    else float(value)
                    if re.fullmatch(r"\d+(?:\.\d+)?", value)
                    else None
                )
                if days is not None and days <= 365:
                    key = norm(values[ni])
                    old = seen.get(key)
                    if not old or m > old[0]:
                        seen[key] = (m, days, tab["title"], source_row)
    count = unmatched = 0
    with connect("worker") as c:
        for org in active_orgs(c):
            with tenant_tx(c, org):
                c.execute("select pulse.hr_defaults()")
                people = {
                    norm(p["display_name"]): p["id"]
                    for p in c.execute(
                        "select id,display_name from pulse.person where side='staff'"
                    )
                }
                for key, (m, days, tab, row) in seen.items():
                    pid = people.get(key)
                    if not pid:
                        unmatched += 1
                        from psycopg.types.json import Jsonb

                        c.execute(
                            """insert into pulse.review_item(org_id,source_key,kind,title,proposed,confidence,evidence)
                         values(%s,%s,'opening_balance',%s,%s,0.5,%s) on conflict do nothing""",
                            (
                                org,
                                "hr-opening:" + key,
                                "Match HR carry-forward note to a person",
                                Jsonb(
                                    {
                                        "personLabel": key,
                                        "days": days,
                                        "year": 2026,
                                        "type": "annual",
                                    }
                                ),
                                Jsonb(
                                    {
                                        "file": FILE,
                                        "sheet": tab,
                                        "row": row,
                                        "note": "Older explicit carry-forward note; HR confirms identity and Oct balance.",
                                    }
                                ),
                            ),
                        )
                        continue
                    if days == 0:
                        continue
                    rid = entity_id(org, "adjustment", "hr_opening_2026", pid)
                    reason = f"Opening at 1 Oct 2026: last explicit carry-forward note ({tab}, row {row}). Provisional: no newer anchored note. HR may correct."
                    c.execute(
                        "insert into pulse.leave_adjustment(org_id,id,person_id,type_key,leave_year,days,reason) values(%s,%s,%s,'annual',2026,%s,%s) on conflict(id) do nothing",
                        (org, rid, pid, days, reason),
                    )
                    count += 1
    print(
        {
            "opening_records": count,
            "unmatched_notes": unmatched,
            "as_of": "2026-10-01",
            "status": "provisional older notes; HR can correct",
        }
    )
except Exception as exc:  # noqa: BLE001 — print only the exception class, never private source values
    print("HR opening import failed: " + type(exc).__name__, file=sys.stderr)
    sys.exit(1)
