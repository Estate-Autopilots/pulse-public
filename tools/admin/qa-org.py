#!/usr/bin/env python3
"""The QA organisation on a Vitals (Pulse) server: one synthetic person per role, marked test and rehearsal (QA-1 step 1,
owner, 18 Nov 2026: "Yes, start stage 1"; QA-SYSTEM-RESEARCH §4.2 and §6 step 1).

    python3 tools/admin/qa-org.py --approver "Owner Name (owner)" --words "the owner's words" \\
        --dsn-env /etc/estate-autopilots/db/pulse.env:PULSE_DATABASE_URL_MIGRATE [--apply] [--rotate]

  * The company (default @vitalsqa, "Vitals QA (TEST)") is started for the synthetic owner's account with
    pulse.connect_org_create, the app's own function (Owner: admin and leadership). A Pulse platform admin (--as, default
    savuzo, an admin of the install's organisation named in pulse_priv.platform_admin) marks it a test company with
    pulse.platform_org_purpose, so it is never counted among anyone's companies, and it is a rehearsal company (synthetic
    people only; a rehearsal company never sends e-mail).
  * Synthetic Pulse accounts (handle and password; no e-mail address, so nothing can ever be mailed to a real person):
    qa.owner (Owner), qa.admin (admin), qa.saleshead (sales_head), qa.seller (sales), qa.finance (finance), qa.hr (hr).
    Each gets a staff seat and its role the way People → Add person and Settings → Roles make them (as grant-access.py's
    seat), acting as the synthetic owner, and the seat is linked to the account (account_member and an account_link row
    in the company's Audit).
  * The client portal: a client login qa.client (pulse.portal_issue, as the synthetic owner).
  * The AI employee: qa.agent (pulse.agent_create, lane quick, a small daily token budget) and one agent key
    (pulse.agent_key_issue, 90 days, label "QA-1 synthetic").
  * Never: a platform admin seat for any synthetic account, a real person's login, a sign-in or session.
  * Passwords and the agent key are made here, never printed, and written only to --credentials (default
    ~/.config/vitals-qa/production.json, mode 600, its folder 700), after the transaction commits. A run again keeps
    what exists and adds what is missing; --rotate gives every login a new password and the agent a new key (the old
    QA-1 key is revoked).
  * One transaction; without --apply it does everything and rolls back (and writes no file). The platform audit log and
    the company's own Audit record who approved, their words verbatim, and what was made. Runs only on the Pulse server.

Exit codes: 0 done (or the dry run worked); 2 refused; 1 the database failed.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import socket
import sys
import tempfile
from pathlib import Path

import psycopg
import psycopg.sql

APP = "pulse-qa-org"
SCRIPT = "tools/admin/qa-org.py"
DEFAULT_HOSTS = "host-49a12d.internal.example"
HANDLE = re.compile(r"^[a-z0-9][a-z0-9._]{2,29}$")
KEY_LABEL = "QA-1 synthetic"
AGENT_BUDGET = 20000

# key, account handle, name, title, roles granted besides the owner's own (admin and leadership come with the company).
STAFF = (
    ("owner", "qa.owner", "QA Owner (synthetic)", "Owner", ()),
    ("admin", "qa.admin", "QA Admin (synthetic)", "Administrator", ("admin",)),
    ("sales_head", "qa.saleshead", "QA Sales Head (synthetic)", "Sales Head", ("sales_head",)),
    ("seller", "qa.seller", "QA Seller (synthetic)", "Sales Executive", ("sales",)),
    ("finance", "qa.finance", "QA Finance (synthetic)", "Finance", ("finance",)),
    ("hr", "qa.hr", "QA HR (synthetic)", "HR", ("hr",)),
)
CLIENT = ("client", "qa.client", "QA Client (synthetic)")
AGENT = ("agent", "qa.agent", "QA Agent (synthetic)", "QA AI employee")


class Refused(Exception):
    pass


def dsn(args) -> str:
    if args.database:
        return args.database
    path, _, key = (args.dsn_env or "").partition(":")
    if not path or not key:
        raise Refused("give --database or --dsn-env <file>:<variable>")
    with open(path, encoding="utf-8") as f:
        for line in f:
            if line.startswith(key + "="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise Refused(f"{key} is not in {path}")


def password() -> str:
    return secrets.token_urlsafe(24)  # 32 characters


def read_credentials(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}


def write_credentials(path: Path, data: dict) -> Path:
    """Into a mode-600 file beside the target (renamed into place once the transaction committed)."""
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(path.parent, 0o700)
    fd, tmp = tempfile.mkstemp(prefix=".qa-org-", dir=path.parent)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        os.fchmod(f.fileno(), 0o600)
        json.dump(data, f, indent=2, sort_keys=True)
        f.write("\n")
    return Path(tmp)


def enter(c, org, viewer, actor: str) -> None:
    c.execute("""select set_config('pulse.org_id', %s, true), set_config('pulse.viewer_id', %s, true),
                        set_config('pulse.actor_account', %s, true), set_config('pulse.agent_session', '', true)""",
              (str(org), str(viewer or ""), actor))


def platform_seat(c, who: str, actor: str):
    """The acting platform admin's seat, read inside the install's organisation (forced row security: as org-retire.py)."""
    install = c.execute("select pulse.install_org()").fetchone()[0]
    if not install:
        raise Refused("this database has no install organisation (pulse.install)")
    enter(c, install, None, actor)
    seat = c.execute("""select m.person_id, o.name from pulse.org o
          join pulse_priv.account_member m on m.member_org = o.id join pulse_priv.pulse_account a on a.id = m.account_id
          join pulse.person p on p.id = m.person_id and p.org_id = o.id
         where o.id = %s and o.status = 'active' and a.handle = %s and p.status = 'active' and p.side = 'staff' limit 1""",
                     (install, who)).fetchone()
    if not seat:
        raise Refused(f"@{who} has no active staff seat in the install's organisation")
    enter(c, install, seat[0], actor)
    if not c.execute("select pulse.platform_admin()").fetchone()[0]:
        raise Refused(f"@{who} is not a Pulse platform admin (an admin of {seat[1]} named in pulse_priv.platform_admin)")
    return install, seat[0]


def ensure_account(c, handle: str, name: str, secret: str | None) -> tuple[str, bool]:
    """A synthetic Pulse account: handle and password, no e-mail. Returns (id, created). A password is set only when given."""
    row = c.execute("select id, email from pulse_priv.pulse_account where handle = %s", (handle,)).fetchone()
    if row:
        if row[1] is not None:
            raise Refused(f"@{handle} already exists with an e-mail address: it is not one of this tool's synthetic accounts")
        if secret:
            c.execute("""update pulse_priv.pulse_account set password_hash = crypt(%s, gen_salt('bf', 10)), failed = 0,
                           locked_until = null, updated_at = now() where id = %s""", (secret, row[0]))
        return str(row[0]), False
    taken = c.execute("""select exists (select 1 from pulse_priv.handle_name where handle = %s)
                             or exists (select 1 from pulse.org where handle = %s)""", (handle, handle)).fetchone()[0]
    if taken:
        raise Refused(f"@{handle} is taken by someone or something else")
    if not secret:
        raise Refused(f"@{handle} needs a password")
    acct = c.execute("""insert into pulse_priv.pulse_account(handle, display_name, email, password_hash)
                        values (%s, %s, null, crypt(%s, gen_salt('bf', 10))) returning id""", (handle, name, secret)).fetchone()[0]
    c.execute("insert into pulse_priv.handle_name(handle, kind, ref) values (%s, 'person', %s)", (handle, acct))
    return str(acct), True


def ensure_seat(c, org, owner_person, acct: str, handle: str, name: str, title: str, roles, approver: str, actor: str) -> dict:
    """People → Add person and Settings → Roles as the synthetic owner (grant-access.py's seat), then the account link."""
    seat = c.execute("select person_id from pulse_priv.account_member where account_id = %s and member_org = %s",
                     (acct, org)).fetchone()
    created = seat is None
    if created:
        c.execute("select pg_advisory_xact_lock(hashtext('staff-identity:' || %s))", (str(org),))
        if c.execute("select 1 from pulse.people_profile where org_id = pulse.current_org() and username = %s", (handle,)).fetchone():
            raise Refused(f"the username {handle} is already someone else's in this company")
        seat = c.execute("insert into pulse.person(org_id, display_name, side) values (pulse.current_org(), %s, 'staff') returning id",
                         (name,)).fetchone()
        c.execute("""insert into pulse.people_profile(org_id, person_id, role, evidence, user_no, username, email, locked)
                     select pulse.current_org(), %s, %s, %s, coalesce(max(user_no), 0) + 1, %s, null, '{name,role,pod,status}'
                       from pulse.people_profile where org_id = pulse.current_org()""",
                  (seat[0], title, f"Synthetic QA person for the Pulse account @{handle} ({SCRIPT}, approved by {approver}).", handle))
        c.execute("""insert into pulse.record_change(org_id, entity_type, entity_id, field, new_value, changed_by)
                     values (pulse.current_org(), 'person', %s, 'created', %s, %s)""", (seat[0], name, owner_person))
    person = seat[0]
    if not c.execute("select 1 from pulse.person where id = %s and side = 'staff' and status = 'active'", (person,)).fetchone():
        raise Refused(f"@{handle} has a seat here that is not an active staff seat")
    added = []
    for r in roles:
        got = c.execute("""insert into pulse.role_assignment(org_id, person_id, role_key, unit_id, is_manager_of_unit, valid_from)
                           select pulse.current_org(), %s, %s, null, false, current_date
                            where not exists (select 1 from pulse.role_assignment where person_id = %s and role_key = %s
                                               and current_date between valid_from and coalesce(valid_to, 'infinity'))
                           returning person_id""", (person, r, person, r)).fetchone()
        if got:
            c.execute("""insert into pulse.record_change(org_id, entity_type, entity_id, field, old_value, new_value, changed_by)
                         values (pulse.current_org(), 'role', %s, %s, null, 'granted', %s)""", (person, r, owner_person))
            added.append(r)
    if created:
        c.execute("insert into pulse_priv.account_member(account_id, member_org, person_id, kind) values (%s, %s, %s, 'staff')",
                  (acct, org, person))
        c.execute("""insert into pulse.audit_event(org_id, actor_account, action, resource, resource_id, source, changes)
                     values (%s, %s, 'account_link', 'person', %s, 'data-change', jsonb_build_object('account', %s::text, 'why', 'qa_synthetic'))""",
                  (org, actor, str(person), acct))
    return {"person": str(person), "createdSeat": created, "rolesAdded": added}


def roles_of(c, person) -> list[str]:
    return [r[0] for r in c.execute("""select role_key from pulse.role_assignment where person_id = %s
                                        and current_date between valid_from and coalesce(valid_to, 'infinity') order by role_key""",
                                     (person,)).fetchall()]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--org-handle", default="vitalsqa")
    ap.add_argument("--org-name", default="Vitals QA (TEST)")
    ap.add_argument("--as", dest="as_handle", default="savuzo", help="the platform admin who marks it a test company (@handle)")
    ap.add_argument("--approver", required=True, help='who approved, e.g. "Owner Name (owner)"')
    ap.add_argument("--words", required=True, help="the approver's words, verbatim (they go in the audit log)")
    ap.add_argument("--credentials", type=Path, default=Path.home() / ".config/vitals-qa/production.json")
    ap.add_argument("--base-url", default="https://app.vitalsos.ai", help="recorded in the credentials file for the scripts that sign in")
    ap.add_argument("--rotate", action="store_true", help="new passwords for every login and a new agent key")
    ap.add_argument("--apply", action="store_true", help="commit (default: dry run, rolled back, no file written)")
    ap.add_argument("--database")
    ap.add_argument("--dsn-env")
    args = ap.parse_args(argv)

    def refuse(msg: str) -> int:
        print(f"Refused (nothing was written): {msg}", file=sys.stderr)
        return 2

    allowed = {h.strip() for h in os.environ.get("PULSE_ADMIN_TOOL_HOSTS", DEFAULT_HOSTS).split(",") if h.strip()}
    if socket.gethostname() not in allowed:
        return refuse(f"this tool runs only on {', '.join(sorted(allowed))}")
    approver, words = args.approver.strip()[:120], args.words.strip()[:380]
    if len(approver) < 3 or len(words) < 4:
        return refuse("name the approver and give their words")
    org_handle = args.org_handle.strip().lstrip("@").lower()
    who = args.as_handle.strip().lstrip("@").lower()
    org_name = re.sub(r"\s+", " ", args.org_name).strip()
    if not HANDLE.match(org_handle) or not HANDLE.match(who):
        return refuse("--org-handle and --as take handles (3 to 30 lower-case letters, digits, dots or underscores)")
    if not 2 <= len(org_name) <= 80:
        return refuse("--org-name is 2 to 80 characters")
    actor = f"qa-org.py · approver: {approver}"[:120]
    old = read_credentials(args.credentials)
    if old and old.get("org", {}).get("handle") not in (None, org_handle):
        return refuse(f"{args.credentials} holds another QA organisation's logins")
    old_logins = old.get("logins", {})
    logins: dict = {}
    summary: dict = {"applied": args.apply, "org": None, "people": {}}
    tmp: Path | None = None
    try:
        with psycopg.connect(dsn(args), application_name=APP) as c:
            c.execute("set lock_timeout = '15s'")
            c.execute("set statement_timeout = '120s'")
            owner = c.execute("""select pg_get_userbyid(n.nspowner), r.rolsuper, pg_has_role(session_user, n.nspowner, 'SET')
                                   from pg_namespace n, pg_roles r where n.nspname = 'pulse' and r.rolname = session_user""").fetchone()
            if not owner[1]:
                if not owner[2]:
                    raise Refused(f"this login may not act as the schema owner {owner[0]} (use the migrator's)")
                c.execute(psycopg.sql.SQL("set local role {}").format(psycopg.sql.Identifier(owner[0])))
            install, platform_person = platform_seat(c, who, actor)

            # 1. The synthetic accounts. A password is made for a new account, with --rotate, or when the file has none for
            #    it (the file is where the passwords live; nobody else knows them).
            accounts = {}
            for key, handle, name, _title, _roles in STAFF:
                had = old_logins.get(key, {}).get("password")
                secret = password() if args.rotate or not had else None
                accounts[key], _created = ensure_account(c, handle, name, secret)
                logins[key] = {"kind": "staff", "handle": handle, "password": secret or had, "name": name}

            # 2. The company, owned by the synthetic owner (the app's own function), then marked test by the platform admin.
            enter(c, install, platform_person, actor)
            row = c.execute("select id, purpose, status from pulse.org where handle = %s", (org_handle,)).fetchone()
            if row:
                org, created_org = row[0], False
                if row[2] != "active":
                    raise Refused(f"@{org_handle} is {row[2]}")
                if not c.execute("select 1 from pulse_priv.account_member where member_org = %s and account_id = %s",
                                 (org, accounts["owner"])).fetchone():
                    raise Refused(f"@{org_handle} is someone else's organisation")
            else:
                org = c.execute("select pulse.connect_org_create(%s, %s, %s, null)", (accounts["owner"], org_name, org_handle)).fetchone()[0]
                created_org = True
                enter(c, install, platform_person, actor)
            purpose = c.execute("select pulse.platform_org_purpose(%s, 'test', %s)",
                                (org, f"{words} (approved by {approver})")).fetchone()[0]

            # 3. Inside the company, as the synthetic owner (an admin there).
            owner_person = c.execute("select person_id from pulse_priv.account_member where member_org = %s and account_id = %s",
                                     (org, accounts["owner"])).fetchone()[0]
            enter(c, org, owner_person, actor)
            if not c.execute("select pulse.viewer_is('admin')").fetchone()[0]:
                raise Refused(f"@qa.owner is not an admin of @{org_handle}")
            rehearsal = c.execute("update pulse.org set rehearsal = true where id = %s and not rehearsal returning id", (org,)).fetchone()
            for key, handle, name, title, roles in STAFF:
                if key == "owner":
                    summary["people"][key] = {"handle": handle, "person": str(owner_person), "createdSeat": created_org, "rolesAdded": []}
                    continue
                summary["people"][key] = {"handle": handle, **ensure_seat(c, org, owner_person, accounts[key], handle, name, title, roles, approver, actor)}

            # 4. The client portal login.
            ckey, chandle, cname = CLIENT
            had = old_logins.get(ckey, {}).get("password")
            principal = c.execute("select id from pulse_priv.portal_principal where org_id = %s and username = %s", (org, chandle)).fetchone()
            secret = None
            if principal is None or args.rotate or not had:
                secret = password()
                principal = (c.execute("select pulse.portal_issue(%s::uuid, %s, %s, %s)",
                                       (principal[0] if principal else None, chandle, cname, secret)).fetchone()[0],)
                # An issued password must be changed at first sign-in; a synthetic login's password is already its own.
                c.execute("update pulse_priv.portal_principal set must_change = false where id = %s and org_id = %s", (principal[0], org))
            logins[ckey] = {"kind": "client", "username": chandle, "password": secret or had, "name": cname}
            summary["people"][ckey] = {"username": chandle, "principal": str(principal[0]), "newPassword": secret is not None}

            # 5. The AI employee and its key.
            akey, ahandle, aname, atitle = AGENT
            agent = c.execute("""select pp.person_id from pulse.people_profile pp join pulse.person p on p.id = pp.person_id
                                  where pp.org_id = %s and pp.username = %s and p.side = 'agent'""", (org, ahandle)).fetchone()
            agent_created = agent is None
            if agent_created:
                agent = c.execute("select pulse.agent_create(%s::jsonb)", (json.dumps(
                    {"name": aname, "username": ahandle, "title": atitle, "lane": "quick", "ownerId": str(owner_person),
                     "dailyTokenBudget": AGENT_BUDGET}),)).fetchone()
            had = old_logins.get(akey, {}).get("key")
            key = None
            if agent_created or args.rotate or not had:
                for (prefix,) in c.execute("""select prefix from pulse_priv.agent_key where org_id = %s and person_id = %s and label = %s
                                                and revoked_at is null""", (org, agent[0], KEY_LABEL)).fetchall():
                    c.execute("select pulse.agent_key_revoke(%s)", (prefix,))
                key = c.execute("select pulse.agent_key_issue(%s, %s, 90)", (agent[0], KEY_LABEL)).fetchone()[0]
            logins[akey] = {"kind": "agent", "username": ahandle, "key": key or had, "name": aname}
            summary["people"][akey] = {"username": ahandle, "person": str(agent[0]), "created": agent_created, "newKey": key is not None}
            for k, v in summary["people"].items():
                if v.get("person") and k != akey:
                    v["roles"] = roles_of(c, v["person"])

            # 6. The ledger: platform audit log and the company's own Audit, as the platform admin.
            state = c.execute("select name, purpose, rehearsal, status from pulse.org where id = %s", (org,)).fetchone()
            enter(c, install, platform_person, actor)
            detail = {"tool": SCRIPT, "host": socket.gethostname(), "approver": approver, "words": words, "createdOrg": created_org,
                      "people": {k: {x: y for x, y in v.items() if x in ("handle", "username", "createdSeat", "created", "rolesAdded")}
                                 for k, v in summary["people"].items()},
                      "rotate": args.rotate, "applied": args.apply}
            c.execute("select pulse.platform_log('qa.org_setup', %s, 'org', %s, %s, %s, %s::jsonb)",
                      (org, str(org), state[0], f"{words} (approved by {approver})", json.dumps(detail)))
            summary["org"] = {"id": str(org), "handle": org_handle, "name": state[0], "purpose": state[1], "rehearsal": state[2],
                              "status": state[3], "created": created_org, "purposeChange": purpose, "rehearsalSet": rehearsal is not None}
            if args.apply:
                data = {"org": {"id": str(org), "handle": org_handle, "name": state[0]}, "baseUrl": args.base_url,
                        "note": "QA-1 synthetic logins (test and rehearsal company). Never print or commit this file.",
                        "logins": logins}
                tmp = write_credentials(args.credentials, data)
                c.commit()
                os.replace(tmp, args.credentials)
                tmp = None
                summary["credentials"] = str(args.credentials)
            else:
                c.rollback()
    except Refused as e:
        return refuse(str(e))
    except psycopg.Error as e:
        msg = (e.diag.message_primary or str(e)).strip()
        if e.sqlstate in ("42501", "22023", "P0002", "23505"):
            return refuse(msg)
        print(f"The database failed (nothing was written): {msg}", file=sys.stderr)
        return 1
    finally:
        if tmp is not None:
            tmp.unlink(missing_ok=True)
    print(json.dumps(summary, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
