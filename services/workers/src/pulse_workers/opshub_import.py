"""Ops Hub mapping v1: read-only sources, existing staff only, counts-only output."""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import re
import sys
import uuid
from collections import Counter
from datetime import UTC, date, datetime, time, timedelta
from pathlib import Path
from urllib.request import HTTPRedirectHandler, Request, build_opener
from zoneinfo import ZoneInfo

from psycopg import sql
from psycopg.types.json import Jsonb

from pulse_sdk.db import connect, set_tenant
from pulse_sdk.ids import entity_id

PGS = "Project Growth Strategist"
ALWAYS = [("Buyer & Sales Operating System (CRM)", 1, 10),
          ("Project Sales Intelligence (Dashboard)", 1, 10), ("AI Sales Enablement (Training)", 20, 40)]
RENAMES = [
    ("Research, personas & positioning", "Project Blueprint™ - research, personas, positioning"),
    ("Brand alignment check", "Brand Alignment™"), ("Social media optimization", "Social Media Optimization™"),
    ("Sales alignment brief & meeting", "Sales Alignment Session™"),
    ("Pod briefing", "Project Blueprint™ handoff (pod briefing)"),
    (r"Image ad set #(\d+) content", r"Single Image Curiosity Ads™ #\1 - content"),
    (r"Image ad set #(\d+) designed \(4 ads\)", r"Single Image Curiosity Ads™ #\1 - designed (4 ads)"),
    (r"Model-Led Walkthrough(?! Video)", "Model-Led Walkthrough Video"),
    (r"Model-Led #(\d+) shoot completed \(model-led \+ B-roll\)",
     r"Model-Led Video Ads #\1 - shoot completed (+ B-roll)"),
    (r"Model-Led #(\d+) shoot day scheduled", r"Model-Led Video Ads #\1 - shoot scheduled"),
    (r"Model-Led #(\d+) script", r"Model-Led Video Ads #\1 - script"),
    (r"Model-Led #(\d+) edited \(5 versions\)", r"Model-Led Video Ads #\1 - edited (5 versions)"),
    (r"VOV #(\d+) script", r"High-Conversion VOV Ads #\1 - script"),
    (r"VOV #(\d+) edited", r"High-Conversion VOV Ads #\1 - edited"),
    ("Founder Authority Video", "Founder Video"), ("Client Testimonials", "Client Video Testimonials"),
    ("Creative Remix & Hybrid Ads produced", "Creative Remix™ - produced"),
    ("Creative Remix & Hybrid - by CS", "Creative Remix™ - by CS"),
    ("Landing page built", "Premium Landing Page™ built"), ("Meta Ads Management", "Buyer Acquisition - Meta"),
    ("Google Ads Management", "Buyer Acquisition - Google"), ("YouTube Ads Management", "Buyer Acquisition - YouTube"),
    ("Sales Hiring Funnel System", "Sales Enablement - hiring funnel"),
    ("Sales Script, Mindset & Objection Handling", "Sales Enablement - scripts & objection handling"),
    ("Weekly KPI & Review System", "Sales Intelligence - weekly KPI & review"),
    ("Conversion Tracking System", "Sales Visibility - conversion tracking"),
    ("Automated Lead Nurturing System", "Buyer Nurturing - WhatsApp & email journey"),
    ("Channel Partner Activation Framework", "Channel Partner Alignment System"),
    (r"^Channel Partner Activation$", "Channel Partner Alignment System"),
    ("Buyer Nurturing - WhatsApp & email journey", "Buyer Nurturing & Site Visit Acceleration"),
    ("Sales Enablement - scripts & objection handling", "AI Sales Enablement (Training)"),
    ("Sales Enablement - hiring funnel", "Sales Hiring Funnel System"),
    ("Sales Visibility - conversion tracking", "Buyer & Sales Operating System (CRM)"),
    ("Sales Intelligence - weekly KPI & review", "Project Sales Intelligence (Dashboard)"),
    (r"Model-Led Video Ads #(\d+) - shoot scheduled", r"Model-Led Video Ads #\1 - shoot completed (+ B-roll)"),
    ("Founder Video - shoot scheduled", "Founder Video - shoot completed"),
    ("Client Video Testimonials - shoot scheduled", "Client Video Testimonials - shoot completed"),
    ("Model-Led Walkthrough Video - shoot scheduled", "Model-Led Walkthrough Video - shoot completed"),
]


def clean(value):
    if isinstance(value, dict):
        return {k: clean(v) for k, v in value.items() if k not in {"pin", "contactNumber"}}
    return [clean(v) for v in value] if isinstance(value, list) else value


def canonize(name):
    for pattern, replacement in RENAMES:
        regex = "\\" in pattern or pattern.startswith("^") or "(?!" in pattern
        name = re.sub(pattern, replacement, name, count=1) if regex else name.replace(pattern, replacement, 1)
    return name


def opshub_view(client, *, today=None):
    """Pure page migration; the caller supplies today's date for reproducible missing-onboarding runs."""
    c = clean(copy.deepcopy(client))
    c["status"] = c.get("status") or "Active"
    if c.get("tier") == "Starter":
        c["tier"] = "Growth"
    if c.get("qty") and "adsMeta" not in c["qty"]:
        c["qty"].update(dict.fromkeys(("adsMeta", "adsGoogle", "adsYouTube"), c["qty"].get("adsDuration") or 3))
    changed, tasks = False, []
    for original in c.get("deliverables", []):
        d = dict(original, name=canonize(original.get("name") or ""))
        if not d.get("targetStart") and d.get("targetEnd"):
            d["targetStart"] = (date.fromisoformat(d["targetEnd"]) - timedelta(days=3)).isoformat()
        if d["name"].startswith(("Buyer Nurturing", "Site Visit Acceleration")):
            d["phase"] = "Phase 3"
        if re.search("shoot completed", d["name"], re.I) and d.get("ownerRole") == "Videographer":
            d["ownerRole"] = "Project Coordinator"
        retired = any(n in d["name"] for n in (
            "Sales Enablement - training framework", "Site Visit Acceleration - follow-up optimization",
            "Project Blueprint™ handoff")) or d["name"] == "Pod briefing"
        if d["name"] in {n for n, _, _ in ALWAYS} | {"Sales Hiring Funnel System", "Channel Partner Alignment System"}:
            d["ownerRole"] = PGS
        changed |= retired or d != original
        if not retired:
            tasks.append(d)
    onboarding = date.fromisoformat(c.get("onboardingDate") or today or date.today().isoformat())
    for name, start, end in ALWAYS:
        if any(d["name"] == name for d in tasks):
            continue
        changed = True
        tasks.append(dict(
            id="d-mig-" + re.sub("[^a-z0-9]", "", name.lower())[:16], name=name, phase="Phase 4", ownerRole=PGS,
            targetStart=(onboarding + timedelta(days=start)).isoformat(),
            targetEnd=(onboarding + timedelta(days=end)).isoformat(), status="not_started", completionDate=None))
    if changed:  # The page only de-duplicates when a migration changed something.
        unique = {}
        for d in tasks:
            if d["name"] not in unique or (d.get("status") == "done" and unique[d["name"]].get("status") != "done"):
                unique[d["name"]] = d
        tasks = list(unique.values())
    c["deliverables"] = tasks
    return c


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError("source redirect refused")


def http_source(url, key, *, method="GET"):
    if method != "GET":
        raise ValueError("source method refused")
    request = Request(url, headers={"apikey": key, "Authorization": "Bearer " + key}, method=method)
    with build_opener(NoRedirect()).open(request, timeout=30) as r:
        return clean(json.load(r))


def read_source(path=None):
    if path:
        with Path(path).open() as f:
            return clean(json.load(f))
    if url := os.environ.get("PULSE_OPSHUB_DATABASE_URL"):
        with connect(url, options="-c default_transaction_read_only=on") as c:
            clients = clean(c.execute("select id,data from public.ea_clients").fetchall())
            team = clean(c.execute("select data from public.ea_team where id='team'").fetchall())
        return {"ea_clients": clients, "ea_team": team}
    url, key = os.environ["PULSE_OPSHUB_SUPABASE_URL"].rstrip("/"), os.environ["PULSE_OPSHUB_SUPABASE_KEY"]
    return {"ea_clients": http_source(url + "/rest/v1/ea_clients?select=id,data", key),
            "ea_team": http_source(url + "/rest/v1/ea_team?select=data&id=eq.team", key)}


def norm(value):
    return str(value or "").strip().casefold()


def owner_member(task, client, team):
    if task.get("status") == "done" and task.get("completedById"):
        return str(task["completedById"])
    role = task.get("ownerRole")
    if not role:
        return None
    if role == PGS:
        return str(client.get("assignedPmId") or "")
    role_pairs = {("SME", "SME 1"), ("SME", "SME 2"), ("Videographer", "Videographer 1"),
                  ("Videographer", "Videographer 2"), ("Video Editor", "General VE")}
    matches = [str(m["id"]) for m in team if m.get("pod") in {client.get("pod"), "Shared", "All"} and
               (role == m.get("role") or (role, m.get("role")) in role_pairs)]
    return matches[0] if len(matches) == 1 else None


TABLE_KEYS = {"client": ("id",), "project": ("id",), "work_project": ("project_id",), "task": ("id",),
              "identity_link": ("org_id", "entity_type", "source", "source_key", "valid_from")}


class Plan:
    """The same in-memory mutation plan drives dry-run and apply, with no speculative DB writes."""

    def __init__(self, c, org):
        self.org, self.changes = str(org["id"]), []
        self.rows = {}
        for table in (*TABLE_KEYS, "person"):
            query = sql.SQL("select to_jsonb(t) row from pulse.{} t where org_id=%s").format(sql.Identifier(table))
            self.rows[table] = [r["row"] for r in c.execute(query, (org["id"],))]

    def put(self, table, values, *, fill=False, locks=()):
        values = dict(values, org_id=self.org)
        key = {k: values[k] for k in TABLE_KEYS[table]}
        old = next((r for r in self.rows[table] if all(r.get(k) == v for k, v in key.items())), None)
        blocked = set((old or {}).get("locked", [])) | set(locks)
        if table == "task":
            for field, group in {"owner_id": ("assignee_person_id",), "assignee_person_id": ("owner_id",),
                                 "status": ("done_at", "source_status"), "due_label": ("due_at",)}.items():
                if field in blocked:
                    blocked.update(group)
        delta = {k: v for k, v in values.items()
                 if (not old or (k not in blocked and (not fill or old.get(k) in (None, ""))))
                 and (not old or old.get(k) != v)}
        if old and not delta:
            return "unchanged"
        self.changes.append({"table": table, "key": key, "before": copy.deepcopy(old),
                             "values": {**key, **delta, "org_id": self.org}})
        if old is None:
            self.rows[table].append(values)
        else:
            old.update(delta)
        return "update" if old else "insert"

    def match(self, kind, key, name, aliases=()):
        rows = [r for r in self.rows[kind]
                if not r.get("deleted_at") and (kind != "person" or r.get("side") == "staff")]
        links = {link["entity_id"] for link in self.rows["identity_link"]
                 if link["entity_type"] == kind and link["source"] == "opshub"
                 and link["source_key"] == key and link.get("valid_to") is None}
        names = {norm(name), *map(norm, aliases)} - {""}
        matches = [r for r in rows if r["id"] in links] if links else [r for r in rows if names &
                   {norm(r.get("display_name")), norm(r.get("title")), norm(r.get("name"))}]
        if len(matches) > 1 or len(links) > 1 or (links and not matches):
            return None, "ambiguous"
        if matches:
            target, state = matches[0]["id"], "reused"
        else:
            target, state = str(entity_id(self.org, kind, "opshub", key)), "new"
        if kind == "person" and state == "new":
            return None, "unmatched"
        if not links:
            self.put("identity_link", dict(entity_type=kind, entity_id=target, source="opshub",
                                           source_key=key, valid_from="-infinity", method="exact"))
        return target, state


def build_plan(c, org, document, *, aliases=None, today=None):
    p = Plan(c, org)
    counts = Counter(dict.fromkeys((
        "clients_reused clients_new clients_ambiguous projects_reused projects_new projects_ambiguous "
        "projects_skipped tasks_insert tasks_update tasks_unchanged tasks_status_open tasks_status_in_progress "
        "tasks_status_done tasks_status_unknown owners_matched tasks_unassigned members_unmatched "
        "dates_due_before_start dates_done_without_date").split(), 0))
    team_rows, clients = document["ea_team"], document["ea_clients"]
    if not isinstance(team_rows, list) or len(team_rows) > 1 or not isinstance(clients, list):
        raise ValueError("source shape refused")
    team = team_rows[0]["data"] if team_rows else []
    if not isinstance(team, list):
        raise ValueError("team shape refused")
    if len({str(m["id"]) for m in team}) != len(team) or len({str(r["id"]) for r in clients}) != len(clients):
        raise ValueError("duplicate source identity")
    people = {}
    for member in team:
        names = {norm(member.get("name"))}
        for canonical, alternatives in (aliases or {}).items():
            group = {norm(canonical), *map(norm, alternatives)}
            if names & group:
                names |= group
        person, _ = p.match("person", str(member["id"]), member.get("name"), names)
        people[str(member["id"])] = person
        counts["members_unmatched"] += person is None
    for row in clients:
        key, client = str(row["id"]), opshub_view(row["data"], today=today)
        if len({str(t["id"]) for t in client["deliverables"]}) != len(client["deliverables"]):
            raise ValueError("duplicate task identity")
        name = client.get("companyName") or client.get("developerName") or client["clientName"]
        cid, state = p.match("client", key, name)
        counts["clients_" + state] += 1
        if state == "new":
            p.put("client", dict(id=cid, display_name=name, client_type="other", source="opshub", type_basis="source"))
        name = client.get("projectName") or client["clientName"]
        project, state = p.match("project", key, name)
        counts["projects_" + state] += 1
        if not project:
            counts["projects_skipped"] += 1
            continue
        dates = [d["targetEnd"] for d in client["deliverables"] if d.get("targetEnd")]
        start, due = client.get("onboardingDate") or None, max(dates, default=None)
        existing = next((r for r in p.rows["work_project"] if r["project_id"] == project), {})
        if due and (existing.get("starts_on") or start) and due < (existing.get("starts_on") or start):
            due = None
            counts["dates_due_before_start"] += 1
        if start and existing.get("due_on") and start > existing["due_on"]:
            start = None
            counts["dates_due_before_start"] += 1
        status = {"Active": "active", "On Hold": "paused", "Inactive": "done"}.get(client["status"], "active")
        fields = dict(id=project, name=name, title=name, client_id=cid,
                      location=client.get("location") or None, segment=client.get("segment") or None, status=status)
        if state == "new":
            fields["registry_no"] = max((r["registry_no"] for r in p.rows["project"]), default=0) + 1
        p.put("project", fields, fill=True)
        project_locks = next(r for r in p.rows["project"] if r["id"] == project).get("locked", [])
        p.put("work_project", dict(project_id=project, kind="fulfilment",
                                  owner_id=people.get(str(client.get("assignedPmId"))), pod=client.get("pod") or None,
                                  starts_on=start, due_on=due, status=status), fill=True, locks=project_locks)
        for position, task in enumerate(client["deliverables"]):
            tid = str(task["id"])
            owner = people.get(owner_member(task, client, team))
            counts["owners_matched" if owner else "tasks_unassigned"] += 1
            status = {"not_started": "open", "in_progress": "in_progress", "done": "done"}.get(
                task.get("status"), "unknown")
            counts["tasks_status_" + status] += 1
            work, due = task.get("targetStart") or None, task.get("targetEnd") or None
            if work and due and due < work:
                due = None
                counts["dates_due_before_start"] += 1
            done = task.get("completionDate") or None
            counts["dates_done_without_date"] += status == "done" and not done

            def timestamp(value):
                return datetime.combine(date.fromisoformat(value), time(), ZoneInfo(org["time_zone"])
                                        ).astimezone(UTC).isoformat() if value else None

            notes = "\n".join(str(task[k]) for k in ("delayCategory", "delayNote", "notes") if task.get(k))
            values = dict(
                id=str(entity_id(p.org, "task", "opshub", key, tid)), project_id=project, title=task["name"],
                phase_key={f"Phase {n}": f"phase_{n}" for n in range(1, 5)}.get(task.get("phase")),
                owner_role=task.get("ownerRole"), position=position, source="ops_tool",
                source_key=f"opshub:{key}/{tid}",
                owner_id=owner, assignee_person_id=owner, status=status, source_status=task.get("status"), work_on=work,
                due_at=timestamp(due), done_at=timestamp(done) if status == "done" else None,
                notes="From Ops Hub\n" + notes if notes else None)
            counts["tasks_" + p.put("task", values)] += 1
    return p, counts


def apply_plan(c, plan):
    batch = c.execute("insert into pulse.import_batch(org_id,dataset,sha256,row_count) "
                      "values(%s,'opshub_import',%s,%s) returning id",
                      (plan.org, hashlib.sha256(uuid.uuid4().bytes).hexdigest(), len(plan.changes))).fetchone()["id"]
    for index, change in enumerate(plan.changes):
        table, values = change["table"], change["values"]
        cols = sql.SQL(",").join(map(sql.Identifier, values))
        update = sql.SQL(",").join(sql.SQL("{}=excluded.{}").format(sql.Identifier(k), sql.Identifier(k))
                                  for k in values if k not in TABLE_KEYS[table])
        if change["before"] is not None:
            assignments = sql.SQL(",").join(sql.SQL("{}=src.{}").format(sql.Identifier(k), sql.Identifier(k))
                                           for k in values if k not in (*TABLE_KEYS[table], "org_id"))
            where = sql.SQL(" and ").join(sql.SQL("target.{}=src.{}").format(sql.Identifier(k), sql.Identifier(k))
                                         for k in {"org_id", *TABLE_KEYS[table]})
            query = sql.SQL("update pulse.{t} target set {assignments} from "
                            "jsonb_populate_record(null::pulse.{t},%s) src where {where}").format(
                t=sql.Identifier(table), assignments=assignments, where=where)
        else:
            query = sql.SQL("insert into pulse.{t} ({cols}) select {cols} from "
                            "jsonb_populate_record(null::pulse.{t},%s) on conflict ({keys}) "
                            "do update set {update}").format(
                t=sql.Identifier(table), cols=cols, keys=sql.SQL(",").join(map(sql.Identifier, TABLE_KEYS[table])),
                update=update)
        c.execute(query, (Jsonb(values),))
        c.execute("insert into pulse.source_observation(org_id,dataset,source_key,payload,import_id) "
                  "values(%s,'opshub_ledger',%s,%s,%s)",
                  (plan.org, f"{batch}:{index:08d}", Jsonb(change), batch))
    return str(batch)


def run(c, org_id, document, *, apply=False, aliases=None, today=None):
    with c.transaction():
        c.execute("set transaction isolation level repeatable read" + (" read only" if not apply else ""))
        c.execute("set local time zone 'UTC'")
        set_tenant(c, org_id)
        c.execute("select set_config('pulse.viewer_id', '', true)")
        org = c.execute("select id,slug,time_zone from pulse.org where id=%s", (org_id,)).fetchone()
        if not org or org["slug"] != "ea":
            raise ValueError("organisation refused")
        if apply:
            c.execute("select pg_advisory_xact_lock(hashtext(%s))", ("opshub-import:" + str(org_id),))
            c.execute("select pg_advisory_xact_lock(hashtext(%s))", ("project-register:" + str(org_id),))
        today = today or datetime.now(ZoneInfo(org["time_zone"])).date().isoformat()
        plan, counts = build_plan(c, org, clean(document), aliases=aliases, today=today)
        return {"counts": dict(counts), **({"batch_id": apply_plan(c, plan)} if apply else {})}


class CountsParser(argparse.ArgumentParser):
    def error(self, message):
        raise ValueError("arguments refused")


def main():
    parser = CountsParser(description=__doc__)
    parser.add_argument("--file", type=Path)
    parser.add_argument("--org-slug", default="ea")
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument("--dry-run", action="store_true")
    modes.add_argument("--apply", action="store_true")
    try:
        args = parser.parse_args()
        if args.org_slug != "ea":
            raise ValueError("organisation refused")
        document = read_source(args.file)
        aliases = json.loads((Path(__file__).resolve().parents[4] / "config/ea-team.json").read_text())["name_aliases"]
        with connect("worker", autocommit=True) as c:
            org = c.execute("select id from pulse.org where slug=%s", (args.org_slug,)).fetchone()
            if not org:
                raise ValueError("organisation refused")
            result = run(c, org["id"], document, apply=args.apply, aliases=aliases)
        print(json.dumps(result))
    except Exception as exc:
        print(json.dumps({"error": type(exc).__name__}), file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
