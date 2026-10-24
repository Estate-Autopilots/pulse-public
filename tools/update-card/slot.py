#!/usr/bin/env python3
"""Tell which scheduled slot a Paperclip routine execution stands for, and whether it may still act on it.

  python3 tools/update-card/slot.py [--issue <execution issue id>] [--grace-minutes 30]

Paperclip records only when a scheduled run was dispatched, not the cron tick it claimed. When the scheduler stops
ticking (server stopped, routine or project paused), `skip_missed` does not skip: on the first tick afterwards
every overdue trigger dispatches ONE run, hours after its slot, and the trigger jumps to the next future tick, so
the later missed ticks leave no record at all. Reading the slot from the dispatch time then names the wrong slot.

This tool rebuilds the claim the way the scheduler makes it: a schedule trigger's next tick is the first cron
minute after its previous run, or after its last edit or revision restore when that is later (both recompute the
next tick from their own time). Every tick from that one up to the dispatch is "covered" by this run. The last
covered tick is the current slot: the run may act on it only when it was dispatched within the grace window after
that tick. Every other covered tick is a missed slot: record it, never catch it up. Paperclip exposes only the
trigger's current schedule, so a run whose trigger was edited or restored after its dispatch is left unresolved.

Prints one JSON object: trigger, dispatchedAt, nominalTick (the tick Paperclip claimed), coveredTicks, currentTick,
lateMinutes (dispatch minus currentTick), onTime, slotKey (YYYY-MM-DD-am|pm of currentTick in the trigger's time
zone, null when late) and missedSlots. Reads only (GET issue, routine, routine runs, trigger and routine activity)
with PAPERCLIP_API_URL and PAPERCLIP_API_KEY; the issue defaults to PAPERCLIP_TASK_ID. Python 3 standard library.
Exit codes: 0 resolved, 2 not a scheduled routine execution or its records are incomplete.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.request
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

# Paperclip's cron grammar (server/dist/services/cron.js): five fields, day of week 0-6 with Sunday 0, and day of
# month AND day of week must both match.
FIELDS = ((0, 59), (0, 23), (1, 31), (1, 12), (0, 6))
SEARCH_MINUTES = 400 * 24 * 60
RESET_ACTIONS = {"routine.trigger_created", "routine.trigger_updated", "routine.revision_restored"}


class Unresolved(Exception):
    pass


def parse_field(token: str, lo: int, hi: int) -> frozenset[int]:
    values: set[int] = set()
    for part in token.split(","):
        base, _, step = part.strip().partition("/")
        if base == "*":
            start, end = lo, hi
        elif "-" in base:
            a, b = base.split("-", 1)
            start, end = int(a), int(b)
        else:
            start = int(base)
            end = hi if step else start
        stride = int(step) if step else 1
        if stride <= 0 or start < lo or end > hi or start > end:
            raise ValueError(f"cron field {token!r} is outside {lo}-{hi}")
        values.update(range(start, end + 1, stride))
    return frozenset(values)


def parse_cron(expression: str) -> tuple[frozenset[int], ...]:
    tokens = expression.split()
    if len(tokens) != 5:
        raise ValueError(f"cron {expression!r} needs five fields")
    return tuple(parse_field(t, lo, hi) for t, (lo, hi) in zip(tokens, FIELDS))


def matches(cron: tuple[frozenset[int], ...], local: datetime) -> bool:
    minute, hour, dom, month, dow = cron
    return (local.minute in minute and local.hour in hour and local.day in dom and local.month in month
            and (local.weekday() + 1) % 7 in dow)


def next_tick(cron: tuple[frozenset[int], ...], zone: ZoneInfo, after: datetime) -> datetime | None:
    """First cron minute strictly after the minute holding `after`, as Paperclip's nextCronTickInTimeZone."""
    cursor = after.astimezone(timezone.utc).replace(second=0, microsecond=0) + timedelta(minutes=1)
    for _ in range(SEARCH_MINUTES):
        if matches(cron, cursor.astimezone(zone)):
            return cursor
        cursor += timedelta(minutes=1)
    return None


def slot_key(tick: datetime, zone: ZoneInfo) -> str:
    local = tick.astimezone(zone)
    return f"{local:%Y-%m-%d}-{'am' if local.hour < 12 else 'pm'}"


def when(value: str | None) -> datetime | None:
    return datetime.fromisoformat(value.replace("Z", "+00:00")) if value else None


def iso(value: datetime | None) -> str | None:
    return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z") if value else None


def resolve(issue: dict, routine: dict, runs: list[dict], resets: list[str], grace_minutes: float) -> dict:
    """Pure part: the execution issue, its routine (with triggers), the routine's runs and the trigger reset times."""
    if issue.get("originKind") != "routine_execution" or issue.get("originId") != routine.get("id"):
        raise Unresolved("the issue is not an execution of this routine")
    run = next((r for r in runs if r.get("id") == issue.get("originRunId")), None)
    if run is None:
        raise Unresolved(f"run {issue.get('originRunId')} is not among the routine's latest runs")
    trigger = next((t for t in routine.get("triggers", []) if t.get("id") == run.get("triggerId")), None)
    if run.get("source") != "schedule" or trigger is None or trigger.get("kind") != "schedule":
        raise Unresolved("the run was not dispatched by a schedule trigger of this routine")
    cron, zone = parse_cron(trigger["cronExpression"]), ZoneInfo(trigger["timezone"])
    dispatched = when(run["triggeredAt"])
    # Only the current cron/timezone is readable; after a later edit or restore it may not be the one this run used.
    changed = [r for r in resets if when(r) > dispatched]
    if changed:
        raise Unresolved(f"the trigger was edited or restored at {max(changed)}, after this dispatch")
    earlier = [when(r["triggeredAt"]) for r in runs
               if r.get("triggerId") == trigger["id"] and r.get("id") != run["id"]
               and when(r["triggeredAt"]) < dispatched]
    bases = [b for b in (max(earlier, default=None), when(trigger.get("createdAt")),
                         *(when(r) for r in resets)) if b is not None and b < dispatched]
    if not bases:
        raise Unresolved("no previous run, edit or creation time before this dispatch")
    base = max(bases)
    covered: list[datetime] = []
    tick = next_tick(cron, zone, base)
    while tick is not None and tick <= dispatched:
        covered.append(tick)
        tick = next_tick(cron, zone, tick)
    if not covered:
        raise Unresolved(f"no {trigger['cronExpression']} tick between {iso(base)} and the dispatch")
    current = covered[-1]
    late = (dispatched - current).total_seconds() / 60
    on_time = late <= grace_minutes
    missed = covered[:-1] if on_time else covered
    return {
        "routineId": routine["id"],
        "runId": run["id"],
        "trigger": {"id": trigger["id"], "label": trigger.get("label"), "cronExpression": trigger["cronExpression"],
                    "timezone": trigger["timezone"]},
        "basis": iso(base),
        "dispatchedAt": iso(dispatched),
        "nominalTick": iso(covered[0]),
        "coveredTicks": [iso(t) for t in covered],
        "currentTick": iso(current),
        "lateMinutes": round(late, 2),
        "graceMinutes": grace_minutes,
        "onTime": on_time,
        "slotKey": slot_key(current, zone) if on_time else None,
        "missedSlots": [{"tick": iso(t), "slotKey": slot_key(t, zone)} for t in missed],
    }


def get(base: str, key: str, path: str):
    req = urllib.request.Request(base + path, headers={"Authorization": f"Bearer {key}"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)


def items(payload) -> list[dict]:
    if isinstance(payload, list):
        return payload
    for name in ("items", "runs", "activity"):
        if isinstance(payload.get(name), list):
            return payload[name]
    return []


def fetch(issue_id: str) -> tuple[dict, dict, list[dict], list[str]]:
    base = os.environ["PAPERCLIP_API_URL"].rstrip("/").removesuffix("/api") + "/api"
    key = os.environ["PAPERCLIP_API_KEY"]
    issue = get(base, key, f"/issues/{issue_id}")
    if issue.get("originKind") != "routine_execution" or not issue.get("originId"):
        raise Unresolved("the issue is not a routine execution")
    routine_id, company = issue["originId"], issue["companyId"]
    routine = get(base, key, f"/routines/{routine_id}")
    runs = items(get(base, key, f"/routines/{routine_id}/runs?limit=200"))
    activity = items(get(base, key, f"/companies/{company}/activity?entityType=routine&entityId={routine_id}&limit=200"))
    for trigger in routine.get("triggers", []):
        activity += items(get(base, key, f"/companies/{company}/activity?entityType=routine_trigger"
                                         f"&entityId={trigger['id']}&limit=200"))
    run = next((r for r in runs if r.get("id") == issue.get("originRunId")), {})
    resets = [a["createdAt"] for a in activity if a.get("action") in RESET_ACTIONS
              and (a.get("action") == "routine.revision_restored" or a.get("entityId") == run.get("triggerId"))]
    return issue, routine, runs, resets


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--issue", default=os.environ.get("PAPERCLIP_TASK_ID"), help="routine execution issue id")
    ap.add_argument("--grace-minutes", type=float, default=30.0, help="latest acceptable dispatch after the tick")
    args = ap.parse_args(argv)
    if not args.issue:
        ap.error("--issue is required when PAPERCLIP_TASK_ID is not set")
    try:
        print(json.dumps(resolve(*fetch(args.issue), args.grace_minutes), indent=2))
    except (Unresolved, ValueError, KeyError) as err:
        print(f"slot: unresolved: {err}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
