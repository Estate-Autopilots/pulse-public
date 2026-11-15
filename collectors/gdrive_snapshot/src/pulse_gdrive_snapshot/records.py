"""Records Pulse keeps for the tenant: staff ids, clients, contacts and project fields, seeded from Drive.

Pulse is the system of record. This module only fills and refreshes what the source knows: a field that someone
edited in the app is listed in the row's ``locked`` column and is never overwritten here. Client identity is
resolved once and stored in ``pulse.identity_link`` (source ``drive_folder_name``), so a client keeps its id when
new spellings of its name appear.
"""
# ruff: noqa: E501  (SQL kept on one line per column)
from __future__ import annotations

import re
import uuid
from collections import Counter, defaultdict
from datetime import date

import psycopg
from pulse_rules.folder_rules import load as load_folder_rules

from pulse_sdk.ids import entity_id

from . import folder_names as fn

CLIENT_SOURCE = "drive_folder_name"
_COMPANY_NOISE = {"pvt", "ltd", "llp", "private", "limited", "the", "and"}


def company_key(name: str) -> str:
    return " ".join(w for w in fn.norm(name).split() if w not in _COMPANY_NOISE)


def tidy(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip(" .,-|")


def username_for(name: str, taken: set[str]) -> str:
    """'Savuzo Roberatano' → 'savuzo.roberatano'; a number is added when the name is taken."""
    words = re.sub(r"[^a-z0-9 ]", "", name.lower()).split() or ["user"]
    base = ".".join(words[:3])[:36].strip(".")
    if len(base) < 3:
        base = f"{base}.user"
    candidate, n = base, 2
    while candidate in taken:
        candidate, n = f"{base}{n}", n + 1
    taken.add(candidate)
    return candidate


def merge_person(conn, keep: uuid.UUID, gone: uuid.UUID) -> bool:
    """Fold a duplicate person into the one that stays: one human, several accounts."""
    if not conn.execute("select 1 from pulse.person where id=%s and status<>'offboarded'", (gone,)).fetchone():
        return False
    for table, column in (("account", "holder_person_id"), ("attendance_entry", "person_id"),
                          ("leave_request", "person_id"), ("leave_request", "decided_by"),
                          ("record_change", "changed_by"), ("unit", "head_person_id")):
        conn.execute(f"update pulse.{table} set {column}=%s where {column}=%s", (keep, gone))  # noqa: S608
    conn.execute("update pulse.identity_link set entity_id=%s where entity_type='person' and entity_id=%s", (keep, gone))
    for table in ("role_assignment", "people_profile", "person_photo"):
        conn.execute(f"delete from pulse.{table} where person_id=%s", (gone,))  # noqa: S608
    try:
        with conn.transaction():
            conn.execute("delete from pulse.person where id=%s", (gone,))
    except psycopg.errors.ForeignKeyViolation:      # still referenced somewhere: keep the row, out of every list
        conn.execute("update pulse.person set status='offboarded' where id=%s", (gone,))
    return True


def assign_staff_ids(conn, org: uuid.UUID) -> int:
    """Every staff record gets a user number and a username once; neither changes afterwards."""
    rows = conn.execute("select pp.person_id,p.display_name,pp.user_no,pp.username from pulse.people_profile pp "
                        "join pulse.person p on p.id=pp.person_id order by p.created_at,p.display_name").fetchall()
    next_no = max((r["user_no"] or 0 for r in rows), default=0) + 1
    taken = {r["username"] for r in rows if r["username"]}
    made = 0
    for r in rows:
        if r["user_no"] and r["username"]:
            continue
        number = r["user_no"] or next_no
        next_no += 0 if r["user_no"] else 1
        conn.execute("update pulse.people_profile set user_no=%s,username=%s where person_id=%s",
                     (number, r["username"] or username_for(r["display_name"], taken), r["person_id"]))
        made += 1
    return made


class _Clients:
    """Trusted scoped project identity → account; display-name similarity never links new identities."""

    def __init__(self, conn, org):
        self.conn, self.org = conn, org
        self.known = {r["source_key"]: r["entity_id"] for r in conn.execute(
            "select source_key,entity_id from pulse.identity_link where entity_type='client' and source=%s",
            (CLIENT_SOURCE,))}

    def resolve(self, key: str, raw: str, retained: uuid.UUID | None = None) -> uuid.UUID:
        if key in self.known:
            return self.known[key]
        # Preserve an existing project's accepted account. New project contexts start unresolved accounts.
        # No name, common term or representative is enough to reuse a different project's account.
        client = retained or entity_id(self.org, "client", CLIENT_SOURCE, key)
        self.conn.execute(
            "insert into pulse.identity_link(org_id,entity_type,entity_id,source,source_key,raw_value,method,confidence) "
            "values (%s,'client',%s,%s,%s,%s,'evidence',1) on conflict do nothing",
            (self.org, client, CLIENT_SOURCE, key, raw))
        self.known[key] = client
        return client


def seed_records(conn, org: uuid.UUID) -> dict:
    """Refresh project fields, clients and contacts from the engagement folder names. Runs inside tenant_tx."""
    projects = conn.execute("select id,name,storage_root,locked,client_id,project_key from pulse.project").fetchall()
    rules = load_folder_rules(conn, org)
    # Source-backed Round 8 classifications survive the original folder-name refresh. Never add these to manual locks.
    cleaned = {}
    if conn.execute("select to_regclass('pulse.research_engagement') t").fetchone()["t"]:
        cleaned = {r["project_id"]: r for r in conn.execute(
            "select distinct on(project_id) project_id,segment,locality from pulse.research_engagement "
            "where project_id is not null order by project_id,month desc nulls last,folder_id")}

    work = []
    for p in projects:
        path = (p["storage_root"] or "").removeprefix("index-path:")
        work.append((p, fn.engagement(path, rules.project_paths)))
    fn.learn_first_names([p["name"] for p, path_match in work if path_match])
    parsed = [(p, path_match, fn.parse(p["name"], *(path_match.year_month or (None, None))))
              for p, path_match in work if path_match]
    for p, path_match in work:
        if not path_match:
            conn.execute("update pulse.project set kind='internal' where id=%s and kind<>'internal'", (p["id"],))

    # Existing accepted associations survive; each new source project has its own provisional identity.
    keyed, counts = {}, Counter()
    for p, path_match, rec in parsed:
        if p["client_id"] is None and "client_id" in (p["locked"] or ()):
            continue  # a deliberate unmapping stays unbound on replay
        path_client = path_match.captures.get("client")
        if path_client and fn.norm(path_client):
            key, raw = "drive-path-client:" + fn.norm(path_client), path_client
        elif rec["contact"]:
            key, raw = "drive-project:" + str(p["id"]), rec["contact"]
        elif rec["developer"] and company_key(rec["developer"]):
            key, raw = "drive-project:" + str(p["id"]), rec["developer"]
        else:
            continue
        if len(key) > 4:
            keyed[p["id"]] = (key, raw)
            counts[key] += 1
    clients = _Clients(conn, org)
    raw_of = {}
    for _pid, (key, raw) in keyed.items():
        raw_of.setdefault(key, raw)
    retained = {}
    for project in projects:
        key = keyed.get(project["id"], (None, None))[0]
        if key and project["client_id"]:
            retained.setdefault(key, project["client_id"])
    for key in sorted(counts, key=lambda k: (-counts[k], k)):
        clients.resolve(key, raw_of[key], retained.get(key))

    by_client: dict[uuid.UUID, dict] = defaultdict(lambda: {"names": Counter(), "companies": Counter(),
                                                            "path_names": Counter(), "projects": set(),
                                                            "contact": False, "n": 0})
    models: dict[str, tuple[str, set]] = {}
    updates = []
    for p, path_match, rec in parsed:
        key = keyed.get(p["id"], (None, None))[0]
        client = clients.known.get(key) if key else None
        ym = path_match.year_month
        pkey = fn.project_key(rec["project"]) if rec["project"] else ""
        place = fn.norm(rec["location"] or "")
        if len(pkey) < 3:
            pkey = p["project_key"] or (f"source:{p['id']}@{place}" if key else "")
        elif len(pkey.split()) == 1 and place:
            pkey = f"{pkey}@{place}"        # one-word names (Kevaleto, Lodha) are only the same project in one place
        title = tidy(rec["project"] or "") or (fn.person_name(rec["contact"]) if rec["contact"] else "") \
            or tidy(fn.SERIAL_RE.sub("", p["name"]))
        segment = " + ".join(dict.fromkeys(tidy(s) for s in rec["segment"])) or None
        observed = cleaned.get(p["id"])
        if observed and observed["segment"] != "unknown":
            segment = observed["segment"]
        location = observed["locality"] if observed and observed["locality"] else tidy(rec["location"] or "") or None
        month = date(ym[0], ym[1], 1) if ym and ym[0] and ym[1] else None
        locked = set(p["locked"] or ())
        updates.append((pkey or None, fn.serial(p["name"]), month, "title" in locked, title,
                        "location" in locked, location, "segment" in locked, segment,
                        "client_id" in locked, client, p["id"]))
        if client:
            c = by_client[client]
            c["projects"].add(pkey or str(p["id"]))
            c["n"] += 1
            if path_match.captures.get("client"):
                c["path_names"][tidy(path_match.captures["client"])] += 1
            if rec["contact"]:
                c["contact"] = True
                c["names"][fn.person_name(rec["contact"])] += 1
            if rec["developer"]:
                c["companies"][tidy(rec["developer"])] += 1
        for flag in rec["flags"]:
            if flag.startswith("model:") and fn.norm(flag[6:]):
                models.setdefault(fn.norm(flag[6:]), (fn.person_name(flag[6:]), set()))[1].add(p["id"])

    contacts = 0
    for client, c in by_client.items():
        pick = lambda counter: sorted(counter, key=lambda n: (-counter[n], -len(n), n))[0]  # noqa: E731
        company = pick(c["companies"]) if c["companies"] else None
        path_name = pick(c["path_names"]) if c["path_names"] else None
        if path_name:
            name, company_name, ctype = path_name, path_name, "developer"
        elif c["contact"]:
            name = pick(c["names"])
            # A company named on at least half of the contact's folders is their company; a contact who brings
            # several projects without one is most likely a channel partner (EST-16). Both stay marked as inferred.
            company_name = company if company and c["companies"][company] * 2 >= c["n"] else None
            ctype = "developer" if company_name else "channel_partner" if len(c["projects"]) >= 2 else "other"
        else:
            name, company_name, ctype = company, company, "developer"
        conn.execute(
            "insert into pulse.client(id,org_id,display_name,company_name,client_type,type_basis,source) "
            "values (%s,%s,%s,%s,%s,'inferred',%s) on conflict(id) do update set "
            "display_name=case when 'display_name'=any(client.locked) then client.display_name else excluded.display_name end,"
            "company_name=case when 'company_name'=any(client.locked) then client.company_name else excluded.company_name end,"
            "client_type=case when 'client_type'=any(client.locked) or client.type_basis='source' then client.client_type else excluded.client_type end,"
            "type_basis=case when 'client_type'=any(client.locked) or client.type_basis='source' then client.type_basis else 'inferred' end",
            (client, org, name, company_name, ctype, CLIENT_SOURCE))
        if not c["contact"]:
            continue
        person = entity_id(org, "person", "client_contact", client)
        side = "channel_partner" if ctype == "channel_partner" else "client"
        conn.execute("insert into pulse.person(id,org_id,display_name,side) values (%s,%s,%s,%s) on conflict(id) do nothing",
                     (person, org, name, side))
        conn.execute(
            "insert into pulse.contact_profile(org_id,person_id,contact_type,source) values (%s,%s,%s,%s) "
            "on conflict(person_id) do update set contact_type=case when 'contact_type'=any(contact_profile.locked) or contact_profile.type_status is not null "
            "then contact_profile.contact_type else excluded.contact_type end",
            (org, person, ctype if ctype != "other" else None, CLIENT_SOURCE))
        conn.execute("update pulse.person p set display_name=%s where id=%s and display_name<>%s and not exists "
                     "(select 1 from pulse.contact_profile cp where cp.person_id=p.id and 'name'=any(cp.locked))",
                     (name, person, name))
        conn.execute("insert into pulse.client_contact(org_id,client_id,person_id,is_primary) values (%s,%s,%s,true) "
                     "on conflict do nothing", (org, client, person))
        conn.execute("update pulse.client set primary_contact_id=%s where id=%s and primary_contact_id is null",
                     (person, client))
        contacts += 1

    for row in updates:         # after the clients exist
        conn.execute(
            "update pulse.project set kind='client_work',project_key=%s,serial_no=%s,start_month=%s,"
            "title=case when %s then title else %s end,location=case when %s then location else %s end,"
            "segment=case when %s then segment else %s end,client_id=case when %s then client_id else %s end "
            "where id=%s", row)
    for key, (name, project_ids) in models.items():
        person = entity_id(org, "person", "talent", key)
        conn.execute("insert into pulse.person(id,org_id,display_name,side) values (%s,%s,%s,'talent') "
                     "on conflict(id) do nothing", (person, org, name))
        conn.execute("insert into pulse.contact_profile(org_id,person_id,contact_type,source) "
                     "values (%s,%s,'talent',%s) on conflict(person_id) do nothing", (org, person, CLIENT_SOURCE))
        for project in project_ids:
            conn.execute("insert into pulse.project_contact(org_id,project_id,person_id,role,source) "
                         "values (%s,%s,%s,'model',%s) on conflict do nothing", (org, project, person, CLIENT_SOURCE))
    return {"client_projects": len(parsed), "internal_folders": len(projects) - len(parsed),
            "clients": len(by_client), "client_contacts": contacts, "talent": len(models),
            "projects_without_client": sum(1 for p, _path_match, _rec in parsed if p["id"] not in keyed),
            "staff_ids_assigned": assign_staff_ids(conn, org)}
