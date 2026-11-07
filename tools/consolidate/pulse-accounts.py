#!/usr/bin/env python3
"""One Pulse account per human across every organisation (CONSOLIDATION, owner, 4 Nov 2026).

"People who exist in several places, e.g. Savuzo with several accounts and usernames, must be merged into ONE account
with one username and seats in each organisation." docs/ops/CONSOLIDATION.md has the order of the whole move.

  inventory         (any Pulse, read only): the people of one install as counts, plus one line per sign-in identity
                    with its e-mail and phone as keyed hashes (HMAC-SHA256, the key from --key-file, never printed), into
                    a root-only file. Nothing personal is printed.
  inventory-report  (anywhere, read only): several inventory files together: counts per install, and the duplicate
                    identity groups by normalised e-mail and phone (sizes and counts only). Rows of the owner's own
                    accounts (--owner-email / --owner-name) are shown in full, nobody else's.
  plan              (the shared Pulse, read only): who is one human (pulse.account_merge_candidates, 1535: the same
                    verified e-mail only), which account stays, which username it keeps (the rule below), the seats that
                    move, the people to link and anything that needs a person's decision. Writes plan.json.
  merge             (the shared Pulse): the plan, in one transaction through pulse.account_merge. Dry run unless
                    --apply (then --approver, --issue and --words, and a pg_dump first). Writes every merge record (ids
                    and handles, never a password hash) to records-<time>.json: the input of unmerge.
  unmerge           (the shared Pulse): puts merges back from their records (pulse.account_unmerge). Dry run unless --apply.

The username rule (for each human, in order): an explicit --handle <account id or @handle>=<handle> wins; otherwise
the handle without a trailing number (a number is what Pulse adds to make a handle unique, so "savuzo" beats
"savuzo2"); then the kept account's; then the shortest; then a to z. The kept account is the one whose own proven
e-mail is the shared one, then the one with the most seats, then the one used most recently, then the oldest. Every
other handle the human had stays reserved and keeps pointing at them (pulse_priv.handle_name), so @old still finds
them and nobody else can take it.

Never merged automatically: two accounts that both hold a seat in the same organisation (two person rows there: HR
decides which one stays; --same-org unlink keeps the kept account's seat and leaves the other person without an
account), and look-alikes on a name or an unverified e-mail (1291 lists those for HR).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shlex
import subprocess
import sys
from collections import defaultdict
from datetime import UTC, datetime
from pathlib import Path

APP = "pulse-accounts"
SCRIPT = "tools/consolidate/pulse-accounts.py"
HANDLE_RE = re.compile(r"^[a-z0-9][a-z0-9._]{2,29}$")
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


def now() -> str:
    return datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")


def lit(value: object) -> str:
    return "'" + str(value).replace("'", "''") + "'"


class Pg:
    """psql (inside a database container, or a local connection string), SQL on stdin; nothing secret on argv."""

    def __init__(self, runner: str, user: str, database: str) -> None:
        self.runner = shlex.split(runner)
        self.user, self.database = user, database

    def argv(self, *tool: str) -> list[str]:
        runner = list(self.runner)
        if runner[:2] == ["docker", "exec"]:
            runner[2:2] = ["-e", f"PGAPPNAME={APP}"]
        conn = ["-U", self.user, "-d", self.database] if self.user else ["-d", self.database]
        return [*runner, tool[0], *conn, *tool[1:]]

    def psql(self, script: str, *, check: bool = True) -> tuple[str, str, int]:
        proc = subprocess.run(
            self.argv("psql", "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1"),
            input=script.encode("utf-8"), capture_output=True, check=False,
        )
        out, err = proc.stdout.decode("utf-8", "replace"), proc.stderr.decode("utf-8", "replace")
        if check and proc.returncode != 0:
            raise SystemExit(f"psql failed ({proc.returncode}): {err.strip()[-2000:]}")
        return out, err, proc.returncode

    def json_lines(self, script: str) -> list:
        out, _, _ = self.psql(script)
        return [json.loads(x) for x in out.splitlines() if x.startswith(("{", "["))]


def private_file(path: Path, data: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(data)
    return path


def mask(email: str | None) -> str:
    if not email or "@" not in email:
        return "-"
    user, _, dom = email.partition("@")
    return f"{user[:1]}***@{dom}"


# --------------------------------------------------------------------------------------------- inventory
INVENTORY = r"""
begin isolation level repeatable read read only;
select json_build_object('k', 'org', 'id', id, 'handle', handle, 'name', name, 'status', status)::text from pulse.org;
with p as (
  select p.id, p.org_id, p.side, p.status, p.display_name, pp.username,
         nullif(lower(btrim(pp.email)), '') e1, nullif(lower(btrim(pv.work_email)), '') e2,
         nullif(right(regexp_replace(coalesce(nullif(pp.phone, ''), pv.phone_e164, ''), '\D', '', 'g'), 10), '') ph,
         exists (select 1 from pulse.login_credential lc where lc.person_id = p.id and lc.status = 'active') pw,
         {acct_seat} acct
    from pulse.person p left join pulse.people_profile pp on pp.person_id = p.id
    left join pulse_priv.person_private pv on pv.person_id = p.id)
select json_build_object('k', 'person', 'org', org_id, 'side', side, 'status', status, 'pw', pw, 'acct', acct,
  'e1', case when e1 is not null then encode(hmac(e1, :'key', 'sha256'), 'hex') end,
  'e2', case when e2 is not null and e2 is distinct from e1 then encode(hmac(e2, :'key', 'sha256'), 'hex') end,
  'ph', case when length(ph) = 10 then encode(hmac(ph, :'key', 'sha256'), 'hex') end,
  'owner', {owner_p},
  'show', case when {owner_p} then json_build_object('id', id, 'name', display_name, 'username', username, 'email', coalesce(e1, e2)) end)::text
  from p;
{accounts}
rollback;
"""
ACCOUNTS = r"""
select json_build_object('k', 'account', 'verified', coalesce(a.email_verified_at, a.email_confirmed_at) is not null,
  'members', (select count(*) from pulse_priv.account_member m where m.account_id = a.id),
  'e1', case when a.email is not null then encode(hmac(lower(btrim(a.email)), :'key', 'sha256'), 'hex') end,
  'owner', {owner_a},
  'show', case when {owner_a} then json_build_object('id', a.id, 'handle', a.handle, 'name', a.display_name, 'email', a.email,
     'seats', (select json_agg(json_build_object('org', o.handle, 'person', m.person_id, 'kind', m.kind))
                 from pulse_priv.account_member m join pulse.org o on o.id = m.member_org where m.account_id = a.id)) end)::text
  from pulse_priv.pulse_account a;
"""


def owner_test(emails: list[str], names: list[str], cols: dict) -> str:
    parts = [f"{c} in ({', '.join(lit(e.lower()) for e in emails)})" for c in cols["email"]] if emails else []
    for n in names:
        # a username or handle that is the name, maybe with Pulse's trailing number or a suffix (savuzo, savuzo2,
        # savuzo.k): never a display-name match, which could show someone else who shares the name
        parts += [f"lower({c}) ~ {lit('^' + re.escape(n.lower().lstrip('@')) + '([0-9._-].*)?$')}" for c in cols["name"]]
    return "coalesce((" + " or ".join(parts) + "), false)" if parts else "false"


def cmd_inventory(args: argparse.Namespace) -> int:
    key = Path(args.key_file).read_text(encoding="utf-8").strip()
    if len(key) < 32:
        raise SystemExit("--key-file needs at least 32 characters (one key for every install of one inventory)")
    pg = Pg(args.exec, args.db_user, args.database)
    has = json.loads(pg.psql("select json_build_object('accounts', to_regclass('pulse_priv.pulse_account') is not null, "
                             "'pgcrypto', exists (select 1 from pg_extension where extname = 'pgcrypto'), "
                             "'sees_all', (select rolsuper or rolbypassrls from pg_roles where rolname = current_user));")[0].strip())
    if not has["pgcrypto"]:
        raise SystemExit("pgcrypto is not installed here; the inventory needs hmac()")
    if not has["sees_all"]:
        # Organisation tables force row security: any other role would count only one organisation (or none).
        raise SystemExit("the inventory reads every organisation: connect as the database superuser (--db-user)")
    emails, names = args.owner_email or [], args.owner_name or []
    owner_p = owner_test(emails, names, {"email": ["e1", "e2"], "name": ["username"]})
    owner_a = owner_test(emails, names, {"email": ["lower(a.email)"], "name": ["a.handle"]})
    sql = f"\\set key {lit(key)}\n" + INVENTORY.format(
        acct_seat="exists (select 1 from pulse_priv.account_member am where am.person_id = p.id)" if has["accounts"] else "false",
        owner_p=owner_p,
        accounts=ACCOUNTS.format(owner_a=owner_a) if has["accounts"] else "",
    )
    rows = pg.json_lines(sql)
    for r in rows:
        r["instance"] = args.label
    out = private_file(Path(args.out), "\n".join(json.dumps(r) for r in rows) + "\n")
    kinds = defaultdict(int)
    for r in rows:
        kinds[r["k"]] += 1
    print(f"inventory {args.label}: " + ", ".join(f"{k} {v}" for k, v in sorted(kinds.items())) + f" -> {out} (mode 600)")
    return 0


def is_identity(r: dict) -> bool:
    """A sign-in identity: an account, or a person who can sign in (an active password or an account seat), or an active
    staff member or freelancer."""
    if r["k"] == "account":
        return True
    return r["k"] == "person" and (r["pw"] or r["acct"] or (r["status"] == "active" and r["side"] in ("staff", "freelancer")))


def groups_of(rows: list[dict]) -> list[list[int]]:
    parent = list(range(len(rows)))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    first: dict[str, int] = {}
    for i, r in enumerate(rows):
        for key in ("e1", "e2", "ph"):
            v = r.get(key)
            if not v:
                continue
            tag = ("e:" if key != "ph" else "p:") + v
            if tag in first:
                parent[find(i)] = find(first[tag])
            else:
                first[tag] = i
    comp: dict[int, list[int]] = defaultdict(list)
    for i in range(len(rows)):
        comp[find(i)].append(i)
    return [c for c in comp.values() if len(c) > 1]


def cmd_inventory_report(args: argparse.Namespace) -> int:
    rows: list[dict] = []
    for f in args.files:
        rows += [json.loads(x) for x in Path(f).read_text(encoding="utf-8").splitlines() if x.strip()]
    orgs = {(r["instance"], r["id"]): r for r in rows if r["k"] == "org"}
    print("== People inventory (counts only)")
    for inst in sorted({r["instance"] for r in rows}):
        mine = [r for r in rows if r["instance"] == inst]
        people = [r for r in mine if r["k"] == "person"]
        print(f"{inst}: organisations {sum(1 for r in mine if r['k'] == 'org')}; people {len(people)} "
              f"(active staff {sum(1 for r in people if r['side'] == 'staff' and r['status'] == 'active')}, "
              f"freelancers {sum(1 for r in people if r['side'] == 'freelancer')}, clients {sum(1 for r in people if r['side'] == 'client')}, "
              f"other {sum(1 for r in people if r['side'] not in ('staff', 'freelancer', 'client'))}); "
              f"can sign in {sum(1 for r in people if r['pw'] or r['acct'])}; accounts {sum(1 for r in mine if r['k'] == 'account')} "
              f"(proven e-mail {sum(1 for r in mine if r['k'] == 'account' and r['verified'])})")
        for (i, oid), o in sorted(orgs.items()):
            if i == inst:
                op = [r for r in people if r["org"] == oid]
                print(f"   @{o['handle'] or '-'} ({o['status']}): people {len(op)}, active staff "
                      f"{sum(1 for r in op if r['side'] == 'staff' and r['status'] == 'active')}, can sign in {sum(1 for r in op if r['pw'] or r['acct'])}")
    for label, pick in (("sign-in identities", is_identity), ("all person records", lambda r: r["k"] == "person")):
        sel = [r for r in rows if pick(r)]
        gs = groups_of(sel)
        by_e = groups_of([{**r, "ph": None} for r in sel])
        by_p = groups_of([{**r, "e1": None, "e2": None} for r in sel])
        sizes = defaultdict(int)
        for g in gs:
            sizes[len(g)] += 1
        cross = sum(1 for g in gs if len({sel[i]["instance"] for i in g}) > 1)
        cross_org = sum(1 for g in gs if len({(sel[i]["instance"], sel[i].get("org")) for i in g if sel[i]["k"] == "person"}) > 1)
        multi_acct = sum(1 for g in gs if sum(1 for i in g if sel[i]["k"] == "account") > 1)
        print(f"== Duplicate groups among {label} ({len(sel)} records)")
        print(f"   groups {len(gs)} (by e-mail {len(by_e)}, by phone {len(by_p)}); records in groups {sum(len(g) for g in gs)}; "
              f"sizes {dict(sorted(sizes.items()))}")
        print(f"   across installs {cross}; across organisations {cross_org}; with more than one Pulse account {multi_acct}")
    owner = [r for r in rows if r.get("owner")]
    if owner:
        print("== The owner's own records (shown in full: --owner-email / --owner-name)")
        for r in owner:
            s = r.get("show") or {}
            where = orgs.get((r["instance"], r.get("org")), {}).get("handle") if r["k"] == "person" else "-"
            print(f"   {r['instance']:<8} {r['k']:<8} org @{where or '-'}: " + json.dumps(s, default=str))
    return 0


# --------------------------------------------------------------------------------------------- plan
def choose(group: dict, overrides: dict) -> dict:
    accounts = group["accounts"]

    def last_used(a: dict) -> str:
        return max([s.get("last_used_at") or "" for s in a["seats"]] or [""])

    keep = min(accounts, key=lambda a: (not a["own_email"], -len(a["seats"]), _neg(last_used(a)), a["created_at"], a["id"]))
    handles = [a["handle"] for a in accounts]
    forced = next((overrides[k] for k in [a["id"] for a in accounts] + handles if k in overrides), None)
    handle = forced or min(handles, key=lambda h: (bool(re.search(r"\d+$", h)), h != keep["handle"], len(h), h))
    return {"keep": keep, "handle": handle, "forced": bool(forced)}


def _neg(s: str) -> str:
    """Sort key for 'most recent first' on ISO timestamps."""
    return "".join(chr(0x10FFFF - ord(c)) for c in s) if s else "\U0010ffff"


def build_plan(groups: list[dict], overrides: dict) -> list[dict]:
    """One entry per human: groups that share an account are one human (union by account id)."""
    parent: dict[str, str] = {}

    def find(x: str) -> str:
        parent.setdefault(x, x)
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for gi, g in enumerate(groups):
        node = f"g{gi}"
        find(node)
        for a in g["accounts"]:
            parent[find("a" + a["id"])] = find(node)
    humans: dict[str, list[dict]] = defaultdict(list)
    for gi, g in enumerate(groups):
        humans[find(f"g{gi}")].append(g)
    plan = []
    for gs in humans.values():
        accounts = {a["id"]: a for g in gs for a in g["accounts"]}
        unlinked = {(u["org"], u["person"]): u for g in gs for u in g["unlinked"]}
        merged = {"emails": sorted({g["email"] for g in gs}), "accounts": list(accounts.values()), "unlinked": list(unlinked.values())}
        entry: dict = {"emails_masked": [mask(e) for e in merged["emails"]], "email_hashes": [hashlib.sha256(e.encode()).hexdigest()[:12] for e in merged["emails"]]}
        if not accounts:
            entry.update(action="create-and-link", note="no Pulse account yet: one is made at first sign-in (or by the 1291 rule); nothing merged here",
                         unlinked=merged["unlinked"])
            plan.append(entry)
            continue
        c = choose(merged, overrides)
        keep = c["keep"]
        drops = [a for a in accounts.values() if a["id"] != keep["id"]]
        # the account that holds the chosen handle (if not the kept one) is merged last, with that handle
        drops.sort(key=lambda a: a["handle"] == c["handle"])
        keep_orgs = {s["org"] for s in keep["seats"]}
        clashes = []
        seen = set(keep_orgs)
        for a in drops:
            for s in a["seats"]:
                if s["org"] in seen:
                    clashes.append({"org": s["org"], "person": s["person"], "account": a["id"], "handle": a["handle"]})
                seen.add(s["org"])
        links = [u for u in merged["unlinked"] if u["org"] not in seen]
        entry.update(
            action="merge" if drops else "link",
            keep={"id": keep["id"], "handle": keep["handle"]},
            handle=c["handle"], handle_forced=c["forced"],
            drop=[{"id": a["id"], "handle": a["handle"], "seats": len(a["seats"])} for a in drops],
            seats_after=len(seen), same_org=clashes, link=links,
            skipped_links=[u for u in merged["unlinked"] if u["org"] in seen],
        )
        plan.append(entry)
    return sorted(plan, key=lambda e: (e["action"], e.get("handle", "")))


def overrides_of(args: argparse.Namespace) -> dict:
    out = {}
    for item in args.handle or []:
        k, _, v = item.partition("=")
        k, v = k.strip().lstrip("@").lower(), v.strip().lstrip("@").lower()
        if not HANDLE_RE.match(v) or not (UUID_RE.match(k) or HANDLE_RE.match(k)):
            raise SystemExit("--handle is <account id or current @handle>=<new handle>")
        out[k] = v
    return out


def candidates(pg: Pg) -> list[dict]:
    rows = pg.json_lines("begin read only;\nselect pulse.account_merge_candidates()::text;\nrollback;\n")
    return rows[0] if rows else []


def print_plan(plan: list[dict], same_org: str) -> None:
    acts = defaultdict(int)
    for e in plan:
        acts[e["action"]] += 1
    print(f"plan: {len(plan)} human(s) found on more than one account or seat: " + ", ".join(f"{k} {v}" for k, v in sorted(acts.items())))
    for e in plan:
        if e["action"] == "create-and-link":
            print(f"  - {', '.join(e['emails_masked'])}: {len(e['unlinked'])} unlinked seat(s); {e['note']}")
            continue
        drops = ", ".join(f"@{d['handle']} ({d['seats']} seat(s))" for d in e["drop"]) or "none"
        print(f"  - {', '.join(e['emails_masked'])}: keep @{e['keep']['handle']} -> username @{e['handle']}"
              f"{' (given)' if e['handle_forced'] else ''}; merge {drops}; link {len(e['link'])} seat(s); seats after {e['seats_after']}")
        for c in e["same_org"]:
            print(f"      ! @{c['handle']} also has a seat in organisation {c['org']} (person {c['person']}): "
                  + ("the kept seat stays, that person keeps no account (same-org unlink)" if same_org == "unlink" else "STOP: needs a decision (HR), or --same-org unlink"))


def cmd_plan(args: argparse.Namespace) -> int:
    pg = Pg(args.exec, args.db_user, args.database)
    plan = build_plan(candidates(pg), overrides_of(args))
    print_plan(plan, args.same_org)
    out = private_file(Path(args.out_dir) / f"plan-{now()}.json", json.dumps(plan, indent=1, default=str))
    print(f"plan written to {out} (mode 600)")
    blocked = [e for e in plan if e.get("same_org") and args.same_org != "unlink"]
    return 3 if blocked else 0


# --------------------------------------------------------------------------------------------- merge / unmerge
def snapshot(pg: Pg, backups: Path, label: str) -> Path:
    backups.mkdir(parents=True, exist_ok=True)
    path = backups / f"pulse-before-{label}-{now()}.dump"
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as out:
        code = subprocess.run(pg.argv("pg_dump", "-Fc"), stdout=out, check=False).returncode
    if code != 0 or path.stat().st_size < 10_000:
        raise SystemExit(f"Snapshot failed ({code}); nothing was changed: {path}")
    return path


def actor_of(args: argparse.Namespace, what: str) -> str:
    return (f"Data change {SCRIPT} {what} · approver: {args.approver or 'dry run'} · issue: {args.issue or 'none'} · "
            f"words: {args.words or 'none'}")[:300]


def merge_script(plan: list[dict], actor: str, same_org: str, apply: bool) -> str:
    out = ["\\set ON_ERROR_STOP on", "begin;", "set local lock_timeout = '15s';",
           f"do $a$ begin perform set_config('pulse.actor_account', {lit(actor)}, true); end $a$;"]
    for e in plan:
        if e["action"] not in ("merge", "link"):
            continue
        if e["same_org"] and same_org != "unlink":
            continue
        keep = e["keep"]["id"]
        for d in e["drop"]:
            handle = e["handle"] if d["handle"] == e["handle"] or d is e["drop"][-1] else e["keep"]["handle"]
            out.append(f"select json_build_object('merge', pulse.account_merge({lit(keep)}::uuid, {lit(d['id'])}::uuid, {lit(handle)}, {lit(actor)}, {lit(same_org)}))::text;")
        if not e["drop"] and e["handle"] != e["keep"]["handle"]:
            out.append(f"-- @{e['keep']['handle']}: one account already; the username stays (rename it in Settings if wanted)")
        for u in e["link"]:
            out.append(f"""do $l$ begin
  perform pulse.acct_enter({lit(u['org'])}::uuid, null);
  if exists (select 1 from pulse.person where id = {lit(u['person'])}::uuid and status = 'active')
     and not exists (select 1 from pulse_priv.account_member where person_id = {lit(u['person'])}::uuid)
     and not exists (select 1 from pulse_priv.account_member where account_id = {lit(keep)}::uuid and member_org = {lit(u['org'])}::uuid) then
    insert into pulse_priv.account_member(account_id, member_org, person_id, kind)
    select {lit(keep)}::uuid, {lit(u['org'])}::uuid, {lit(u['person'])}::uuid, pulse.acct_kind(side) from pulse.person where id = {lit(u['person'])}::uuid;
    insert into pulse.audit_event(org_id, actor_account, action, resource, resource_id, source, changes)
    values ({lit(u['org'])}::uuid, {lit(actor)}, 'account_link', 'person', {lit(u['person'])}, 'data-change',
            jsonb_build_object('account', {lit(keep)}, 'why', 'verified_email'));
    raise notice 'LINK %', json_build_object('account', {lit(keep)}, 'org', {lit(u['org'])}, 'person', {lit(u['person'])});
  end if;
  perform pulse.acct_leave();
end $l$;""")
    out.append("select json_build_object('after', json_build_object('accounts', (select count(*) from pulse_priv.pulse_account), "
               "'seats', (select count(*) from pulse_priv.account_member)))::text;")
    out.append("commit;" if apply else "rollback;")
    return "\n".join(out) + "\n"


def need_approval(args: argparse.Namespace) -> None:
    if args.apply and not (args.approver.strip() and args.words.strip() and args.issue.strip()):
        raise SystemExit("--apply needs --approver, --words (verbatim) and --issue")


def cmd_merge(args: argparse.Namespace) -> int:
    need_approval(args)
    pg = Pg(args.exec, args.db_user, args.database)
    plan = json.loads(Path(args.plan).read_text(encoding="utf-8")) if args.plan else build_plan(candidates(pg), overrides_of(args))
    if args.only:
        plan = [e for e in plan if e.get("keep", {}).get("handle") in args.only or e.get("handle") in args.only]
    print_plan(plan, args.same_org)
    before = pg.json_lines("select json_build_object('accounts', (select count(*) from pulse_priv.pulse_account), 'seats', (select count(*) from pulse_priv.account_member))::text;")[0]
    print(f"before: {before['accounts']} accounts, {before['seats']} seats")
    if args.apply:
        print(f"snapshot: {snapshot(pg, Path(args.backups), 'account-merge')}")
    out, err, _ = pg.psql(merge_script(plan, actor_of(args, "merge"), args.same_org, args.apply))
    rows = [json.loads(x) for x in out.splitlines() if x.startswith("{")]
    records = [r["merge"] for r in rows if "merge" in r]
    links = [json.loads(x.split("LINK ", 1)[1]) for x in err.splitlines() if "LINK {" in x]
    after = next((r["after"] for r in rows if "after" in r), {})
    rec = private_file(Path(args.out_dir) / f"records-{'apply' if args.apply else 'dryrun'}-{now()}.json",
                       json.dumps({"applied": args.apply, "records": records, "links": links}, indent=1, default=str))
    moved = sum(len(r["seats"]) for r in records)
    print(f"{'APPLIED' if args.apply else 'DRY RUN (rolled back)'}: {len(records)} account(s) merged, {moved} seat(s) moved, "
          f"{sum(len(r['unlinked']) for r in records)} unlinked, {len(links)} seat(s) linked; "
          f"after: {after.get('accounts')} accounts, {after.get('seats')} seats")
    print(f"  expected: accounts {before['accounts']} - {len(records)} = {before['accounts'] - len(records)}; "
          f"seats {before['seats']} - {sum(len(r['unlinked']) for r in records)} + {len(links)} = "
          f"{before['seats'] - sum(len(r['unlinked']) for r in records) + len(links)}")
    print(f"  records (the input of unmerge): {rec}")
    ok = after.get("accounts") == before["accounts"] - len(records) and after.get("seats") == before["seats"] - sum(len(r["unlinked"]) for r in records) + len(links)
    return 0 if ok else 1


def cmd_unmerge(args: argparse.Namespace) -> int:
    need_approval(args)
    pg = Pg(args.exec, args.db_user, args.database)
    data = json.loads(Path(args.records).read_text(encoding="utf-8"))
    if not data.get("applied"):
        raise SystemExit("these records are from a dry run: nothing to put back")
    records = [r for r in data["records"] if not args.only or r["handle"] in args.only or r["drop"] in args.only]
    actor = actor_of(args, "unmerge")
    sql = ["\\set ON_ERROR_STOP on", "begin;", f"do $a$ begin perform set_config('pulse.actor_account', {lit(actor)}, true); end $a$;"]
    # newest merge first
    for r in reversed(records):
        sql.append(f"select json_build_object('unmerge', pulse.account_unmerge({lit(json.dumps(r, default=str))}::jsonb, {lit(actor)}))::text;")
    for x in data.get("links", []) if not args.only else []:
        sql.append(f"delete from pulse_priv.account_member where account_id = {lit(x['account'])}::uuid and person_id = {lit(x['person'])}::uuid;")
    sql.append("commit;" if args.apply else "rollback;")
    if args.apply:
        print(f"snapshot: {snapshot(pg, Path(args.backups), 'account-unmerge')}")
    out, _, _ = pg.psql("\n".join(sql) + "\n")
    done = [json.loads(x)["unmerge"] for x in out.splitlines() if x.startswith("{")]
    for d in done:
        print(f"  restored account {d['restored']} beside {d['kept']}: {d['rows_moved_back']} row(s) moved back"
              + (f"; not restored (held secrets): {d['not_restored']}" if d["not_restored"] else ""))
    print(f"{'APPLIED' if args.apply else 'DRY RUN (rolled back)'}: {len(done)} merge(s) put back")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)

    def common(p: argparse.ArgumentParser) -> None:
        p.add_argument("--exec", default="docker exec -i ea-postgres", help='how to reach psql ("" for a local psql)')
        p.add_argument("--db-user", default="ea_admin", help='("" when --database is a connection string)')
        p.add_argument("--database", default="pulse")

    i = sub.add_parser("inventory", help="one install's people: counts and keyed hashes (read only)")
    common(i)
    i.add_argument("--label", required=True, help="a name for this install: ea, wl, ac-old")
    i.add_argument("--key-file", required=True, help="the HMAC key (same file for every install; root only)")
    i.add_argument("--out", required=True)
    i.add_argument("--owner-email", action="append", help="the owner's own e-mail (shown in full in the report)")
    i.add_argument("--owner-name", action="append", help="the owner's username stem, e.g. savuzo (matches savuzo, savuzo2, savuzo.k; shown in full)")
    i.set_defaults(fn=cmd_inventory)

    r = sub.add_parser("inventory-report", help="counts and duplicate groups across inventory files")
    r.add_argument("files", nargs="+")
    r.set_defaults(fn=cmd_inventory_report)

    for name, fn, helptext in (("plan", cmd_plan, "who is one human, and what a merge would do (read only)"),
                               ("merge", cmd_merge, "merge them (dry run unless --apply)")):
        p = sub.add_parser(name, help=helptext)
        common(p)
        p.add_argument("--handle", action="append", help="<account id or current @handle>=<username to keep>")
        p.add_argument("--same-org", choices=("refuse", "unlink"), default="refuse")
        p.add_argument("--out-dir", default="/root/consolidation")
        p.set_defaults(fn=fn)
        if name == "merge":
            p.add_argument("--plan", default="", help="a plan.json from plan (default: plan again now)")
            p.add_argument("--only", action="append", help="only the human with this kept or chosen @handle")
            p.add_argument("--apply", action="store_true")
            p.add_argument("--approver", default="")
            p.add_argument("--issue", default="")
            p.add_argument("--words", default="")
            p.add_argument("--backups", default="/var/backups/pulse")

    u = sub.add_parser("unmerge", help="put merges back from their records (dry run unless --apply)")
    common(u)
    u.add_argument("--records", required=True)
    u.add_argument("--only", action="append", help="only the merge with this username or dropped account id")
    u.add_argument("--apply", action="store_true")
    u.add_argument("--approver", default="")
    u.add_argument("--issue", default="")
    u.add_argument("--words", default="")
    u.add_argument("--backups", default="/var/backups/pulse")
    u.set_defaults(fn=cmd_unmerge)

    args = ap.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
