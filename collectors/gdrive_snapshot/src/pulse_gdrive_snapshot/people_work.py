"""PEOPLE-LIVE: attribute work to people from evidence, for every person's Work, Projects, Deliveries and Documents tabs.

Sources, strongest first: the Workspace groups roster (pods); task rows that name a person (the trackers already in
Pulse and, with a Google reader, tracker tabs added since); who owns a client in the PM/PGS columns and sheets; Drive
file owners and last editors on individual accounts; uploads from individual accounts; indexed mail headers.

Only two kinds of match are accepted automatically, through ``pulse.people_work_auto_accept`` so each has a receipt and
an undo: Workspace group membership → pod, and an exact roster name (or a configured full-name alias) on a task row →
task owner and project. Everything else becomes a suggestion with its basis, evidence references and a confidence.

The EA index and Google are read-only. Nothing is copied from pay or salary cells, mail bodies or snippets, and files
whose name or folder reads as private (pay, salary, hiring, KYC, …) are never listed. Shared logins never become a
person's account; their uploads only become low-confidence candidates through the person's own tasks.
"""
# ruff: noqa: E501  (SQL kept on one line per statement)
from __future__ import annotations

import csv
import hashlib
import io
import json
import os
import re
import uuid
from collections import Counter, defaultdict
from dataclasses import dataclass, field, replace
from datetime import date, datetime
from difflib import SequenceMatcher
from email.utils import parseaddr
from pathlib import Path

from psycopg.types.json import Jsonb

from pulse_sdk.db import tenant_tx

GROUPS_ROSTER = "~/ea-infrastructure/workspace/gam/group-members.csv"
GOOGLE_KEY = "/etc/estate-autopilots/google/indexer-sa.json"
WORKSPACE_DOMAIN = "estateautopilots.com"
# Names or folders that read as private. Such files never enter anyone's Documents and are never parsed for work.
# Short words use letter boundaries, so "Asha_TNA_Report" and "HR_Policy" are caught too.
PRIVATE = re.compile(r"(?i)(financ|salary|salaries|payroll|payslip|(?<![a-z])pay(?![a-z])|pay tracker|per task|commission|expenses|invoice|"
                     r"offer|hiring|apply for|applicat|resume|(?<![a-z])cv(?![a-z])|interview|kyc|aadha|passport|password|bank|pan card|"
                     r"team member details|personal|medical|leave|attendance|appraisal|increment|(?<![a-z])hr(?![a-z])|(?<![a-z])tna(?![a-z])|"
                     r"training need|employment (agreement|contract)|appointment letter|warning letter|disciplin|resignation|termination|relieving)")
# Group roster: pod groups name a pod; members of cross-pod function groups only work for every pod ("Shared").
POD_GROUPS = {"pod1": "Pod 1", "pod2": "Pod 2", "leadership": "Leadership"}
SHARED_GROUPS = {"creative", "production", "social", "ops", "pgs"}
POD_IN_TEXT = re.compile(r"(?i)\bpod\s*[-#|]*\s*([12])\b")
DOC_MIME = re.compile(r"^(application/vnd\.google-apps\.(document|spreadsheet|presentation|form)|application/pdf|"
                      r"application/vnd\.openxmlformats|application/msword|application/vnd\.ms-)")
SHEET_MIME = "application/vnd.google-apps.spreadsheet"
FOLDER_MIME = "application/vnd.google-apps.folder"
TRACKER_NAME = re.compile(r"(?i)(tracker|editing|video edit|graphic|creatives?\b|script|task|team management)")
TASK_WORDS = {"closed": "done", "approved": "done", "final": "done", "finalised": "done", "finalized": "done", "edit done": "done",
              "in review": "in_review", "review": "in_review", "rework": "in_progress", "edit in process": "in_progress"}
HEADERS = {
    "project": ("project name", "project", "client name", "client", "raw videos script", "project file", "project detail", "project details",
                "project pm name"),
    "type": ("video type", "creative type", "task", "task name", "type", "deliverable", "work"),
    "status": ("editing status", "status", "content approval status", "edit status"),
    "pm": ("assigned pm", "project pm", "pm", "pgs"),
    "assignee": ("video assigned", "task assigned", "script assigned", "creative assigned", "design assigned", "assigned to", "editor", "owner",
                 "assignee", "designer", "writer"),
    "date": ("date", "task date", "work date"),
}
MONTHS = {m: i for i, names in enumerate((("jan", "january"), ("feb", "february"), ("mar", "march"), ("apr", "april", "aprl"),
                                          ("may",), ("jun", "june"), ("jul", "july"), ("aug", "august"),
                                          ("sep", "sept", "september"), ("oct", "october"), ("nov", "november"),
                                          ("dec", "december")), 1) for m in names}


# ------------------------------------------------------------------------------------------------------------ names
def norm(value) -> str:
    text = re.sub(r"\(.*?\)", " ", str(value or "")).lower()
    text = re.sub(r"\b(mr|mrs|ms|miss|dr|sir|maam|ma'am)\b\.?", " ", text)
    return " ".join(w for w in re.sub(r"[^a-z ]", " ", text).split() if len(w) > 1)


def close(a: str, b: str) -> float:
    return SequenceMatcher(None, a, b).ratio()


@dataclass(frozen=True)
class Match:
    person: dict
    exact: bool            # deterministic: a unique full roster name or configured full-name alias
    confidence: float
    how: str
    written: str = ""      # the name as the source wrote it (a sheet title says "Posip", not "Posip Mifos")


class People:
    """Staff names, with the tenant's configured aliases (``name_aliases`` and ``confirm_same_person``)."""

    def __init__(self, rows: list[dict], config: dict | None = None):
        config = config or {}
        self.rows = rows
        self.by_id = {r["id"]: r for r in rows}
        sets: list[set[str]] = [{norm(name), *map(norm, aliases)} for name, aliases in config.get("name_aliases", {}).items()]
        sets += [{norm(c["name"]), norm(c["alias"])} for c in config.get("confirm_same_person", ())]
        self.names: dict[str, list[dict]] = defaultdict(list)
        for p in rows:
            own = norm(p["display_name"])
            known = {own}.union(*[s for s in sets if own in s]) if own else set()
            for n in known:
                if n and p not in self.names[n]:
                    self.names[n].append(p)
        self.first: dict[str, list[dict]] = defaultdict(list)
        for p in rows:
            words = norm(p["display_name"]).split()
            if words:
                self.first[words[0]].append(p)

    def match(self, written) -> Match | None:
        n = norm(written)
        if not n:
            return None
        words = n.split()
        hits = self.names.get(n, [])
        if len(hits) == 1:
            full = len(words) >= 2
            how = "roster name" if norm(hits[0]["display_name"]) == n else "configured alias of the roster name"
            return Match(hits[0], full, 1.0 if full else .9, how if full else f"{how}; the roster knows only one word")
        if hits:
            return None
        current = [p for p in self.first.get(words[0], []) if p["status"] == "active"]
        everyone = self.first.get(words[0], [])
        if len(words) == 1:
            if len(current) == 1:
                return Match(current[0], False, .85, "first name; only one current person has it")
            if not current and len(everyone) == 1:
                return Match(everyone[0], False, .7, "first name; only one former person has it")
            return None
        pool = current or everyone
        if len(pool) == 1:
            theirs = norm(pool[0]["display_name"]).split()
            if len(theirs) == 1:
                return Match(pool[0], False, .85, "first name matches; the roster knows only the first name")
            if close(theirs[-1], words[-1]) >= .8:
                return Match(pool[0], False, .85, "same first name, surname spelled differently")
        fuzzy = [p for p in self.rows if len(norm(p["display_name"]).split()) >= 2
                 and close(norm(p["display_name"]).split()[0], words[0]) >= .8 and close(norm(p["display_name"]).split()[-1], words[-1]) >= .8]
        if len(fuzzy) == 1:
            return Match(fuzzy[0], False, .75, "name spelled differently")
        return None


# --------------------------------------------------------------------------------------------------------- projects
DAY_PREFIX = re.compile(r"(?i)^\s*((mon|tues|wednes|thurs|fri|satur|sun)day\b[\s,-]*)?((\d{1,2}\s*(st|nd|rd|th)?\s+[a-z]+|[a-z]+\s+\d{1,2}(st|nd|rd|th)?)\b[\s,-]*)?"
                        r"((vov|model video|teaser|reel)\s*[-:]\s*)?")


def project_text(value) -> str:
    """'#25 - Rifob Abogehane | Mr. X | …', 'Sunday, December 14 - Codename' and 'VOV-Mr. Y | …' → the project part, lower case."""
    text = re.sub(r"^\s*#\s*\d+\s*[-–]\s*", "", str(value or ""))
    head = DAY_PREFIX.sub("", text, count=1)
    text = re.sub(r"^\s*#\s*\d+\s*[-–]\s*", "", head if head.strip() else text)
    return re.sub(r"\s+", " ", re.sub(r"\s*\|\s*", " | ", text)).strip(" |").lower()


class Projects:
    def __init__(self, rows: list[dict]):
        self.rows = rows
        self.by_id = {p["id"]: p for p in rows}
        self.full: dict[str, list[dict]] = defaultdict(list)
        self.title: dict[str, list[dict]] = defaultdict(list)
        for p in rows:
            self.full[project_text(p["name"])].append(p)
            for t in {norm(p.get("title")), norm(p.get("project_key")), norm(project_text(p["name"]).split(" | ")[0])}:
                if len(t) >= 4:
                    self.title[t].append(p)

    def match(self, *cells, day: date | None = None) -> tuple[dict, bool, float] | None:
        """(project, exact, confidence). Exact: the full Drive folder name, or one project with that title."""
        for cell in cells:
            hits = self.full.get(project_text(cell), [])
            if len(hits) == 1 and project_text(cell):
                return hits[0], True, 1.0
        for cell in cells:
            head = norm(project_text(cell).split(" | ")[0])
            hits = list({p["id"]: p for p in self.title.get(head, [])}.values())
            if len(hits) == 1:
                return hits[0], True, .95
            if hits and day:
                started = sorted((p for p in hits if p.get("start_month") and p["start_month"] <= day), key=lambda p: p["start_month"])
                if started:
                    return started[-1], False, .75
        for cell in cells:
            head = norm(project_text(cell).split(" | ")[0])
            if len(head) >= 6:
                ranked = sorted(((close(head, t), ps) for t, ps in self.title.items() if abs(len(t) - len(head)) <= 6), key=lambda x: -x[0])
                if ranked and ranked[0][0] >= .88 and len(ranked[0][1]) == 1 and (len(ranked) == 1 or ranked[1][0] < ranked[0][0]):
                    return ranked[0][1][0], False, .7
        return None


# -------------------------------------------------------------------------------------------------------- utilities
def work_title(value) -> str | None:
    """A task title as the tracker wrote it, refused when it carries amounts or private words (never redacted-and-kept)."""
    text = re.sub(r"https?://\S+", "", re.sub(r"\s+", " ", str(value or ""))).strip(" -|")
    if not text or len(text) > 240 or PRIVATE.search(text) or re.search(r"(?i)([₹$€]|\b(inr|rs\.?|paid|amount|salary)\b)", text):
        return None
    return text


def day_of(value) -> date | None:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value or "")[:10])
    except ValueError:
        return None


def month_of(label: str, fallback_year: int) -> date | None:
    """'October 26', 'sept 2026', 'VOV Apr 2026', 'Ridihu (March)' → the first of that month."""
    words = re.findall(r"[a-z]+|\d{2,4}", str(label).lower())
    month = next((MONTHS[w] for w in words if w in MONTHS), None)
    if not month:
        return None
    year = next((int(w) if len(w) == 4 else 2000 + int(w) for w in words if w.isdigit() and (len(w) == 4 or 20 <= int(w) <= 39)), fallback_year)
    return date(year, month, 1) if 2020 <= year <= 2039 else None


def task_status(value) -> str:
    from pulse_workers.company_seed import task_status as seed_status
    text = " ".join(str(value or "").lower().split())
    return TASK_WORDS.get(text) or seed_status(text)


def media_of(*texts) -> str | None:
    """Image or video work: the first text that says (title, then tab, then role; "VOV" on a creative editor's row is video)."""
    for text in texts:
        if re.search(r"(?i)graphic|creative|image|design|carous[ae]l|\bposts?\b|single image|static", str(text or "")):
            return "image"
        if re.search(r"(?i)vov|video|reel|model|edit|montage|teaser|hook|drone", str(text or "")):
            return "video"
    return None


def key_of(*parts) -> str:
    return hashlib.sha256("\x1f".join(str(p) for p in parts).encode()).hexdigest()[:32]


@dataclass
class Link:
    person: dict
    kind: str
    source: str
    ref: str
    title: str
    basis: str
    group_key: str
    group_label: str
    confidence: float
    auto: bool = False
    project_id: object = None
    task_id: object = None
    file_id: str | None = None
    pod: str | None = None
    role: str | None = None
    start: date | None = None
    end: date | None = None
    hours: float | None = None
    evidence: dict = field(default_factory=dict)

    @property
    def source_key(self) -> str:
        return "people-live:" + key_of(self.source, self.ref, self.person["id"], self.kind)


# --------------------------------------------------------------------------------------------------------- importer
class Importer:
    def __init__(self, index, pulse, org, *, config: dict | None = None, groups_path: str | None = None, sheets=None, today: date | None = None):
        """``sheets(file_meta) -> [(tab, rows)]`` reads a spreadsheet as aligned rows (read-only), or is None."""
        self.index, self.pulse, self.org = index, pulse, org
        self.config = config or {}
        self.groups_path = Path(groups_path or os.environ.get("EA_GROUPS_ROSTER", GROUPS_ROSTER)).expanduser()
        self.sheets = sheets
        self.today = today or date.today()
        self.links: dict[str, Link] = {}
        self.counts: Counter = Counter()
        self.sources: dict[str, Counter] = defaultdict(Counter)
        self.ok: set[str] = set()
        self.work: dict[object, list[tuple[dict, date | None, str | None, float]]] = defaultdict(list)   # project → (person, day, media, confidence)
        self.members: dict[str, list[dict]] = defaultdict(list)    # Workspace group → exact-name members
        q = pulse.execute
        self.people = People(q("select p.id,p.display_name,p.status,pp.pod,pp.locked,pp.email,pp.role from pulse.person p "
                               "join pulse.people_profile pp on pp.person_id=p.id where p.side='staff' and p.status<>'offboarded'").fetchall(), self.config)
        self.projects = Projects(q("select id,name,title,project_key,start_month,status from pulse.project where status<>'cancelled'").fetchall())
        self.pods = {r["name"] for r in q("select name from pulse.unit where kind='pod' and valid_to is null").fetchall()}
        self.shared = {r["handle"].lower() for r in q("select handle from pulse.account where is_shared").fetchall()}
        self.shared |= {f"{local}@{WORKSPACE_DOMAIN}" for local in self.config.get("shared_local_parts", ())}
        self.shared |= {a.lower() for a in self.config.get("shared_external_accounts", ())}
        self.accounts = self._accounts()

    # -- identities -----------------------------------------------------------------------------------------------
    def _accounts(self) -> dict[str, tuple[dict, float, str]]:
        """account → (person, identity confidence, how). Shared logins never map to a person."""
        out: dict[str, tuple[dict, float, str]] = {}
        for r in self.pulse.execute("select handle,holder_person_id from pulse.account where holder_person_id is not null and not is_shared").fetchall():
            p = self.people.by_id.get(r["holder_person_id"])
            if p:
                out[r["handle"].lower()] = (p, 1.0, "account linked to this person in Pulse")
        for p in self.people.rows:
            if p["email"] and p["email"].lower() not in self.shared:
                out.setdefault(p["email"].lower(), (p, 1.0, "the work e-mail on this person's record"))
        for u in self.index.execute("select email,name from ws_user where not coalesce(suspended,false)").fetchall():
            email = u["email"].lower()
            m = self.people.match(u["name"]) if email not in self.shared else None
            if m and m.exact:
                out.setdefault(email, (m.person, .95, f"the Workspace directory names {u['name']} on this account"))
        for r in self.pulse.execute("select distinct actor_account,actor_id from pulse.activity_observation where actor_id is not null and actor_account is not null").fetchall():
            p = self.people.by_id.get(r["actor_id"])
            if p and r["actor_account"].lower() not in self.shared:
                out.setdefault(r["actor_account"].lower(), (p, .8, "Drive permissions and HR records name this person on the account"))
        # Personal accounts whose address spells a full roster name (e.g. user-c3f8886c@gmail.com): a candidate only.
        handles = {r["handle"].lower() for r in self.pulse.execute("select handle from pulse.account where provider='google' and not is_shared").fetchall()}
        handles |= {r["a"] for r in self.index.execute("select distinct lower(substring(from_addr from '[^<\\s]+@[^>\\s]+')) a from gmail_message "
                                                       "where from_addr !~* %s", (WORKSPACE_DOMAIN,)).fetchall() if r["a"]}
        for handle in handles - set(out) - self.shared:
            local = re.sub(r"[^a-z]", "", handle.split("@")[0])
            hits = [p for p in self.people.rows if len(norm(p["display_name"]).split()) >= 2
                    and all(w in local for w in norm(p["display_name"]).split()[:2])]
            if len(hits) == 1 and not handle.endswith("@" + WORKSPACE_DOMAIN):
                out[handle] = (hits[0], .6, "the address spells this person's name; ownership unconfirmed")
        return out

    def link(self, new: Link) -> None:
        key = new.source_key
        if key in self.links:
            old = self.links[key]
            if new.auto and not old.auto:  # a deterministic source backs it too: it is accepted under that source's group
                old.auto, old.basis, old.group_key, old.group_label, old.role, old.evidence = True, new.basis, new.group_key, new.group_label, new.role, new.evidence
            old.confidence = max(old.confidence, new.confidence)
            old.start = min(filter(None, (old.start, new.start)), default=None)
            old.end = max(filter(None, (old.end, new.end)), default=None)
            return
        self.links[key] = new
        self.sources[new.source][f"{new.kind}_links"] += 1

    def project_link(self, person, source, project, role, basis, group_key, group_label, confidence, *, auto=False, start=None, end=None, evidence=None):
        self.link(Link(person, "project", source, str(project["id"]), project.get("title") or project["name"], basis, group_key, group_label,
                       confidence, auto=auto, project_id=project["id"], role=role, start=start, end=end, evidence=evidence or {}))

    # -- 1. Workspace groups → pod ------------------------------------------------------------------------------------
    def groups(self) -> None:
        if not self.groups_path.is_file():
            self.counts["groups_roster_missing"] += 1
            return
        member: dict[object, dict] = {}
        with self.groups_path.open(newline="") as handle:
            for row in csv.DictReader(handle):
                self.sources["workspace_groups"]["rows"] += 1
                group, written, email = row["group"].split("@")[0].lower(), row["name"].strip(), (row.get("email") or "").strip().lower()
                if group not in POD_GROUPS and group not in SHARED_GROUPS:
                    continue
                m = self.people.match(re.sub(r"\s*\(.*?\)", "", written))
                by_mail = self.accounts.get(email) if email and email not in self.shared else None
                if by_mail and by_mail[1] >= .95:
                    m = Match(by_mail[0], True, 1.0, "the member's own Workspace account")
                if not m:
                    self.counts["group_members_unmatched"] += 1
                    continue
                if m.exact and m.person not in self.members[group]:
                    self.members[group].append(m.person)
                entry = member.setdefault(m.person["id"], {"person": m.person, "groups": set(), "exact": True, "how": set()})
                entry["groups"].add(group)
                entry["exact"] &= m.exact
                entry["how"].add(m.how)
        for entry in member.values():
            p, groups = entry["person"], entry["groups"]
            pods = {POD_GROUPS[g] for g in groups if g in POD_GROUPS}
            if len(pods) == 1:
                pod = next(iter(pods))
                basis = f"Member of {', '.join(sorted(g + '@' for g in groups if g in POD_GROUPS))} in the Workspace groups roster"
            elif not pods:
                pod = "Shared"
                basis = f"Member of {', '.join(sorted(g + '@' for g in groups))} only: cross-pod groups, no pod group"
            else:
                self.counts["group_pod_conflicts"] += 1
                pod, basis = None, ""
            if not pod or pod not in self.pods:
                continue
            if p["pod"] == pod:
                self.sources["workspace_groups"]["pods_already_right"] += 1
                continue
            locked = "pod" in (p["locked"] or [])
            self.link(Link(p, "pod", "workspace_groups", pod, pod, basis + ("" if entry["exact"] else "; the name needs confirming"),
                           "pod:workspace_groups" if not locked else "pod:groups_vs_record",
                           "Pods from the Workspace groups" if not locked else "Workspace groups disagree with a pod set by hand",
                           1.0 if entry["exact"] and not locked else .75, auto=entry["exact"] and not locked, pod=pod,
                           evidence={"groups": sorted(g + "@" for g in groups), "matched": sorted(entry["how"]), "recordPod": p["pod"]}))
        self.ok.add("workspace_groups")

    # -- 2. task rows already in Pulse --------------------------------------------------------------------------------
    def pulse_tasks(self) -> None:
        rows = self.pulse.execute("select id,title,project_id,owner_id,assignee_person_id,owner_label,owner_role,source_period,assigned_at,work_on,"
                                  "created_at,done_at,status,evidence from pulse.task where parent_id is null").fetchall()
        # Owners set by an automatic decision are checked again: if the row no longer names them exactly, back to review.
        auto_owner = {r["task_id"]: r["person_id"] for r in self.pulse.execute(
            "select task_id,person_id from pulse.people_work_link where kind='task' and status='accepted' and auto_accepted").fetchall()}
        for t in rows:
            self.sources["task_rows"]["rows"] += 1
            day = day_of(t["work_on"]) or day_of(t["assigned_at"]) or month_of(t["source_period"] or "", self.today.year)
            owner = self.people.by_id.get(t["owner_id"] or t["assignee_person_id"])
            revisit = None
            if owner and auto_owner.get(t["id"]) == owner["id"]:
                again = self.people.match((t["owner_label"] or "").strip())
                if not (again and again.exact and again.person["id"] == owner["id"]):
                    revisit, owner = owner, None
                    self.counts["automatic_owners_revisited"] += 1
            if owner and t["project_id"]:
                self.work[t["project_id"]].append((owner, day, media_of(t["title"], t["source_period"], t["owner_role"]), 1.0))
            if owner:
                # The task already names its person: its project is theirs too (exact roster name at import, or set in Pulse).
                project = self.projects.by_id.get(t["project_id"])
                if project:
                    self.project_link(owner, "task_rows", project, (t["owner_role"] or "Task owner").strip().capitalize()[:80],
                                      "Owns tasks on this project", f"project-from-tasks:{owner['id']}", f"Projects from {owner['display_name']}'s tasks",
                                      1.0, auto=True, start=day, end=day, evidence={"taskSource": "task rows"})
                continue
            label = (t["owner_label"] or "").strip()
            m = self.people.match(label) if label else None
            if revisit and not (m and m.person["id"] == revisit["id"]):
                m = Match(revisit, False, .5, "the row no longer names this person exactly", label)
            if not label and not revisit:
                continue
            title = work_title(t["title"])
            if not m:
                self.counts["task_label_unmatched"] += 1
                continue
            if not title:
                self.counts["private_task_title_excluded"] += 1
                continue
            ref = (t["evidence"][0] if isinstance(t["evidence"], list) and t["evidence"] else {}) or {}
            evidence = {"writtenName": label, "sheet": ref.get("sheet"), "row": ref.get("row"), "file": ref.get("source_id"), "matched": m.how}
            exact_project = ref.get("projectMatch") in (None, "exact")   # rows from the earlier import carry a resolved project id
            group = f"task-label:{norm(label)}:{m.person['id']}"
            glabel = f"Tasks naming “{label}” → {m.person['display_name']}"
            self.link(Link(m.person, "task", "task_rows", str(t["id"]), title, f"Tracker row names “{label}” ({m.how})", group, glabel, m.confidence,
                           auto=m.exact, task_id=t["id"], project_id=t["project_id"], role=(t["owner_role"] or None), start=day, end=day, evidence=evidence))
            project = self.projects.by_id.get(t["project_id"])
            if project:
                self.work[t["project_id"]].append((m.person, day, media_of(t["title"], t["source_period"], t["owner_role"]), m.confidence))
                self.project_link(m.person, "task_rows", project, (t["owner_role"] or "Contributor").strip().capitalize()[:80],
                                  f"Tracker rows naming “{label}” are on this project", group, glabel, m.confidence if exact_project else min(m.confidence, .75),
                                  auto=m.exact and exact_project, start=day, end=day,
                                  evidence={"writtenName": label, "matched": m.how})
        self.ok.add("task_rows")

    # -- 3. tracker tabs added since the import (Google, read-only) ----------------------------------------------------
    def trackers(self) -> None:
        if not self.sheets:
            self.counts["tracker_reader_off"] += 1
            return
        seen: dict[tuple[str, str], int] = defaultdict(int)
        # Trackers get copied ("Archish EA - …" is a copy of "EA - Main Model …"): a row already imported is skipped by content.
        self.signatures = {(norm(r["owner_label"]), norm(r["title"]), r["work_on"]) for r in self.pulse.execute(
            "select owner_label,title,work_on from pulse.task where source_key like 'people-live:tracker:%%'").fetchall()}
        for r in self.pulse.execute("select e->>'source_id' f,e->>'sheet' s,max((e->>'row')::int) r from pulse.task t,"
                                    "jsonb_array_elements(case when jsonb_typeof(t.evidence)='array' then t.evidence else '[]' end) e "
                                    "where e->>'row' ~ '^[0-9]+$' group by 1,2").fetchall():
            seen[(r["f"], r["s"])] = r["r"]
        candidates = self.index.execute(
            "select id,name,owner,seen_by,modified from drive_file where mime=%s and not coalesce(trashed,false) and modified>now()-interval '400 days' order by modified desc",
            (SHEET_MIME,)).fetchall()
        for meta in candidates:
            name = meta["name"] or ""
            titled = self._title_person(name)
            if PRIVATE.search(name) or not (titled or TRACKER_NAME.search(name)):
                continue
            try:
                tabs = self.sheets(meta)
            except Exception as exc:  # one unreadable sheet never stops the run; counted, not logged with content
                self.counts[f"tracker_read_failed:{type(exc).__name__}"] += 1
                continue
            parsed = 0
            for tab, rows in tabs:
                parsed += self._tracker_tab(meta, titled, tab, rows, seen.get((meta["id"], tab), 0))
            if parsed:
                self.sources["tracker_sheets"]["files"] += 1
        self.ok.update({"tracker_sheets", "tracker_pm"})

    def _title_person(self, name: str) -> Match | None:
        for written in re.findall(r"\(([^)]{3,40})\)", name) + [name.split(" Pod")[0], name.split("'s ")[0], re.split(r"(?i)\s+sheet\b", name)[0]]:
            m = self.people.match(written)
            if m and len(norm(written).split()) <= 3:
                return replace(m, written=written.strip())
        return None

    def _tracker_tab(self, meta, titled: Match | None, tab: str, rows: list[tuple], done_rows: int) -> int:
        header_at, columns, project_cols = None, {}, []
        for i, row in enumerate(rows[:6]):
            cells = [norm(c) for c in row]
            found: dict[str, int] = {}
            for k, names in HEADERS.items():
                ranked = sorted((names.index(c), j) for j, c in enumerate(cells) if c in names)
                if ranked:
                    found[k] = ranked[0][1]
            if "project" in found and ("type" in found or "assignee" in found or titled):   # "Posip Sheet": the title names the person
                header_at, columns = i, found
                project_cols = [j for j, c in enumerate(cells) if c in HEADERS["project"]]
                break
        if header_at is None:
            self.counts["tracker_tabs_without_columns"] += 1
            return 0
        if "assignee" not in columns and not titled:
            self.counts["tracker_tabs_without_person"] += 1
            return 0
        month = month_of(tab, self.today.year)
        role = "script writer" if re.search(r"(?i)script", meta["name"]) else "video editor" if re.search(r"(?i)video|vov|edit", meta["name"]) else \
            "graphic designer" if re.search(r"(?i)graphic|image|creative", meta["name"]) else None
        n = 0
        for number, row in enumerate(rows[header_at + 1:], header_at + 2):
            def cell(k, row=row):
                return row[columns[k]] if k in columns and columns[k] < len(row) else None
            # A row without its own assignee takes the person the sheet title names, as the title writes it: never an exact roster name.
            from_title = not str(cell("assignee") or "").strip()
            written = str(cell("assignee") or "").strip() or (titled.written if titled else "")
            project_cells = sorted((row[j] for j in project_cols if j < len(row) and row[j]), key=lambda c: not str(c).lstrip().startswith("#"))
            if not written or not project_cells:
                continue
            day = day_of(cell("date")) or month
            found = self.projects.match(*project_cells, day=day)
            pm = self.people.match(cell("pm")) if cell("pm") else None
            if pm and found:  # every row, imported or not: who the project's PM is
                self.project_link(pm.person, "tracker_pm", found[0], "Assigned PM", f"Tracker “{meta['name'][:80]}” lists {str(cell('pm')).strip()} as the project's PM",
                                  f"pm:{pm.person['id']}", f"Projects where {pm.person['display_name']} is the assigned PM", min(pm.confidence, found[2], .9),
                                  start=day, end=day, evidence={"file": meta["id"], "sheet": tab, "row": number, "writtenName": str(cell("pm")).strip(), "matched": pm.how})
            if number <= done_rows:
                if from_title:   # rows written before 10 Oct 04:00 UTC carried the full roster name; keep the title's word instead
                    self.counts["tracker_labels_corrected"] += self.pulse.execute(
                        "update pulse.task set owner_label=%s where org_id=%s and source_key=%s and owner_label is distinct from %s",
                        (written, self.org, "people-live:tracker:" + key_of(meta["id"], tab, number), written)).rowcount
                continue
            m = self.people.match(written) if not from_title else titled
            if not m:
                self.counts["tracker_rows_unmatched_person"] += 1
                continue
            kind = work_title(cell("type")) or {"video editor": "Video edit", "graphic designer": "Creative", "script writer": "Script"}.get(role or "", "Task")
            title = work_title(f"{kind} — {project_text(project_cells[0]).split(' | ')[0].title()[:80]}")
            signature = (norm(written), norm(title), day)
            if not title or signature in self.signatures:
                self.counts["tracker_rows_already_imported"] += bool(title)
                continue
            self.signatures.add(signature)
            # A new task row like the tracker import's; the task-row step links it to its person (and accepts exact names).
            source_key = "people-live:tracker:" + key_of(meta["id"], tab, number)
            evidence = [{"source": "drive_sheet", "source_id": meta["id"], "sheet": tab, "row": number, "method": "tracker row (people-live)",
                         "columns": sorted(columns), "projectMatch": ("exact" if found[1] else "likely") if found else None, "confidence": m.confidence,
                         **({"personFrom": "sheet title"} if from_title else {})}]
            n += self.pulse.execute("insert into pulse.task(id,org_id,title,project_id,status,source,source_key,owner_label,owner_role,source_period,work_on,confidence,evidence) "
                                    "values(%s,%s,%s,%s,%s,'imported',%s,%s,%s,%s,%s,%s,%s) on conflict do nothing",
                                    (uuid.uuid5(uuid.UUID(str(self.org)), source_key), self.org, title, found[0]["id"] if found else None, task_status(cell("status")),
                                     source_key, written, role, tab[:60], day, m.confidence, Jsonb(evidence))).rowcount
        self.sources["tracker_sheets"]["rows"] += n
        self.counts["tracker_tasks_written"] += n
        return n

    def tracker_titles(self) -> None:
        """A person's own tracker titled "EA POD #1 | … (Name)" says which pod they work for: a suggestion, never automatic."""
        for meta in self.index.execute("select id,name from drive_file where mime=%s and not coalesce(trashed,false) and name ~* %s", (SHEET_MIME, r"\mpod")).fetchall():
            pod, titled = POD_IN_TEXT.search(meta["name"]), self._title_person(meta["name"])
            if not pod or not titled or PRIVATE.search(meta["name"]) or titled.person["pod"] or f"Pod {pod.group(1)}" not in self.pods:
                continue
            value = f"Pod {pod.group(1)}"
            self.link(Link(titled.person, "pod", "tracker_titles", value, value, f"Their tracker is titled “{meta['name'][:80]}” ({titled.how})", "pod:tracker_title",
                           "Pods from the titles of people's own trackers", min(.8, titled.confidence), pod=value, evidence={"file": meta["id"]}))
        self.ok.add("tracker_titles")

    # -- 4. who owns the client: registry PMs, project sheets titled by pod ------------------------------------------
    def project_owners(self) -> None:
        for r in self.pulse.execute("select entity_id,proposed,confidence from pulse.review_item where kind='project_pod' and status='pending' and entity_id is not null").fetchall():
            written = (r["proposed"] or {}).get("pgsCandidate")
            m = self.people.match(written) if written else None
            project = next((p for p in self.projects.rows if p["id"] == r["entity_id"]), None)
            if m and project:
                self.project_link(m.person, "review_queue", project, "Assigned PM", f"The project registry names {written} as the assigned PM ({m.how})",
                                  f"pm:{m.person['id']}", f"Projects where {m.person['display_name']} is the assigned PM", min(m.confidence, float(r["confidence"] or .9), .9),
                                  evidence={"writtenName": written, "registry": "project_pod review item", "matched": m.how})
                self.sources["review_queue"]["pm_names"] += 1
        # Per-project sheets in an individual's Drive, titled like "Pod-1 | <project> | …": the owner runs that client.
        for f in self.index.execute("select id,name,owner,modified from drive_file where not coalesce(trashed,false) and mime=%s and name ~* %s",
                                    (SHEET_MIME, r"^\s*(feedback\s*\|\s*)?pod\s*[-#]?\s*[12]\b")).fetchall():
            account = self.accounts.get((f["owner"] or "").lower())
            if not account or PRIVATE.search(f["name"]):
                continue
            body = re.sub(r"(?i)^\s*(feedback\s*\|\s*)?pod\s*[-#]?\s*[12]\s*[|l]\s*", "", f["name"])
            found = self.projects.match(body, body.split(" - ")[0], day=day_of(f["modified"]))
            if not found:
                continue
            person, identity, how = account
            pod = POD_IN_TEXT.search(f["name"])
            self.project_link(person, "project_sheets", found[0], "Runs the client sheet", f"Owns the client sheet “{f['name'][:80]}” ({how})",
                              f"project-sheets:{person['id']}", f"Client sheets in {person['display_name']}'s Drive", min(identity, found[2], .85),
                              end=day_of(f["modified"]), evidence={"file": f["id"], "account": f["owner"], "projectPod": f"Pod {pod.group(1)}" if pod else None})
            self.sources["project_sheets"]["files"] += 1
        self.ok.update({"review_queue", "project_sheets"})
        if self.sheets:
            self.client_sheets()

    def client_sheets(self) -> None:
        """Read-only: "Pod 1 Active Client & Result" has a tab per PGS listing their clients; the shoot schedule lists
        each client's shoot but not who filmed it, so production@'s videographers become low-confidence candidates."""
        for meta in self.index.execute("select id,name,owner,seen_by,modified from drive_file where mime=%s and not coalesce(trashed,false) "
                                       "and (name ~* 'active client' or name ~* '^\\s*shoot details') order by modified desc", (SHEET_MIME,)).fetchall():
            if PRIVATE.search(meta["name"]):
                continue
            try:
                tabs = self.sheets(meta)
            except Exception as exc:  # counted, never logged with content
                self.counts[f"client_sheet_read_failed:{type(exc).__name__}"] += 1
                continue
            shoot = bool(re.match(r"(?i)\s*shoot details", meta["name"]))
            pod = POD_IN_TEXT.search(meta["name"])
            for tab, rows in tabs:
                header = next((i for i, r in enumerate(rows[:4]) if any(norm(c) in ("client name", "client") for c in r)), None)
                pgs = None if shoot else self.people.match(tab)
                if header is None or (not shoot and not pgs):
                    continue
                cols = [j for j, c in enumerate(rows[header]) if norm(c) in ("client name", "client", "project name")]
                when = month_of(tab, self.today.year)
                for number, row in enumerate(rows[header + 1:], header + 2):
                    cells = [row[j] for j in cols if j < len(row) and row[j]]
                    found = self.projects.match(*cells, day=when) if cells else None
                    if not found:
                        continue
                    ref = {"file": meta["id"], "sheet": tab, "row": number}
                    if shoot:
                        for person in self.members.get("production", []):
                            self.project_link(person, "shoot_schedule", found[0], "Videographer (shoot)", f"The shoot schedule lists this client's shoot ({tab}); "
                                              "production@ has more than one videographer and the sheet does not say who filmed it", f"shoots:{person['id']}",
                                              f"Shoots {person['display_name']} may have filmed", .4, start=when, end=when, evidence=ref)
                        self.sources["shoot_schedule"]["rows"] += 1
                    else:
                        self.project_link(pgs.person, "active_clients", found[0], "PGS for the client", f"Listed under the “{tab.strip()}” tab of “{meta['name'][:60]}” ({pgs.how})",
                                          f"pm:{pgs.person['id']}", f"Projects where {pgs.person['display_name']} is the assigned PM", min(pgs.confidence, found[2], .85),
                                          end=when, evidence={**ref, "projectPod": f"Pod {pod.group(1)}" if pod else None})
                        self.sources["active_clients"]["rows"] += 1
        self.ok.update({"shoot_schedule", "active_clients"})

    # -- 5. Drive documents on individual accounts --------------------------------------------------------------------
    def documents(self) -> None:
        # The Drives of accounts that hold restricted HR records (config sensitive_access: hr@, leadership) are HR material, never work documents.
        restricted = {a.lower() for a in self.config.get("sensitive_access", ())}
        accounts = [a for a in self.accounts if (a.endswith("@" + WORKSPACE_DOMAIN) or self.accounts[a][1] >= .8) and a not in restricted]
        if not accounts:
            self.ok.add("drive_documents")
            return
        project_of = {r["file_id"]: r["project_id"] for r in self.pulse.execute("select file_id,project_id from pulse.index_file where project_id is not null").fetchall()}
        rows = self.index.execute("select id,name,mime,path,owner,modified_by,modified from drive_file where not coalesce(trashed,false) and mime<>%s "
                                  "and (lower(owner)=any(%s) or lower(modified_by)=any(%s)) order by modified desc", (FOLDER_MIME, accounts, accounts)).fetchall()
        per: Counter = Counter()
        for f in rows:
            if not DOC_MIME.match(f["mime"] or "") or PRIVATE.search(f"{f['name']} {f['path'] or ''}"):
                self.counts["documents_private_or_media_skipped"] += 1
                continue
            for account, role, base in ((f["owner"], "Owner", .9), (f["modified_by"], "Last edited", .7)):
                hit = self.accounts.get((account or "").lower())
                if not hit or (role == "Last edited" and (f["owner"] or "").lower() == (account or "").lower()):
                    continue
                person, identity, how = hit
                if per[(person["id"], role)] >= 400:
                    continue
                per[(person["id"], role)] += 1
                self.link(Link(person, "document", "drive_documents", f["id"], f["name"][:300], f"{role} in Drive: {account} ({how})",
                               f"docs:{role.lower().replace(' ', '_')}:{account.lower()}", f"Documents {'owned by' if role == 'Owner' else 'last edited from'} {account}",
                               round(base * identity, 3), file_id=f["id"], project_id=project_of.get(f["id"]), role=role, end=day_of(f["modified"]),
                               evidence={"account": account, "mime": f["mime"], "path": (f["path"] or "")[:300]}))
        self.ok.add("drive_documents")

    # -- 6. deliveries --------------------------------------------------------------------------------------------------
    def deliveries(self) -> None:
        rows = self.pulse.execute("select d.file_id,d.project_id,d.delivered_at,d.kind,d.uploader_account,f.name,f.mime,f.path from pulse.delivery d "
                                  "join pulse.index_file f using(org_id,file_id) where not exists(select 1 from pulse.delivery_actor a where a.org_id=d.org_id "
                                  "and a.file_id=d.file_id and a.actor_id is not null)").fetchall()
        for d in rows:
            self.sources["deliveries"]["rows"] += 1
            if PRIVATE.search(f"{d['name']} {d['path']}"):
                continue
            account = (d["uploader_account"] or "").lower()
            hit = self.accounts.get(account) if account not in self.shared else None
            when = day_of(d["delivered_at"])
            if hit:
                person, identity, how = hit
                self.link(Link(person, "delivery", "deliveries", d["file_id"], d["name"][:300], f"Uploaded from {account} ({how})", f"uploads:{account}",
                               f"Deliveries uploaded from {account}", round(.95 * identity, 3), file_id=d["file_id"], project_id=d["project_id"], start=when, end=when,
                               evidence={"account": account, "kind": d["kind"]}))
                continue
            # Shared login: the people whose own tasks on this project match the file's type and date are candidates.
            media = "video" if (d["mime"] or "").startswith("video/") else "image" if (d["mime"] or "").startswith("image/") else None
            best: dict[object, tuple[dict, float]] = {}
            for person, day, work_media, conf in self.work.get(d["project_id"], ()):
                if not media or media != (work_media or media_of(person.get("role"))):
                    continue
                if not when or not day or abs((when - day).days) > 10:
                    continue
                score = round(.5 * conf, 3)
                if score > best.get(person["id"], (None, 0))[1]:
                    best[person["id"]] = (person, score)
            if len(best) > 2:
                continue  # too many candidates to suggest anyone
            for person, score in best.values():
                self.link(Link(person, "delivery", "shared_login_candidates", d["file_id"], d["name"][:300],
                               f"Uploaded through the shared login {account or 'unknown'}; {person['display_name']} had matching {media} work on this project within ten days",
                               f"shared-candidates:{person['id']}", f"Shared-login deliveries matching {person['display_name']}'s tasks", score,
                               file_id=d["file_id"], project_id=d["project_id"], start=when, end=when, evidence={"account": account, "kind": d["kind"], "basis": "task date and type"}))
        self.ok.update({"deliveries", "shared_login_candidates"})

    # -- 7. mail headers ------------------------------------------------------------------------------------------------
    def mail(self) -> None:
        accounts = [a for a in self.accounts if a not in self.shared]
        titles = [(p, norm(p.get("title") or project_text(p["name"]).split(" | ")[0])) for p in self.projects.rows]
        titles = [(p, t) for p, t in titles if len(t) >= 6]
        hits: dict[tuple, dict] = {}
        for r in self.index.execute("select from_addr,subject,sent_at from gmail_message where sent_at>now()-interval '400 days' and subject ~* %s and lower(from_addr) ~ %s",
                                    (r"(draft|revision|report|final|creative|video|feedback|lead|script|edit)", "(" + "|".join(re.escape(a) for a in accounts) + ")" if accounts else "^$")).fetchall():
            sender = parseaddr(r["from_addr"] or "")[1].lower()
            if sender not in accounts or PRIVATE.search(r["subject"] or ""):
                continue
            self.sources["mail_headers"]["messages"] += 1
            subject = " " + norm(r["subject"]) + " "
            for p, t in titles:
                if f" {t} " in subject:
                    h = hits.setdefault((sender, p["id"]), {"project": p, "n": 0, "first": None, "last": None})
                    h["n"] += 1
                    d = day_of(r["sent_at"])
                    h["first"] = min(filter(None, (h["first"], d)), default=None)
                    h["last"] = max(filter(None, (h["last"], d)), default=None)
        for (sender, _), h in hits.items():
            person, identity, how = self.accounts[sender]
            self.project_link(person, "mail_headers", h["project"], "Sends drafts, revisions or reports",
                              f"{h['n']} message{'s' if h['n'] != 1 else ''} from {sender} name the project in the subject (headers only)",
                              f"mail:{sender}", f"Projects named in mail from {sender}", round(min(.75, .55 + .05 * h["n"]) * identity, 3),
                              start=h["first"], end=h["last"], evidence={"account": sender, "messages": h["n"]})
        self.ok.add("mail_headers")

    # -- write ----------------------------------------------------------------------------------------------------------
    def write(self) -> dict:
        q = self.pulse.execute
        existing_tasks = {r["id"] for r in q("select id from pulse.task where id=any(%s)", ([lk.task_id for lk in self.links.values() if lk.task_id],)).fetchall()}
        auto: list[str] = []
        revert: list[str] = []
        for key, lk in self.links.items():
            if lk.kind == "task" and lk.task_id not in existing_tasks:
                continue
            row = q("""insert into pulse.people_work_link(org_id,source_key,person_id,kind,project_id,task_id,file_id,pod,title,role,period_from,period_to,hours,
                       source,confidence,basis,evidence,group_key,group_label,seen_at)
                       values(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,now())
                       on conflict(org_id,source_key) do update set seen_at=now(),retired_at=null,
                        title=case when people_work_link.status='suggested' then excluded.title else people_work_link.title end,
                        confidence=case when people_work_link.status='suggested' then excluded.confidence else people_work_link.confidence end,
                        basis=case when people_work_link.status='suggested' then excluded.basis else people_work_link.basis end,
                        evidence=case when people_work_link.status='suggested' then excluded.evidence else people_work_link.evidence end,
                        role=excluded.role,period_from=excluded.period_from,period_to=excluded.period_to,group_key=excluded.group_key,group_label=excluded.group_label
                       returning id,status,decided_at,auto_accepted""",
                    (self.org, key, lk.person["id"], lk.kind, lk.project_id, lk.task_id, lk.file_id, lk.pod, lk.title[:300], (lk.role or None) and lk.role[:80],
                     lk.start, lk.end, lk.hours, lk.source, round(min(max(lk.confidence, 0), 1), 3), lk.basis[:400], Jsonb({k: v for k, v in lk.evidence.items() if v is not None}),
                     lk.group_key[:200], lk.group_label[:200])).fetchone()
            if lk.auto and row["status"] == "suggested" and row["decided_at"] is None:
                auto.append(row["id"])
            elif not lk.auto and row["status"] == "accepted" and row["auto_accepted"]:
                revert.append(row["id"])
        reverted = q("select pulse.people_work_auto_revert(%s::uuid[]) n", (revert,)).fetchone()["n"] if revert else 0
        accepted = q("select pulse.people_work_auto_accept(%s::uuid[]) n", (auto,)).fetchone()["n"] if auto else 0
        # One transaction: every link this run saw has seen_at = now(); suggestions no source supports any more retire.
        retired = q("update pulse.people_work_link set retired_at=now() where status='suggested' and retired_at is null and seen_at<now() and source=any(%s)",
                    (sorted(self.ok),)).rowcount
        totals = {r["status"]: r["n"] for r in q("select status,count(*)::int n from pulse.people_work_link where retired_at is null group by 1").fetchall()}
        by_source = {}
        for r in q("select source,count(*) filter(where status='accepted' and auto_accepted)::int auto,count(*) filter(where status='accepted')::int accepted,"
                   "count(*) filter(where status='suggested')::int suggested from pulse.people_work_link where retired_at is null group by 1").fetchall():
            by_source[r["source"]] = {"auto_accepted": r["auto"], "accepted": r["accepted"], "suggested": r["suggested"]}
        return {"links_seen": len(self.links), "auto_accepted_now": accepted, "auto_reverted_now": reverted, "retired": retired, "totals": totals,
                "by_source": by_source}

    def run(self) -> dict:
        for step in (self.groups, self.trackers, self.pulse_tasks, self.tracker_titles, self.project_owners, self.documents, self.mail, self.deliveries):
            step()
        result = self.write()
        return {**result, "counts": dict(self.counts), "sources": {k: dict(v) for k, v in self.sources.items()}}


# ---------------------------------------------------------------------------------------------------- entry points
def google_sheets(key_path: str = GOOGLE_KEY):
    """A read-only reader: exports a native sheet to xlsx in memory as a Workspace user who can see it (FIN-LIVE's way)."""
    if not Path(key_path).is_file() or not os.access(key_path, os.R_OK):
        return None
    from pulse_workers.finance_live.drive import readonly_drive
    services: dict[str, object] = {}

    def read(meta) -> list[tuple[str, list[tuple]]]:
        import openpyxl
        readers = [a for a in [meta.get("owner"), *(meta.get("seen_by") or [])] if a and a.lower().endswith("@" + WORKSPACE_DOMAIN)]
        if not readers:
            raise PermissionError("no Workspace reader")
        subject = readers[0].lower()
        svc = services.setdefault(subject, readonly_drive(key_path, subject))
        data = svc.files().export(fileId=meta["id"], mimeType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet").execute(num_retries=1)
        book = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
        try:
            return [(ws.title, list(ws.iter_rows(values_only=True))[:3000]) for ws in book.worksheets]
        finally:
            book.close()
    return read


def load_config() -> dict:
    root = Path(os.environ.get("PULSE_REPO_ROOT", Path(__file__).resolve().parents[4]))
    path = root / "config" / "ea-team.json"
    return json.loads(path.read_text()) if path.is_file() else {}


def refresh_people_work(index, pulse, org, *, sheets=None, config=None, groups_path=None) -> dict:
    """One tenant transaction under the import lock. Returns counts only."""
    with tenant_tx(pulse, org):
        pulse.execute("select pg_advisory_xact_lock(hashtextextended(%s,0))", (f"people-work:{org}",))
        importer = Importer(index, pulse, org, config=config if config is not None else load_config(), groups_path=groups_path,
                            sheets=None if sheets is False else sheets if sheets is not None else google_sheets())
        return importer.run()


def main() -> int:
    import argparse

    import psycopg
    from psycopg.rows import dict_row

    from pulse_sdk.db import url_for
    parser = argparse.ArgumentParser(description="Attribute work to people from evidence (PEOPLE-LIVE).")
    parser.add_argument("--no-sheets", action="store_true", help="skip the read-only Google tracker reader")
    args = parser.parse_args()
    try:
        with psycopg.connect(os.environ["EA_INDEX_DATABASE_URL"], autocommit=True, row_factory=dict_row, options="-c default_transaction_read_only=on") as index, \
                psycopg.connect(url_for("worker"), autocommit=True, row_factory=dict_row) as pulse:
            org = pulse.execute("select pulse.install_org() org").fetchone()["org"]
            if not org:
                raise RuntimeError("Tenant is not installed")
            result = refresh_people_work(index, pulse, org, sheets=False if args.no_sheets else None)
        print(json.dumps({"ok": True, **result}, default=str), flush=True)
        return 0
    except Exception as exc:  # provider and database messages can carry private data
        print(json.dumps({"ok": False, "error": type(exc).__name__}), flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
