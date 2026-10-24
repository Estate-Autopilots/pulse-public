"""The company roster, refreshed from metadata sources that name a person.

Sources: the Ops Hub team list (``config/ea-team.json``), the planned Workspace groups roster (a CSV outside the
repository), and the Workspace directory. Existing HR-derived records are preserved. Each person keeps the list of
sources that name them; where metadata sources disagree a ``person_flag`` asks for confirmation instead of picking
silently. Fields edited in the app are locked.
"""
# ruff: noqa: E501  (SQL kept on one line per column)
from __future__ import annotations

import csv
import os
import re
import uuid
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import date
from difflib import SequenceMatcher
from pathlib import Path

from psycopg.types.json import Jsonb
from pulse_rules.folder_rules import load as load_folder_rules

from pulse_sdk.ids import entity_id

GROUPS_ROSTER = "~/ea-infrastructure/workspace/gam/group-members.csv"
GROUP_DEPARTMENT = {"pgs": "Performance", "creative": "Creative", "production": "Production", "social": "Social",
                    "ops": "Operations"}
GROUP_ROLE = {"pgs": "PGS", "social": "Social", "production": "Production"}      # the role a group implies by itself

# Metadata roster readers also see shared role mailboxes; keep these labels out of person matching.
NON_PERSON_HEADINGS = {
    "founder team", "sales team", "hr & sales", "production head", "production coordinator", "access coordinator",
    "creative strategist", "videographer", "video editor", "graphic d.", "graphic design", "performance marketer",
    "hoo", "operations executive",
}
NON_PERSON_ROLE_LABELS = {"script", "video shoot", "shoot", "shoot & ve", "video editor", "pm", "pm (performance markter)"}
NON_PERSON_MONTHS = {
    "jan", "january", "feb", "february", "mar", "march", "apr", "aprl", "april", "may", "jun", "june", "jul",
    "july", "aug", "august", "sep", "sept", "september", "oct", "october", "nov", "november", "dec", "december",
}
NON_PERSON_WORDS = {
    "total", "salary", "task", "intern", "editor", "designer", "media", "team", "sheet", "hr", "marketing",
    "strategist", "optimization", "coordinator", "writer", "copywriter", "account", "group", "spend", "travel",
    "commission", "expenses", "cut", "everyone",
}
NON_PERSON_PREFIX = re.compile(r"^(name|employee name|total|sub[ -]?total|sum total|other|model|rent|cleaning|food|marketing|tools|"
                              r"fullfilment|s\.t\.|f\.t\.|traveling|graphic designer|copywriter|leaves|work from home|s no|"
                              r"sheet\d*|shoot coordinator|marketing account)\b", re.I)


def norm(name: str) -> str:
    text = re.sub(r"\(.*?\)", " ", name).lower()
    text = re.sub(r"\b(maam|ma'am|sir|mr|mrs|ms)\b\.?", " ", text)
    words = [w for w in re.sub(r"[^a-z ]", " ", text).split() if len(w) > 1]
    return " ".join(words)


def pretty(name: str) -> str:
    text = re.sub(r"\s+", " ", re.sub(r"\(.*?\)", " ", name)).strip(" .,-")
    return " ".join(w.capitalize() if w.islower() or (w.isupper() and len(w) > 2) else w for w in text.split())


def close(a: str, b: str) -> float:
    return SequenceMatcher(None, a, b).ratio()


def is_name(cell: str) -> bool:
    text = cell.strip().lower()
    words = norm(cell).split()
    return bool(re.search(r"[A-Za-z]{2}", cell)) and not re.search(r"\d", cell) and len(cell.split()) <= 4 \
        and len(cell) <= 40 and not NON_PERSON_PREFIX.match(cell.strip()) and text not in NON_PERSON_HEADINGS \
        and text not in NON_PERSON_ROLE_LABELS and text not in NON_PERSON_MONTHS and bool(words) \
        and not NON_PERSON_WORDS.intersection(words)


@dataclass
class Seen:
    """One mention of a person in one source."""
    source: str
    ref: str
    label: str
    written: str
    role: str | None = None
    grp: str | None = None
    pod: str | None = None
    department: str | None = None
    last_seen: date | None = None
    restricted: bool = False
    joined: date | None = None
    joined_note: str | None = None
    current: bool = False            # the source describes the team as it is now


@dataclass
class Entry:
    name: str
    pid: uuid.UUID | None = None
    seen: list[Seen] = field(default_factory=list)
    first_name_only: bool = False
    spelled: set[str] = field(default_factory=set)      # near-miss spellings merged without a configured alias


class Roster:
    def __init__(self, config: dict):
        self.entries: dict[str, Entry] = {}
        self.alias = {norm(a): norm(name) for name, aliases in config.get("name_aliases", {}).items() for a in aliases}
        self.canonical = {norm(name): name for name in [*config.get("name_aliases", {}), *(c["name"] for c in config.get("confirm_same_person", ()))]}
        self.confirm = {norm(c["alias"]): norm(c["name"]) for c in config.get("confirm_same_person", ())}
        self.confirmed_alias: dict[str, set[str]] = defaultdict(set)
        self.pending: list[tuple[str, Seen]] = []
        self.unresolved = 0

    def add(self, name: str, pid: uuid.UUID | None = None) -> Entry:
        return self.entries.setdefault(norm(name), Entry(re.sub(r"\s+", " ", name).strip(), pid))

    def _key(self, written: str, create: bool) -> str | None:
        key = norm(written)
        if not key:
            return None
        if key in self.confirm:
            self.confirmed_alias[self.confirm[key]].add(pretty(written))
            key = self.confirm[key]
        key = self.alias.get(key, key)
        if key in self.entries:
            return key
        words = key.split()
        if len(words) == 1:
            hits = [k for k in self.entries if k.split()[0] == key] or \
                   [k for k in self.entries if close(k.split()[0], key) >= 0.8]
            if len(hits) == 1:
                if hits[0].split()[0] != key:
                    self.entries[hits[0]].spelled.add(pretty(written))
                return hits[0]
            if hits or not create:
                return None
            self.entries[key] = Entry(self.canonical.get(key) or pretty(written), first_name_only=key not in self.canonical)
            return key
        for k in self.entries:
            other = k.split()
            if len(other) >= 2 and close(other[0], words[0]) >= 0.8 and close(other[-1], words[-1]) >= 0.8:
                self.entries[k].spelled.add(pretty(written))
                return k
        if not create:
            return None
        self.entries[key] = Entry(self.canonical.get(key) or pretty(written))
        return key

    def see(self, seen: Seen, create: bool = True) -> None:
        """Full names are placed first; first-name mentions wait until every full name is known."""
        if len(norm(seen.written).split()) >= 2:
            key = self._key(seen.written, create)
            if key:
                self.entries[key].seen.append(seen)
            else:
                self.unresolved += 1
        else:
            self.pending.append((seen.written, seen) if create else ("", seen))

    def settle(self) -> None:
        for create, seen in self.pending:
            key = self._key(seen.written, bool(create))
            if key:
                self.entries[key].seen.append(seen)
            else:
                self.unresolved += 1
        self.pending = []

    def key_for(self, written: str) -> str | None:
        return self._key(written, False)


# ------------------------------------------------------------------------------------------------- the sources
def read_ops_hub(roster: Roster, config: dict, org) -> None:
    for m in config["team"]:
        entry = roster.add(m["name"], entity_id(org, "person", "roster", m.get("key", m["name"])))
        entry.seen.append(Seen("ops_hub", "team", "Ops Hub team list", m.get("key", m["name"]), m["role"], m["pod"],
                               pod=m["pod"], current=True))


def read_groups(roster: Roster, by_email: dict[str, str], pods: dict[str, str]) -> bool:
    path = Path(os.environ.get("EA_GROUPS_ROSTER", GROUPS_ROSTER)).expanduser()
    if not path.is_file():
        return False
    with path.open(newline="") as handle:
        for row in csv.DictReader(handle):
            group, written, email = row["group"].split("@")[0], row["name"].strip(), (row.get("email") or "").strip().lower()
            if not is_name(re.sub(r"\(.*?\)", "", written)) or re.search(r"\b(group|account)$", written, re.I):
                continue
            role = (re.search(r"\((.*?)\)", written) or [None, None])[1] or GROUP_ROLE.get(group)
            seen = Seen("groups_roster", group, f"Planned groups roster · {group}@", re.sub(r"\s*\(.*?\)", "", written), role,
                        group, pod=pods.get(group),
                        department=pods.get(group) if group == "leadership" else GROUP_DEPARTMENT.get(group), current=True)
            if email in by_email:          # a personal Workspace account names the person exactly
                roster.entries[by_email[email]].seen.append(seen)
            else:
                roster.see(seen)
    return True


def read_directory(roster: Roster, index, config: dict) -> None:
    for u in index.execute("select email,name from ws_user where not coalesce(suspended,false)").fetchall():
        local = u["email"].lower().split("@")[0]
        if local in config["shared_local_parts"] and u["name"] and is_name(u["name"]) and len(u["name"].split()) >= 2 \
                and not re.search(r"writer|coordinator|autopilots", u["name"], re.I):
            roster.see(Seen("workspace_directory", u["email"].lower(), f"Workspace directory · name on the shared mailbox {local}@",
                            u["name"], config.get("mailbox_roles", {}).get(local), f"{local}@", current=True))


# ------------------------------------------------------------------------------------------------ the decisions
def same(a: str | None, b: str | None) -> bool:
    return re.sub(r"[^a-z]", "", (a or "").lower()) == re.sub(r"[^a-z]", "", (b or "").lower())


def decide(entry: Entry, newest_pay: date | None, aliases: set[str],
           leadership_pod: str | None) -> tuple[dict, dict, list[dict]]:
    """The record's fields, where each came from, and the open questions."""
    by = defaultdict(list)
    for s in entry.seen:
        by[s.source].append(s)
    ops, groups, directory, docs = (by[k] for k in ("ops_hub", "groups_roster", "workspace_directory", "hr_document"))
    docs_new = sorted((s for s in docs if s.last_seen), key=lambda s: s.last_seen, reverse=True)
    fields: dict = {"role": None, "pod": None, "department": None, "joined_on": None, "status": "active"}
    src: dict = {}
    flags: list[dict] = []

    def choose(name: str, options: list[tuple[str | None, str]]):
        real = [(v, label) for v, label in options if v]
        if real:
            fields[name], src[name] = real[0][0], {"source": real[0][1]}
        return real

    group_role = next((s for s in groups if s.role and s.role not in GROUP_ROLE.values()), None) or next((s for s in groups if s.role), None)
    roles = choose("role", [(ops[0].role if ops else None, "Ops Hub team list"), (group_role.role if group_role else None, group_role.label if group_role else ""),
                            *[(s.role, s.label) for s in directory], *[(s.role, s.label) for s in docs_new]])
    listed = [(v, label) for v, label in roles if not label.startswith(("Salary sheet", "HR report", "Attendance"))]
    distinct = [o for i, o in enumerate(listed) if not any(same(o[0], p[0]) for p in listed[:i])]
    if len(distinct) > 1:
        mailbox = next((s.grp for s in directory if s.grp), None)
        flags.append({"field": "role", "summary": "Sources give different roles: " + " or ".join(f"{v} ({label})" for v, label in distinct)
                      + (f". The directory names this person on {mailbox}." if mailbox else "."),
                      "options": [{"value": v, "source": label} for v, label in distinct]})
    pods = choose("pod", [(ops[0].pod if ops else None, "Ops Hub team list"), *[(s.pod, s.label) for s in groups]])
    pod_values = [o for i, o in enumerate(pods) if not any(o[0] == p[0] for p in pods[:i])]
    if len(pod_values) > 1:
        flags.append({"field": "pod", "summary": "Sources give different pods: " + " or ".join(f"{v} ({label})" for v, label in pod_values) + ".",
                      "options": [{"value": v, "source": label} for v, label in pod_values]})
    choose("department", [*[(s.department, s.label) for s in groups], *[(s.department, s.label) for s in docs_new],
                          (leadership_pod if fields["pod"] == leadership_pod else None, "Pod")])
    if fields["role"] and re.search(r"\bintern\b", fields["role"], re.I):
        fields["employment_type"], src["employment_type"] = "intern", src["role"]
    joins = Counter(s.joined for s in docs if s.joined)
    if joins:
        best = joins.most_common(1)[0][0]
        note = next(s for s in docs if s.joined == best)
        fields["joined_on"], src["joined_on"] = best, {"source": note.label, "detail": note.joined_note, "confirm": True}
        if len(joins) > 1:
            flags.append({"field": "joined_on", "summary": "Salary sheets give different joining dates: " + ", ".join(sorted(d.isoformat() for d in joins)) + ".",
                          "options": [{"value": d.isoformat(), "source": next(s.label for s in docs if s.joined == d)} for d in sorted(joins)]})
    current = bool(ops or groups or directory) or bool(newest_pay and any(s.last_seen and s.last_seen >= newest_pay for s in docs))
    if not current:
        last = docs_new[0] if docs_new else None
        fields["status"] = "inactive"
        src["status"] = {"source": last.label if last else "Company documents", "confirm": True}
        flags.append({"field": "status", "summary": f"Not in the current team lists. Last named in {last.label} ({last.last_seen:%b %Y}). Confirm whether this person still works at EA."
                      if last else "Not in the current team lists. Confirm whether this person still works at EA.",
                      "options": [{"value": "inactive", "source": "Not in a current list"}, {"value": "active", "source": "Still at EA"}]})
    questions = []
    if aliases:
        questions.append(f"{', '.join(sorted(aliases))} in HR documents is taken to be {entry.name}")
    if entry.spelled:
        questions.append(f"spelled {', '.join(sorted(entry.spelled))} elsewhere")
    if entry.first_name_only:
        questions.append("only a first name is known")
    if questions:
        flags.append({"field": "identity", "summary": "Confirm the name: " + "; ".join(questions) + ".",
                      "options": [{"value": n, "source": "As written in a source"} for n in sorted({entry.name, *aliases, *entry.spelled})]})
    return fields, src, flags


# --------------------------------------------------------------------------------------------------- the writer
def seed_roster(index, conn, org, config: dict, workspace: dict[uuid.UUID, dict], folder_rules=None) -> dict:
    """Runs inside the caller's tenant transaction. ``workspace``: person id → {name, accounts} of personal accounts."""
    folder_rules = folder_rules or load_folder_rules(conn, org)
    roster = Roster(config)
    by_email: dict[str, str] = {}
    for pid, person in workspace.items():
        entry = roster.add(person["name"], pid)
        entry.seen.append(Seen("workspace_directory", person["accounts"][0], "Workspace directory · own account",
                               person["name"], None, None, current=True))
        by_email.update({a: norm(person["name"]) for a in person["accounts"]})
    read_ops_hub(roster, config, org)
    has_groups = read_groups(roster, by_email, folder_rules.pods)
    read_directory(roster, index, config)
    roster.settle()

    known = {r["person_id"]: r for r in conn.execute(
        "select pp.person_id,pp.locked,p.display_name from pulse.people_profile pp join pulse.person p on p.id=pp.person_id").fetchall()}
    # Refresh only the metadata sources owned here. Historical HR-derived sources and rows remain intact.
    conn.execute("delete from pulse.person_source where source in ('ops_hub','groups_roster','workspace_directory')")
    stats = Counter()
    for key, entry in roster.entries.items():
        pid = entry.pid = entry.pid or entity_id(org, "person", "roster", entry.name)
        fields, src, flags = decide(entry, None, roster.confirmed_alias.get(key, set()),
                                    folder_rules.pods.get("leadership"))
        old = known.get(pid)
        locked = set(old["locked"]) if old else set()
        evidence = "Named in " + ", ".join(sorted({s.label.split(" “")[0].split(" · ")[0] for s in entry.seen})) + "."
        conn.execute("insert into pulse.person(id,org_id,display_name,side,status) values (%s,%s,%s,'staff',%s) on conflict(id) do nothing",
                     (pid, org, entry.name, fields["status"]))
        if old and "name" not in locked and old["display_name"] != entry.name and pid not in workspace:
            conn.execute("update pulse.person set display_name=%s where id=%s", (entry.name, pid))
            conn.execute("update pulse.people_profile set username=null where person_id=%s", (pid,))      # renamed: a new username follows
        if "status" not in locked and pid not in workspace:
            conn.execute("update pulse.person set status=%s where id=%s and status<>'offboarded'", (fields["status"], pid))
        conn.execute(
            "insert into pulse.people_profile(org_id,person_id,role,pod,department,employment_type,joined_on,evidence,field_sources) "
            "values (%(org)s,%(pid)s,%(role)s,%(pod)s,%(department)s,%(etype)s,%(joined)s,%(evidence)s,%(src)s) "
            "on conflict(person_id) do update set evidence=excluded.evidence,"
            "field_sources=(coalesce(people_profile.field_sources,'{}'::jsonb)-"
            "case when 'status'=any(people_profile.locked) then '' else 'status' end)||excluded.field_sources,"
            "role=case when 'role'=any(people_profile.locked) or excluded.role='Team member' then people_profile.role else excluded.role end,"
            "pod=case when 'pod'=any(people_profile.locked) or excluded.pod is null then people_profile.pod else excluded.pod end,"
            "department=case when 'department'=any(people_profile.locked) then people_profile.department else coalesce(excluded.department,people_profile.department) end,"
            "employment_type=case when 'employment_type'=any(people_profile.locked) then people_profile.employment_type else coalesce(excluded.employment_type,people_profile.employment_type) end,"
            "joined_on=case when 'joined_on'=any(people_profile.locked) then people_profile.joined_on else coalesce(excluded.joined_on,people_profile.joined_on) end",
            {"org": org, "pid": pid, "role": fields["role"] or "Team member", "pod": fields["pod"], "department": fields["department"],
             "etype": fields.get("employment_type"), "joined": fields["joined_on"], "evidence": evidence, "src": Jsonb(src)})
        merged: dict[tuple[str, str], Seen] = {}
        for s in entry.seen:
            merged.setdefault((s.source, s.ref), s)
        for s in merged.values():
            conn.execute("insert into pulse.person_source(org_id,person_id,source,source_ref,label,written_name,role,grp,last_seen,restricted) "
                         "values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) on conflict do nothing",
                         (org, pid, s.source, s.ref, s.label, s.written, s.role, s.grp or s.department, s.last_seen, s.restricted))
        fields_flagged = [f["field"] for f in flags]
        conn.execute("delete from pulse.person_flag where person_id=%s and status='open' and field in ('role','pod','status') "
                     "and not (field=any(%s))", (pid, fields_flagged))
        for f in flags:
            # A question someone answered in the app stays answered unless the sources now say something new.
            conn.execute("insert into pulse.person_flag(org_id,person_id,field,summary,options) values (%s,%s,%s,%s,%s) "
                         "on conflict(person_id,field) do update set summary=excluded.summary,options=excluded.options,"
                         "status=case when person_flag.options=excluded.options then person_flag.status else 'open' end "
                         "where person_flag.status='open' or not (excluded.options <@ person_flag.options)",
                         (org, pid, f["field"], f["summary"], Jsonb(f["options"])))
        stats["people"] += 1
        stats["active"] += fields["status"] == "active"
        stats["flags"] += len(flags)
        stats["joining_dates"] += bool(fields["joined_on"])
        stats["departments"] += bool(fields["department"])

    for email in config.get("sensitive_access", ()):
        key = by_email.get(email.lower())
        for permission in ("hr.salary.read", "hr.salary.write", "hr.contact.read", "hr.contact.write", "hr.documents.read"):
            if key:
                conn.execute("insert into pulse.sensitive_permission(org_id,person_id,permission,granted_by) values (%s,%s,%s,%s) "
                             "on conflict do nothing", (org, roster.entries[key].pid, permission, "Tenant configuration: sensitive_access"))
    return {"roster_people": stats["people"], "roster_active": stats["active"], "roster_flags": stats["flags"],
            "roster_sources": 3 + has_groups, "roster_unresolved_mentions": roster.unresolved}
