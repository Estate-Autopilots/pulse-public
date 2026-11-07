"""Load the approved enrichment package. Counts only on stdout; confidential rows never enter diagnostics.

uv run --all-packages python -m pulse_workers.company_seed --dir ~/ea-research/data/enrich
Idempotent source IDs and hashes retain provenance. Manual locks, rejected suggestions and merges win on replay.
"""

# ruff: noqa: E501
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
import sys
import uuid
from collections import defaultdict
from datetime import date
from pathlib import Path

from psycopg.types.json import Jsonb

from pulse_sdk.db import active_orgs, connect, tenant_tx
from pulse_sdk.ids import entity_id
from pulse_workers.tools_import import seed_money_observation

PRIVATE = {"subscriptions", "recurring"}
TYPES = {
    "channel partner": "channel_partner",
    "developer": "developer",
    "model-talent": "talent",
    "vendor": "vendor",
    "other": "other",
}



# Tracker cells use the team's own words. Explicit states map to a task status; a blank or unrecognised cell stays
# "unknown" rather than being guessed. ("creative finalised", "Edit Completed" and "Vid Finalised" mean the work is done.)
_TASK_WORDS = {
    "completed": "done", "complete": "done", "done": "done", "finished": "done", "creative finalised": "done",
    "creative finalized": "done", "edit completed": "done", "vid finalised": "done", "video finalised": "done",
    "in progress": "in_progress", "in process": "in_progress", "edit in process": "in_progress", "edit in progress": "in_progress",
    "pending": "open", "edit pending": "open", "incomplete": "open", "open": "open",
    "blocked": "blocked", "cancelled": "cancelled", "canceled": "cancelled",
}


def task_status(source_status: str) -> str:
    return _TASK_WORDS.get(" ".join(source_status.lower().split()), "unknown")

def norm(value):
    return re.sub(r"\s+", " ", re.sub(r"^(mr\.?|mrs\.?|ms\.?|miss|dr\.?)\s+", "", str(value or "").lower())).strip(" .")


def number(value):
    try:
        return float(value) if value != "" and value is not None else None
    except (ValueError, TypeError):
        return None


def month(value):
    try:
        return date.fromisoformat(str(value)[:7] + "-01")
    except ValueError:
        return None


def evidence_map(path):
    if not path.exists():
        return {}
    data = json.loads(path.read_text())
    if isinstance(data, dict) and isinstance(data.get("rows"), (dict, list)):
        data = data["rows"]
    if isinstance(data, dict):
        return data
    return {str(r.get("id", r.get("evidence_id", ""))): r for r in data if isinstance(r, dict)}


def review(c, org, key, kind, title, proposed, confidence, evidence, entity=None, eid=None):
    c.execute(
        """insert into pulse.review_item(org_id,source_key,kind,entity_type,entity_id,title,proposed,confidence,evidence)
      values(%s,%s,%s,%s,%s,%s,%s,%s,%s) on conflict(org_id,source_key) do update
      set proposed=excluded.proposed,confidence=excluded.confidence,evidence=excluded.evidence where review_item.status='pending' """,
        (org, key, kind, entity, eid, title, Jsonb(proposed), confidence, Jsonb(evidence)),
    )


def load(c, org, directory: Path):
    people = defaultdict(list)
    for r in c.execute("select id,display_name from pulse.person where side='staff' and status<>'offboarded'"):
        people[norm(r["display_name"])].append(r["id"])

    def person(name):
        ids = people.get(norm(name), [])
        return ids[0] if len(ids) == 1 else None

    projects = defaultdict(list)
    folders = {}
    for r in c.execute(
        "select p.id,p.project_key,m.folder_id from pulse.project p left join pulse.project_location_member m on m.project_id=p.id"
    ):
        if r["id"] not in projects[norm(r["project_key"])]:
            projects[norm(r["project_key"])].append(r["id"])
        if r["folder_id"]:
            folders[r["folder_id"]] = r["id"]

    def project(key, folder=None):
        if folder in folders:
            return folders[folder]
        if not norm(key):
            return None
        ids = projects.get(norm(key), [])
        return ids[0] if len(ids) == 1 else None

    contacts = defaultdict(list)
    for r in c.execute(
        "select p.id,p.display_name from pulse.contact_profile cp join pulse.person p on p.id=cp.person_id"
    ):
        contacts[norm(r["display_name"])].append(r["id"])
    # Baseline client keys already resolve spelling aliases; don't invent another contact for those keys.
    client_keys = {
        r["source_key"].removeprefix("c:"): r["entity_id"]
        for r in c.execute(
            "select source_key,entity_id from pulse.identity_link where source='drive_folder_name' and entity_type='client' and source_key like 'c:%%'"
        )
    }
    client_contacts = defaultdict(list)
    for r in c.execute("select client_id,person_id from pulse.client_contact"):
        client_contacts[r["client_id"]].append(r["person_id"])

    counts = {}
    for path in sorted(directory.glob("*.csv")):
        dataset = path.stem
        raw = path.read_bytes()
        rows = list(csv.DictReader(raw.decode("utf-8-sig").splitlines()))
        ev = evidence_map(path.with_suffix(".evidence.json"))
        batch = c.execute(
            """insert into pulse.import_batch(org_id,dataset,sha256,row_count) values(%s,%s,%s,%s)
          on conflict(org_id,dataset,sha256) do update set row_count=excluded.row_count returning id""",
            (org, dataset, hashlib.sha256(raw).hexdigest(), len(rows)),
        ).fetchone()["id"]
        private = dataset.startswith("money_") or dataset in PRIVATE
        table = "pulse_priv.money_observation" if private else "pulse.source_observation"
        if dataset in PRIVATE:
            for r in rows:
                seed_money_observation(c, org, dataset, r, ev.get(r.get("evidence_id", r["id"]), {}), batch)
            counts[dataset] = len(rows)
            continue
        with c.cursor() as cur:
            cur.executemany(
                f"""insert into {table}(org_id,dataset,source_key,payload,evidence,import_id) values(%s,%s,%s,%s,%s,%s)
             on conflict(org_id,dataset,source_key) do update set payload=excluded.payload,evidence=excluded.evidence,import_id=excluded.import_id""",
                [
                    (org, dataset, r["id"], Jsonb(r), Jsonb(ev.get(r.get("evidence_id", r["id"]), {})), batch)
                    for r in rows
                ],
            )  # noqa: S608
        counts[dataset] = len(rows)
        if private:
            continue
        for r in rows:
            evidence = ev.get(r.get("evidence_id", r["id"]), {})
            score = number(r.get("confidence"))
            if dataset == "contacts_typed":
                key = r["contact_key"]
                ids = contacts.get(norm(r["name"]), [])
                cid = client_keys.get(key)
                if not ids and cid and len(client_contacts[cid]) == 1:
                    ids = client_contacts[cid]
                link = c.execute(
                    "select entity_id from pulse.identity_link where source='enrich_contact' and source_key=%s and entity_type='person'",
                    (key,),
                ).fetchone()
                pid = (
                    link["entity_id"]
                    if link
                    else ids[0]
                    if len(ids) == 1
                    else entity_id(org, "person", "enrich_contact", key)
                )
                if not link:
                    c.execute(
                        "insert into pulse.person(id,org_id,display_name,side) values(%s,%s,%s,'other') on conflict(id) do nothing",
                        (pid, org, r["name"]),
                    )
                    c.execute(
                        "insert into pulse.identity_link(org_id,entity_type,entity_id,source,source_key,raw_value,method,confidence) values(%s,'person',%s,'enrich_contact',%s,%s,'evidence',%s) on conflict do nothing",
                        (org, pid, key, r["name"], score),
                    )
                typ = TYPES.get(r["type"], "other")
                c.execute(
                    """insert into pulse.contact_profile(org_id,person_id,contact_type,source,confidence,type_status)
                 values(%s,%s,%s,'enrichment',%s,%s) on conflict(person_id) do update set
                 contact_type=case when 'contact_type'=any(contact_profile.locked) then contact_profile.contact_type else excluded.contact_type end,
                 source='enrichment',confidence=case when 'contact_type'=any(contact_profile.locked) then 1 else excluded.confidence end,type_status=case when 'contact_type'=any(contact_profile.locked) then 'confirmed' else excluded.type_status end""",
                    (org, pid, typ, score, r["status"]),
                )
                if (
                    cid
                    and typ in ("developer", "channel_partner")
                    and score
                    and score >= 0.9
                    and r["status"] == "evidence_typed"
                ):
                    c.execute(
                        "update pulse.client set client_type=%s,type_basis='source' where id=%s and not 'client_type'=any(locked)",
                        (typ, cid),
                    )
                if r["status"] != "evidence_typed" or not score or score < 0.85:
                    review(
                        c,
                        org,
                        f"contact:{key}",
                        "contact_type",
                        r["name"] + ": confirm contact type",
                        {"contactType": typ},
                        score,
                        evidence,
                        "contact",
                        pid,
                    )
            elif dataset == "people":
                pid = person(r["name"])
                if pid:
                    c.execute(
                        "update pulse.people_profile set role=case when 'role'=any(locked) then role else %s end where person_id=%s",
                        (r["role"], pid),
                    )
                else:
                    review(
                        c,
                        org,
                        "person:" + r["id"],
                        "identity",
                        r["name"] + ": match HR identity",
                        {"name": r["name"], "role": r["role"]},
                        score,
                        evidence,
                    )
            elif dataset == "tasks":
                owner = person(r["owner"])
                source_status = r["status"]
                status = task_status(source_status)
                c.execute(
                    """insert into pulse.task(org_id,source_key,title,status,source_status,owner_id,assignee_person_id,owner_label,owner_role,project_id,project_key,due_label,source_period,confidence,evidence,source)
                 values(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'imported') on conflict(org_id,source_key) do update set
                 title=case when 'title'=any(task.locked) then task.title else excluded.title end,
                 status=case when 'status'=any(task.locked) then task.status else excluded.status end,
                 owner_id=case when 'owner_id'=any(task.locked) then task.owner_id else excluded.owner_id end,
                 assignee_person_id=case when 'owner_id'=any(task.locked) then task.assignee_person_id else excluded.assignee_person_id end,
                 due_label=case when 'due_label'=any(task.locked) then task.due_label else excluded.due_label end,
                 project_id=case when 'project_id'=any(task.locked) then task.project_id else excluded.project_id end,
                 evidence=excluded.evidence,source_status=excluded.source_status""",
                    (
                        org,
                        r["id"],
                        r["task"] or "Unnamed source task",
                        status,
                        source_status,
                        owner,
                        owner,
                        r["owner"],
                        r["owner_role"],
                        project(r["project_key"]),
                        r["project_key"],
                        r["due_date"],
                        r["source_period"],
                        score,
                        Jsonb(evidence),
                    ),
                )
            elif dataset == "project_pods":
                for pid in projects.get(norm(r["project_key"]), []):
                    proposed = {
                        "pod": r["pod"] or None,
                        "pgsCandidate": r["pgs_candidate"] or None,
                        "pgsId": str(person(r["pgs_candidate"])) if person(r["pgs_candidate"]) else None,
                        "pgsBasis": r["pgs_basis"],
                        "roleGaps": r["role_gaps"],
                    }
                    review(
                        c,
                        org,
                        "pod:" + str(pid),
                        "project_pod",
                        (r["project"] or r["project_key"]) + ": pod / PGS",
                        proposed,
                        score,
                        evidence,
                        "project",
                        pid,
                    )
            elif dataset == "uploader_actors":
                kind = r["actor_kind"]
                # A personal name may be inferred through an individual account; retain that qualifier.
                pid = (
                    person(r["actor_person"])
                    if kind != "shared_account"
                    and r["actor_person"]
                    and number(r["person_confidence"])
                    and number(r["person_confidence"]) >= 0.8
                    else None
                )
                c.execute(
                    """insert into pulse.activity_observation(org_id,source_key,at,operation,file_id,project_id,project_key,actor_account,actor_id,actor_label,actor_kind,human_attribution,confidence,basis,evidence)
                 values(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) on conflict(org_id,source_key) do update set actor_id=excluded.actor_id,evidence=excluded.evidence""",
                    (
                        org,
                        r["id"],
                        r["timestamp"] or None,
                        r["operation"],
                        r["file_id"],
                        project(r["project_key"], r["engagement"]),
                        r["project_key"],
                        r["actor_account"],
                        pid,
                        r["actor_person"],
                        kind,
                        r["human_attribution"],
                        score,
                        r["attribution_basis"],
                        Jsonb(evidence),
                    ),
                )
            elif dataset == "hr_leave_wfh":
                c.execute(
                    """insert into pulse.hr_month_history(org_id,source_key,person_id,person_label,month_label,month,leave_days,wfh_days,half_days,attendance_dates,confidence,basis,evidence)
                  values(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) on conflict(org_id,source_key) do update set evidence=excluded.evidence""",
                    (
                        org,
                        r["id"],
                        person(r["person"]),
                        r["person"],
                        r["period_label"],
                        month(r["month"]),
                        number(r["leave_days"]),
                        number(r["wfh_days"]),
                        number(r["half_days"]),
                        r["attendance_dates"],
                        score,
                        r["basis"],
                        Jsonb(evidence),
                    ),
                )
    # Reporting lines are suggestions. A unique strategist is a candidate, never an asserted pod-head title.
    staff = c.execute("""select pp.person_id,pp.pod,pp.role,pp.manager_id,p.display_name from pulse.people_profile pp
      join pulse.person p on p.id=pp.person_id where p.side='staff' and p.status='active'""").fetchall()
    leadership = [p for p in staff if "ceo" in norm(p["role"])]
    strategists = defaultdict(list)
    for p in staff:
        if "creative strategist" in norm(p["role"]):
            strategists[p["pod"]].append(p)
    for p in staff:
        if p["manager_id"] or not p["pod"] or p["pod"] == "Leadership":
            continue
        head = c.execute(
            "select head_person_id from pulse.unit where kind='pod' and name=%s and head_person_id is not null",
            (p["pod"],),
        ).fetchone()
        candidate = head["head_person_id"] if head else None
        basis = "Named pod head → leadership; HR confirmation required"
        score = 0.65
        if (
            not candidate
            and len(strategists[p["pod"]]) == 1
            and strategists[p["pod"]][0]["person_id"] != p["person_id"]
        ):
            candidate = strategists[p["pod"]][0]["person_id"]
            basis = "PGS → candidate pod lead (unique creative strategist in this pod). No explicit pod-head title; HR must confirm."
            score = 0.55
        if (
            not candidate
            and len(leadership) == 1
            and ("creative strategist" in norm(p["role"]) or p["pod"] == "Shared")
        ):
            candidate = leadership[0]["person_id"]
            basis = "Candidate pod lead / shared operations → leadership (unique CEO register role); HR must confirm."
            score = 0.45
        if candidate and candidate != p["person_id"]:
            review(
                c,
                org,
                "manager:" + str(p["person_id"]),
                "manager",
                p["display_name"] + ": suggested reporting line",
                {"managerId": str(candidate), "basis": basis},
                score,
                {"source": "people.csv + confirmed people/pod register", "inferred": True},
                "person",
                p["person_id"],
            )
    # Name-only collisions remain unresolved identity warnings, never merge candidates.
    for table, name, entity in [
        ("pulse.client", "display_name", "client"),
        ("pulse.person", "display_name", "contact"),
        ("pulse.project", "title", "project"),
    ]:
        seen = defaultdict(list)
        for r in c.execute(f"select id,{name} name from {table}"):  # noqa: S608
            if r["name"]:
                seen[norm(r["name"])].append(r)
        for key, items in seen.items():
            if len(items) == 2:
                review(
                    c,
                    org,
                    f"duplicate:{entity}:{key}",
                    "identity" if entity in ("client", "contact") else "duplicate",
                    items[0]["name"] + ": possible duplicate (review engagements)",
                    {"keepId": str(items[0]["id"]), "goneId": str(items[1]["id"]), "entity": entity},
                    None,
                    {"basis": "Name agreement only; obtain a verified scoped ID or confirmed organisation.", "confidence_kind": "rule"},
                )
    c.execute(
        "insert into pulse.shift(org_id,name,start_time,end_time) values(%s,'Office','10:00','19:00'),(%s,'WFH evening (Drive)','17:00','02:00') on conflict do nothing",
        (org, org),
    )
    for pid in c.execute(
        "select person_id from pulse.role_assignment where role_key='admin' and current_date between valid_from and coalesce(valid_to,'infinity')"
    ):
        for permission in ("money.read", "money.amount.read", "money.plan.write"):
            c.execute(
                "insert into pulse.money_permission(org_id,person_id,permission) values(%s,%s,%s) on conflict do nothing",
                (org, pid["person_id"], permission),
            )
    from .holiday_proposals import propose

    counts["holiday_proposals"] = propose(c, org)
    counts["auto_accepted"] = c.execute("select pulse.review_apply_rules() n").fetchone()["n"]
    return counts


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dir", type=Path, required=True)
    parser.add_argument("--org")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    try:
        with connect("worker") as c:
            orgs = [uuid.UUID(args.org)] if args.org else active_orgs(c)
            for org in orgs:
                with tenant_tx(c, org):
                    counts = load(c, org, args.dir)
                    # RT1: tracker rows get the A1 states, "Type — date" titles parsed and the projects they name linked.
                    if c.execute("select to_regprocedure('pulse.task_tracker_normalise()') is not null ready").fetchone()["ready"]:
                        counts["tasks_normalised"] = c.execute("select pulse.task_tracker_normalise() r").fetchone()["r"]
                    if args.dry_run:
                        c.rollback()
                    print(json.dumps({"datasets": counts, "dry_run": args.dry_run}, sort_keys=True))
    except Exception as exc:
        # PostgreSQL diagnostics can include an offending money row. Only the class is safe to print.
        print(
            "Company import failed: "
            + type(exc).__name__
            + " "
            + str(getattr(getattr(exc, "diag", None), "constraint_name", None) or "")
            + "; no source values logged",
            file=sys.stderr,
        )
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
