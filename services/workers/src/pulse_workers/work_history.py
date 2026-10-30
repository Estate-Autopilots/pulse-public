"""Load one person's work history, open tasks, work terms, KPIs and protected documents from a private JSON file (RT1).

uv run --all-packages python -m pulse_workers.work_history --file ~/ea-research/private/rt1/savuzo.json [--dry-run]

Idempotent: every row carries a source key, so a re-run updates titles and dates and never duplicates; a field someone
changed in Pulse (status, owner, project, due date) is kept. Nobody is notified: the import runs without a viewer, and the
task notification producers ignore that. Compensation goes only to the protected salary area and documents only to
protected person files; stdout carries counts, never amounts or document text. Time from the history arrives as
*proposed* entries for the person to confirm; documents they worked on in Drive propose time the same way.
"""

# ruff: noqa: E501
from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
import uuid
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path

from psycopg.types.json import Jsonb

from pulse_sdk.db import active_orgs, connect, tenant_tx

IST = timezone(timedelta(hours=5, minutes=30))
STATUSES = {"open", "in_progress", "blocked", "done", "accepted", "cancelled"}
MIME = {".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg"}


def at_ist(day: str | None, hour: int = 18) -> datetime | None:
    return datetime.combine(date.fromisoformat(day), time(hour), IST) if day else None


def person_id(c, ref) -> uuid.UUID:
    """A person by work e-mail (their Workspace account) or by exact display name; ambiguity is an error."""
    if isinstance(ref, str):
        ref = {"email": ref} if "@" in ref else {"name": ref}
    if ref.get("email"):
        row = c.execute(
            "select holder_person_id id from pulse.account where provider='google' and lower(handle)=lower(%s) and holder_person_id is not null",
            (ref["email"],),
        ).fetchone()
        if row:
            return row["id"]
    rows = c.execute(
        "select id from pulse.person where side='staff' and status='active' and lower(display_name)=lower(%s)", (ref.get("name") or "",)
    ).fetchall()
    if len(rows) != 1:
        raise SystemExit(f"person reference not resolved uniquely: {sorted(ref)}")
    return rows[0]["id"]


def internal_client(c, org, name: str) -> uuid.UUID:
    row = c.execute("select id from pulse.client where client_type='internal' and display_name=%s", (name,)).fetchone()
    if row:
        return row["id"]
    return c.execute(
        "insert into pulse.client(org_id,display_name,client_type,status,notes) values(%s,%s,'internal','active','Estate Autopilots internal work (RT1)') returning id",
        (org, name),
    ).fetchone()["id"]


def project(c, org, name: str, client: uuid.UUID | None, requires_proof: bool) -> uuid.UUID:
    row = c.execute(
        "select id from pulse.project where coalesce(title,name)=%s and client_id is not distinct from %s::uuid order by registry_no limit 1", (name, client)
    ).fetchone()
    if row:
        c.execute("update pulse.project set requires_proof=%s where id=%s", (requires_proof, row["id"]))
        return row["id"]
    c.execute("select pg_advisory_xact_lock(hashtext('project-register:'||%s))", (str(org),))
    registry = c.execute("select coalesce(max(registry_no),0)+1 n from pulse.project").fetchone()["n"]
    return c.execute(
        """insert into pulse.project(org_id,registry_no,name,title,client_id,status,requires_proof,locked)
           values(%s,%s,%s,%s,%s,'active',%s,'{title,client_id}') returning id""",
        (org, registry, name, name, client, requires_proof),
    ).fetchone()["id"]


def stored_file(c, org, person: uuid.UUID, doc: dict, base: Path) -> uuid.UUID:
    path = Path(doc["path"]).expanduser()
    if not path.is_absolute():
        path = base / path
    data = path.read_bytes()
    mime = MIME.get(path.suffix.lower())
    if not mime or len(data) > 8 * 1024 * 1024:
        raise SystemExit(f"document {doc['key']}: only PDF/PNG/JPEG up to 8 MB")
    row = c.execute(
        """insert into pulse_priv.hr_file(org_id,person_id,doc_kind,title,name,mime,bytes,sha256,source_key)
           values(%s,%s,%s,%s,%s,%s,%s,%s,%s)
           on conflict(org_id,source_key) do update set title=excluded.title,doc_kind=excluded.doc_kind
           returning id""",
        (org, person, doc["kind"], doc["title"], path.name, mime, data, hashlib.sha256(data).hexdigest(), "rt1:doc:" + doc["key"]),
    ).fetchone()
    return row["id"]


def weeks_between(start: date, end: date):
    """The days a span's time is booked on: the end day of each week it touches (Friday, or the span's last day)."""
    days, d = [], start
    while d <= end:
        friday = d + timedelta(days=(4 - d.weekday()) % 7)
        days.append(min(friday, end))
        d = friday + timedelta(days=3)
    return sorted(set(days))


def load(c, org, data: dict, base: Path) -> dict:
    n = {"projects": 0, "tasks": 0, "links": 0, "proof": 0, "time": 0, "kpis": 0, "documents": 0, "compensation": 0, "terms": 0}
    me = person_id(c, data["person"])
    people = {k: person_id(c, v) for k, v in (data.get("people") or {}).items()}
    people.setdefault("me", me)

    def who(ref):
        if ref is None:
            return None
        return people[ref] if ref in people else person_id(c, ref)

    terms = data.get("terms")
    if terms:
        c.execute(
            """insert into pulse.person_work_terms(org_id,person_id,work_mode,role_title,role_status,weekly_hours_min,weekly_hours_max,office_days_min,office_days_max,other_roles,note,updated_at)
               values(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,now())
               on conflict(person_id) do update set work_mode=excluded.work_mode,role_title=excluded.role_title,role_status=excluded.role_status,
               weekly_hours_min=excluded.weekly_hours_min,weekly_hours_max=excluded.weekly_hours_max,office_days_min=excluded.office_days_min,
               office_days_max=excluded.office_days_max,other_roles=excluded.other_roles,note=excluded.note,updated_at=now()""",
            (org, me, terms["workMode"], terms.get("roleTitle"), terms.get("roleStatus"), terms.get("weeklyHoursMin"), terms.get("weeklyHoursMax"),
             terms.get("officeDaysMin"), terms.get("officeDaysMax"), terms.get("otherRoles") or [], terms.get("note")),
        )
        if terms.get("profileRole"):
            c.execute(
                """update pulse.people_profile set role=%s,locked=array(select distinct unnest(locked||'{role}'::text[])),
                   field_sources=field_sources||jsonb_build_object('role',jsonb_build_object('source','Role terms','detail',%s::text)),updated_at=now() where person_id=%s""",
                (terms["profileRole"], terms.get("profileRoleSource") or "RT1", me),
            )
        n["terms"] = 1
    files = {}
    for doc in data.get("documents") or []:
        files[doc["key"]] = stored_file(c, org, me, doc, base)
        n["documents"] += 1
    for pay in data.get("compensation") or []:
        c.execute(
            """insert into pulse_priv.hr_compensation(org_id,person_id,effective_month,kind,amount,currency,source_file_id,source_name,source_sheet,basis,effective_from,terms_status,terms_note)
               values(%s,%s,%s,%s,%s,'INR',%s,%s,%s,%s,%s,%s,%s)
               on conflict(person_id,kind,effective_month,source_file_id,source_sheet) do update set amount=excluded.amount,basis=excluded.basis,
               terms_status=excluded.terms_status,terms_note=excluded.terms_note,effective_from=excluded.effective_from""",
            (org, me, pay["month"], pay["kind"], pay["amount"], pay["sourceKey"], pay["sourceName"], pay["sourceSheet"], pay["basis"], pay["month"], pay["status"], pay.get("note")),
        )
        n["compensation"] += 1
    for i, k in enumerate(data.get("kpis") or []):
        c.execute(
            """insert into pulse.kpi(org_id,person_id,area,title,target,measure,due_on,progress,status,latest_note,source,source_key,position)
               values(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
               on conflict(org_id,source_key) do update set area=excluded.area,title=excluded.title,target=excluded.target,measure=excluded.measure,
               due_on=excluded.due_on,source=excluded.source,position=excluded.position""",
            (org, me, k.get("area"), k["title"], k.get("target"), k.get("measure"), k.get("due"), k.get("progress"), k.get("status", "not_started"),
             k.get("note"), k["source"], "rt1:kpi:" + k["key"], i),
        )
        n["kpis"] += 1
    client = internal_client(c, org, data["client"]) if data.get("client") else None
    projects = {}
    for p in data.get("projects") or []:
        projects[p["key"]] = project(c, org, p["name"], client, bool(p.get("requiresProof")))
        n["projects"] += 1
    tasks = {}
    for t in data.get("tasks") or []:
        if t.get("status", "open") not in STATUSES:
            raise SystemExit(f"task {t['key']}: unknown status")
        assignee, reviewer = who(t.get("assignee", "me")), who(t.get("reviewer"))
        status = t.get("status", "open")
        started, done = at_ist(t.get("start"), 10), at_ist(t.get("done"))
        key = "rt1:task:" + t["key"]
        row = c.execute(
            """insert into pulse.task(org_id,source_key,title,status,project_id,parent_id,owner_id,assignee_person_id,review_owner_id,due_at,priority,notes,value_note,
               source,created_by,created_at,started_at,done_at,work_on,deliverable_type,evidence,updated_at,assigned_at)
               values(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'pulse',%s,%s,%s,%s,%s,%s,%s,now(),%s)
               on conflict(org_id,source_key) do update set
                 title=case when 'title'=any(task.locked) then task.title else excluded.title end,
                 status=case when 'status'=any(task.locked) then task.status else excluded.status end,
                 project_id=case when 'project_id'=any(task.locked) then task.project_id else excluded.project_id end,
                 owner_id=case when 'owner_id'=any(task.locked) then task.owner_id else excluded.owner_id end,
                 assignee_person_id=case when 'owner_id'=any(task.locked) then task.assignee_person_id else excluded.assignee_person_id end,
                 due_at=case when 'due_label'=any(task.locked) then task.due_at else excluded.due_at end,
                 parent_id=excluded.parent_id,review_owner_id=coalesce(task.review_owner_id,excluded.review_owner_id),priority=excluded.priority,notes=excluded.notes,
                 value_note=coalesce(task.value_note,excluded.value_note),started_at=excluded.started_at,
                 done_at=case when 'status'=any(task.locked) then task.done_at else excluded.done_at end,work_on=excluded.work_on,
                 deliverable_type=excluded.deliverable_type,evidence=excluded.evidence
               returning id""",
            (org, key, t["title"], status, projects.get(t.get("project")), tasks.get(t.get("parent")), assignee, assignee, reviewer, at_ist(t.get("due")),
             t.get("priority", "normal"), t.get("notes"), t.get("value"), people["me"], started or datetime.now(IST), started, done if status in ("done", "accepted") else None,
             t.get("done") or t.get("start"), t.get("type"), Jsonb({"source": "RT1 history import", "basis": t.get("basis", ""), "via": t.get("via")}),
             started or datetime.now(IST)),
        ).fetchone()
        tasks[t["key"]] = row["id"]
        n["tasks"] += 1
        for j, pr in enumerate(t.get("proof") or []):
            pkey = f"rt1:proof:{t['key']}:{j}"
            if pr.get("doc"):
                c.execute(
                    """insert into pulse.task_proof(org_id,task_id,kind,label,hr_file_id,source_key) values(%s,%s,'document',%s,%s,%s)
                       on conflict(org_id,source_key) where source_key is not null do update set label=excluded.label""",
                    (org, row["id"], pr["label"], files[pr["doc"]], pkey),
                )
            else:
                c.execute(
                    """insert into pulse.task_proof(org_id,task_id,kind,label,url,source_key) values(%s,%s,'link',%s,%s,%s)
                       on conflict(org_id,source_key) where source_key is not null do update set label=excluded.label,url=excluded.url""",
                    (org, row["id"], pr["label"], pr["url"], pkey),
                )
            n["proof"] += 1
        hours = float(t.get("hours") or 0)
        if hours and (t.get("start") or t.get("done")):
            days = weeks_between(date.fromisoformat(t.get("start") or t["done"]), date.fromisoformat(t.get("done") or t["start"]))
            total, share = round(hours * 60), math.floor(round(hours * 60) / len(days))
            for k, day in enumerate(days):
                minutes = share if k < len(days) - 1 else total - share * (len(days) - 1)
                if minutes > 0 and c.execute(
                    "select pulse.time_propose(%s,%s,%s,'estimate',%s,%s,%s) id",
                    (assignee, day, minutes, f"{key}:time:{day}", "Estimate from the history import" + (f" ({t['via']})" if t.get("via") else ""), row["id"]),
                ).fetchone()["id"]:
                    n["time"] += 1
    for t in data.get("tasks") or []:
        for b in t.get("blockedBy") or []:
            c.execute(
                """insert into pulse.task_link(org_id,task_id,blocker_id,note) values(%s,%s,%s,%s)
                   on conflict(org_id,task_id,blocker_id) where cleared_at is null do nothing""",
                (org, tasks[t["key"]], tasks[b], t.get("blockedNote")),
            )
            n["links"] += 1
        if t.get("blockedBy") and t.get("status", "open") in ("open", "in_progress"):
            c.execute("update pulse.task set status='blocked' where id=%s and pulse.task_open_blockers(id)>0 and not 'status'=any(locked)", (tasks[t["key"]],))
    return n


def propose_from_documents(c, org, person: uuid.UUID, since: date) -> int:
    """Drive actions the person made themselves (an individual account, never a shared login) propose working time:
    ten minutes an action, at most four hours a day, for the person to confirm or dismiss."""
    made = 0
    for r in c.execute(
        """select (at at time zone 'Asia/Kolkata')::date d,count(*)::int n from pulse.activity_observation
           where actor_id=%s and actor_kind is distinct from 'shared_account' and at>=%s and operation in ('upload','create','created','edit','edited')
           group by 1 order by 1""",
        (person, since),
    ).fetchall():
        if c.execute(
            "select pulse.time_propose(%s,%s,%s,'document',%s,%s) id",
            (person, r["d"], min(240, 10 * r["n"]), f"activity:{person}:{r['d']}", f"{r['n']} file actions in Drive"),
        ).fetchone()["id"]:
            made += 1
    return made


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--file", required=True)
    ap.add_argument("--dry-run", action="store_true", help="load inside a transaction, print counts, then roll back")
    a = ap.parse_args(argv)
    path = Path(a.file).expanduser()
    data = json.loads(path.read_text())
    counts = []
    with connect("worker") as c:
        orgs = active_orgs(c)
        if len(orgs) != 1:
            raise SystemExit("exactly one active organisation expected")
        with tenant_tx(c, orgs[0]):
            n = load(c, orgs[0], data, path.parent)
            n["documentTime"] = propose_from_documents(c, orgs[0], person_id(c, data["person"]), date.fromisoformat(data.get("timeSince", "2026-09-01")))
            counts.append(n)
            if a.dry_run:
                raise _Rollback(n)
    print(json.dumps({"dryRun": False, "counts": counts}))


class _Rollback(Exception):
    def __init__(self, counts):
        super().__init__("dry run")
        self.counts = counts


if __name__ == "__main__":
    try:
        main()
    except _Rollback as r:
        print(json.dumps({"dryRun": True, "counts": [r.counts]}))
        sys.exit(0)
