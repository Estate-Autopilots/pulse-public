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
  * --profile long (QA-1D step 4b, dev only: refused on the production database or address): the long-name QA company
    @vitalsqalong with qal.owner, qal.admin, qal.saleshead, qal.seller, qal.finance, qal.hr, qal.client and qal.agent,
    whose names run past 40 characters, in English, Hindi and Marathi; credentials default to
    ~/.config/vitals-qa/dev-long.json. tools/qa/vitals/long-org.mjs then fills it through the app's API.
  * --profile demo (DEMO-PULSE-2, the investor demo of 20 Nov 2026): the demo company @suryodaydemo, "Suryoday Solar
    (Demo)", test + rehearsal like @vitalsqa, with its own synthetic people under believable names (demo.owner,
    demo.admin, demo.saleshead, demo.seller, demo.finance, demo.hr; no e-mail) and no client login or generic AI
    employee. Production is allowed; @vitalsqa and the qa.* logins are not touched. Credentials default to
    ~/.config/vitals-qa/demo.json.

A one-time sign-in link for a QA person (QA-1B, PC orchestrator 18 Nov 2026: the Mac signs qa.seller in on an iPhone
without anyone typing a password):

    python3 tools/admin/qa-org.py signin-link qa.seller [--org-handle vitalsqa] [--out <file>] [--code-out <file>] [--dry-run]

  * The existing one-time staff sign-in link (PEOPLE-CONTACTS: /login/link#<token>, 15 minutes, once, two-step still
    asked; pulse.auth_link_make 'signin'), minted as the company's synthetic owner. Never e-mailed: the link alone is
    written to --out (default ~/ea-research/flow/to-mac/QA-SIGNIN-LINK.md, mode 600, replaced), never printed.
  * Only for a synthetic person of a QA company: a Pulse account with that handle, no e-mail address, every company of
    it a test + rehearsal one, an active staff seat with that username in the active one named (default: their one QA
    company, e.g. @vitalsqa for qa.*, @suryodaydemo for demo.*), not a platform admin. Anyone else is refused. The
    company's synthetic owner (qa.owner, qal.owner or demo.owner) issues it.
  * A link signs a seat in only when the seat has an active company credential; a QA seat (an account password only) is
    given one with an unusable password (made here, never kept), so its own password and sign-in stay as they were.
  * SIGNIN-CODE (19 Nov 2026: on an iPhone a link opens Safari, not the installed home-screen app): the link's
    8-character code (db 2399: the same sign-in, typed in the app under "Have a sign-in code?" with the username) is
    written alone, as 7KQM-2RXD, to --code-out (default: --out's name with LINK as CODE, e.g. QA-SIGNIN-CODE.md, mode
    600, replaced), never printed.
  * A newer link replaces the older one (and its code). The company's Audit records it (and the account history shows
    it was issued).
  * Default database: the migrator login of /etc/estate-autopilots/db/pulse.env; --base-url defaults to the
    credentials file's (https://app.vitalsos.ai).

Exit codes: 0 done (or the dry run worked); 2 refused; 1 the database failed.
"""

from __future__ import annotations

import argparse
import hashlib
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
# QA-1D step 4b (QA-SYSTEM-RESEARCH §4.4 R14, §6 step 4): the "long" QA company, on DEV only. The same roles, with the
# names real companies have and fixtures never do: 40 characters and more, one unbroken 28-letter word, Hindi and Marathi
# (Devanagari), long titles. Its records (people, clients, projects, tasks, quotations in every stage with crore amounts)
# are filled through the app's own API by tools/qa/vitals/long-org.mjs.
LONG_STAFF = (
    ("owner", "qal.owner", "Venkatanarasimharajuvaripeta Subrahmanyam", "Founder, Managing Director & Chief Executive Officer", ()),
    ("admin", "qal.admin", "Chandrashekharan Radhakrishnan-Iyengar QA", "Head of Administration, Compliance & Office Operations", ("admin",)),
    ("sales_head", "qal.saleshead", "राजेश्वरी प्रसाद श्रीवास्तव-चतुर्वेदी (बिक्री प्रमुख)",
     "Senior Vice President – Business Development (West & Central)", ("sales_head",)),
    ("seller", "qal.seller", "Aishwaryalakshmi Bhagyashree Dorugohum-Kireteso",
     "Senior Relationship Manager – Premium Residential Projects", ("sales",)),
    ("finance", "qal.finance", "श्रीनिवास गोपाळराव देशमुख-पाटील (वित्त व लेखा विभाग)",
     "Chief Financial Officer & Head of Accounts, Taxation and Treasury", ("finance",)),
    ("hr", "qal.hr", "Morisuro Abdul Rahman Siddiqui Qipedot-Khan", "Head of People, Culture, Talent Acquisition & Payroll", ("hr",)),
)
LONG_CLIENT = ("client", "qal.client", "Sahyadri Infrastructure & Township Developers LLP")
LONG_AGENT = ("agent", "qal.agent", "दीर्घ नाम सहायक – Long-Name QA AI Employee (synthetic)", "AI employee for long-name, Hindi and Marathi checks")
# DEMO-PULSE-2 (investor demo, 20 Nov 2026; orchestrator for the owner, 19 Nov 05:45 IST: "a separate demo company with a
# believable name ... marked test + rehearsal like the QA org (synthetic people, no e-mail) ... keep the QA org untouched"):
# its own synthetic people with believable names, so @vitalsqa and its logins stay exactly as the QA tools need them. No
# client login and no generic AI employee: the demo's AI employees are copies of Willow Lane's, made with their settings.
DEMO_STAFF = (
    ("owner", "demo.owner", "Asohiv Kireteso", "Managing Director", ()),
    ("admin", "demo.admin", "Sidif Jivop", "Office Administrator", ("admin",)),
    ("sales_head", "demo.saleshead", "Vikram Durineho", "Head of Sales", ("sales_head",)),
    ("seller", "demo.seller", "Ruvin Putig", "Sales Executive", ("sales",)),
    ("finance", "demo.finance", "Porom Bibit", "Accounts Manager", ("finance",)),
    ("hr", "demo.hr", "Meera Iyer", "HR Manager", ("hr",)),
)
PROFILES = {
    "standard": {"org_handle": "vitalsqa", "org_name": "Vitals QA (TEST)", "staff": STAFF, "client": CLIENT, "agent": AGENT,
                 "key_label": KEY_LABEL, "credentials": Path.home() / ".config/vitals-qa/production.json",
                 "base_url": "https://app.vitalsos.ai", "dev_only": False},
    "long": {"org_handle": "vitalsqalong", "org_name": "Vitals QA लंबे नाम – Long-Name Stress Company (TEST)", "staff": LONG_STAFF,
             "client": LONG_CLIENT, "agent": LONG_AGENT, "key_label": "QA-1 synthetic (long)",
             "credentials": Path.home() / ".config/vitals-qa/dev-long.json", "base_url": "https://dev.vitalsos.ai", "dev_only": True},
    "demo": {"org_handle": "suryodaydemo", "org_name": "Suryoday Solar (Demo)", "staff": DEMO_STAFF, "client": None, "agent": None,
             "key_label": None, "credentials": Path.home() / ".config/vitals-qa/demo.json",
             "base_url": "https://app.vitalsos.ai", "dev_only": False},
}
OWNER_HANDLES = tuple(dict.fromkeys(p["staff"][0][1] for p in PROFILES.values()))
PRODUCTION_DATABASES = {"pulse"}
PRODUCTION_HOSTS = {"app.vitalsos.ai"}
DEFAULT_DSN_ENV = "/etc/estate-autopilots/db/pulse.env:PULSE_DATABASE_URL_MIGRATE"
LINK_OUT = Path.home() / "ea-research/flow/to-mac/QA-SIGNIN-LINK.md"
LINK_CODE = re.compile(r"^[2-9ABCDEFGHJKMNPQRSTVWXYZ]{8}$")


def code_out_for(out: Path) -> Path:
    """Where the code goes when --code-out is not given: beside the link, LINK in the name as CODE (else -CODE added)."""
    return out.with_name(out.name.replace("LINK", "CODE")) if "LINK" in out.name else out.with_name(f"{out.stem}-CODE{out.suffix}")
BASE_URL = re.compile(r"^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?$")


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


def as_schema_owner(c) -> None:
    """Act as the owner of the pulse schema (the migrator's login may; the superuser already is)."""
    owner = c.execute("""select pg_get_userbyid(n.nspowner), r.rolsuper, pg_has_role(session_user, n.nspowner, 'SET')
                           from pg_namespace n, pg_roles r where n.nspname = 'pulse' and r.rolname = session_user""").fetchone()
    if not owner[1]:
        if not owner[2]:
            raise Refused(f"this login may not act as the schema owner {owner[0]} (use the migrator's)")
        c.execute(psycopg.sql.SQL("set local role {}").format(psycopg.sql.Identifier(owner[0])))


def write_private(path: Path, text: str) -> Path:
    """A mode-600 file beside the target, renamed into place by the caller (the folder itself is left as it is)."""
    fd, tmp = tempfile.mkstemp(prefix=".qa-org-", dir=path.parent)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        os.fchmod(f.fileno(), 0o600)
        f.write(text)
    return Path(tmp)


def qa_seat(c, username: str, org_handle: str | None, actor: str) -> dict:
    """The synthetic person behind a QA login, or Refused: a Pulse account with that handle and no e-mail, every company
    of it a test + rehearsal one, an active staff seat under that username in the active one named, no platform admin."""
    acct = c.execute("select id, email from pulse_priv.pulse_account where handle = %s", (username,)).fetchone()
    if not acct:
        raise Refused(f"@{username} is not a Pulse account")
    if acct[1] is not None:
        raise Refused(f"@{username} has an e-mail address: it is not a synthetic QA account")
    picked = None
    seats = c.execute("select member_org, person_id, kind from pulse_priv.account_member where account_id = %s", (acct[0],)).fetchall()
    for org, person, kind in seats:
        enter(c, org, None, actor)  # pulse.org forces row security: each company is read inside itself
        state = c.execute("select handle, purpose, rehearsal, status from pulse.org where id = %s", (org,)).fetchone()
        if not state or state[1] != "test" or not state[2]:
            raise Refused(f"@{username} belongs to a company that is not a QA (test + rehearsal) one")
        if org_handle in (None, state[0]):
            if picked:
                raise Refused(f"@{username} is in more than one QA company: name one with --org-handle")
            picked = (org, person, kind, state)
    if not picked:
        raise Refused(f"@{username} is not in @{org_handle}" if org_handle else f"@{username} has no company")
    org, person, kind, state = picked
    if state[3] != "active":
        raise Refused(f"@{state[0]} is {state[3]}")
    enter(c, org, None, actor)
    seat = c.execute("""select p.id from pulse.person p join pulse.people_profile pp on pp.person_id = p.id and pp.org_id = p.org_id
                         where p.id = %s and p.org_id = %s and p.side = 'staff' and p.status = 'active' and pp.username = %s""",
                     (person, org, username)).fetchone()
    if kind != "staff" or not seat:
        raise Refused(f"@{username} has no active staff seat named {username} in @{state[0]}")
    if c.execute("select 1 from pulse_priv.platform_admin where person_id = %s", (person,)).fetchone():
        raise Refused(f"@{username} is a platform admin: never for a synthetic account")
    # The synthetic owner of that company's profile (qa.owner, qal.owner or demo.owner) sends the link.
    boss = c.execute("""select m.person_id from pulse_priv.account_member m join pulse_priv.pulse_account a on a.id = m.account_id
                         where m.member_org = %s and a.handle = any(%s) and a.email is null
                         order by array_position(%s, a.handle::text) limit 1""",
                     (org, list(OWNER_HANDLES), list(OWNER_HANDLES))).fetchone()
    if not boss:
        raise Refused(f"@{state[0]} has no synthetic owner ({', '.join(OWNER_HANDLES)}) to send the link")
    return {"org": org, "orgHandle": state[0], "person": person, "owner": boss[0]}


def signin_link(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(prog=f"{SCRIPT} signin-link", description="A one-time sign-in link for a QA person (see the module help).")
    ap.add_argument("username", help="the QA login, e.g. qa.seller")
    ap.add_argument("--org-handle", default="", help="the QA company the person must be in (default: their one QA company)")
    ap.add_argument("--out", type=Path, default=LINK_OUT, help="the file that gets the link alone (mode 600, replaced)")
    ap.add_argument("--code-out", type=Path, help="the file that gets the link's 8-character code alone (default: beside --out)")
    ap.add_argument("--base-url", help="the address the link opens (default: the credentials file's, else https://app.vitalsos.ai)")
    ap.add_argument("--credentials", type=Path, default=Path.home() / ".config/vitals-qa/production.json")
    ap.add_argument("--requested-by", default="QA lane (PC orchestrator)", help="who asked (it goes in the company's Audit)")
    ap.add_argument("--dry-run", action="store_true", help="check and mint, then roll back (no link, no file)")
    ap.add_argument("--database")
    ap.add_argument("--dsn-env", default=DEFAULT_DSN_ENV)
    args = ap.parse_args(argv)

    def refuse(msg: str) -> int:
        print(f"Refused (nothing was written): {msg}", file=sys.stderr)
        return 2

    allowed = {h.strip() for h in os.environ.get("PULSE_ADMIN_TOOL_HOSTS", DEFAULT_HOSTS).split(",") if h.strip()}
    if socket.gethostname() not in allowed:
        return refuse(f"this tool runs only on {', '.join(sorted(allowed))}")
    username = args.username.strip().lstrip("@").lower()
    org_handle = args.org_handle.strip().lstrip("@").lower() or None
    if not HANDLE.match(username) or (org_handle and not HANDLE.match(org_handle)):
        return refuse("the username and --org-handle are handles (3 to 30 lower-case letters, digits, dots or underscores)")
    base = (args.base_url or read_credentials(args.credentials).get("baseUrl") or "https://app.vitalsos.ai").rstrip("/")
    if not BASE_URL.match(base):
        return refuse("--base-url is an address like https://app.vitalsos.ai")
    code_out = args.code_out or code_out_for(args.out)
    if not args.dry_run and not args.out.parent.is_dir():
        return refuse(f"{args.out.parent} is not a folder")
    if not args.dry_run and not code_out.parent.is_dir():
        return refuse(f"{code_out.parent} is not a folder")
    if code_out.resolve() == args.out.resolve():
        return refuse("--code-out must be another file than --out")
    requested = re.sub(r"\s+", " ", args.requested_by).strip()[:120] or "QA lane"
    actor = f"qa-org.py signin-link · {requested}"[:120]
    token = secrets.token_urlsafe(32)  # 43 characters, as the API's own links
    tmp: Path | None = None
    tmp_code: Path | None = None
    try:
        with psycopg.connect(dsn(args), application_name=APP) as c:
            c.execute("set lock_timeout = '15s'")
            c.execute("set statement_timeout = '60s'")
            as_schema_owner(c)
            seat = qa_seat(c, username, org_handle, actor)
            # As the synthetic owner (an admin there), the way HR's "Send one-time sign-in link" runs.
            enter(c, seat["org"], seat["owner"], actor)
            cred = c.execute("select status from pulse.login_credential where org_id = %s and person_id = %s",
                             (seat["org"], seat["person"])).fetchone()
            if cred and cred[0] != "active":
                raise Refused(f"@{username}'s sign-in is {cred[0]} in @{seat['orgHandle']}")
            if not cred:
                # The link signs in a seat with an active company credential; this one's password is made and forgotten.
                c.execute("""insert into pulse.login_credential(org_id, person_id, password_hash, must_change, status, issued_by)
                             values (%s, %s, crypt(%s, gen_salt('bf', 10)), false, 'active', %s)""",
                          (seat["org"], seat["person"], secrets.token_urlsafe(32), seat["owner"]))
            token_hash = hashlib.sha256(token.encode()).hexdigest()
            made = c.execute("select pulse.auth_link_make('staff', %s, 'signin', %s) d", (seat["person"], token_hash)).fetchone()[0]
            # SIGNIN-CODE: the link's code, for the installed phone app (db 2399; bcrypt-hashed there, never kept here). A
            # database without 2399 yet (production before the release) still gets its link, with no code.
            try:
                with c.transaction():  # a savepoint, so a missing function leaves the link as it is
                    code = c.execute("select pulse.auth_link_code_make(%s) c", (token_hash,)).fetchone()[0]
            except psycopg.errors.UndefinedFunction:
                code = None
            if code is not None and not LINK_CODE.match(code):
                raise Refused("the database made no proper sign-in code for the link")
            c.execute("""insert into pulse.audit_event(org_id, actor_account, action, resource, resource_id, source, changes)
                         values (%s, %s, 'signin_link_issued', 'person', %s, 'data-change',
                                 jsonb_build_object('why', 'qa_synthetic', 'tool', %s::text, 'credentialMade', %s, 'delivery', 'file'))""",
                      (seat["org"], actor, str(seat["person"]), SCRIPT, cred is None))
            summary = {"applied": not args.dry_run, "org": seat["orgHandle"], "username": username, "person": str(seat["person"]),
                       "expiresAt": made.get("expiresAt"), "credentialMade": cred is None, "opens": f"{base}/login/link",
                       "codeTypedAt": f"{base}/login/link (Have a sign-in code?) with username {username}"}
            if args.dry_run:
                c.rollback()
            else:
                tmp = write_private(args.out, f"{base}/login/link#{token}\n")
                if code:
                    tmp_code = write_private(code_out, f"{code[:4]}-{code[4:]}\n")
                c.commit()
                os.replace(tmp, args.out)
                tmp = None
                summary["out"] = str(args.out)
                if tmp_code is not None:
                    os.replace(tmp_code, code_out)
                    tmp_code = None
                    summary["codeOut"] = str(code_out)
                else:
                    code_out.unlink(missing_ok=True)  # an older code would stand for a replaced link
                    print("No sign-in code: this database has no SIGNIN-CODE yet (migration 2399); the link alone was written.", file=sys.stderr)
    except Refused as e:
        return refuse(str(e))
    except psycopg.Error as e:
        msg = (e.diag.message_primary or str(e)).strip()
        if e.sqlstate in ("42501", "22023", "P0002", "23505"):
            return refuse(msg)
        print(f"The database failed (nothing was written): {msg}", file=sys.stderr)
        return 1
    finally:
        for left in (tmp, tmp_code):
            if left is not None:
                left.unlink(missing_ok=True)
    print(json.dumps(summary, default=str))
    return 0


def roles_of(c, person) -> list[str]:
    return [r[0] for r in c.execute("""select role_key from pulse.role_assignment where person_id = %s
                                        and current_date between valid_from and coalesce(valid_to, 'infinity') order by role_key""",
                                     (person,)).fetchall()]


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if argv[:1] == ["signin-link"]:
        return signin_link(argv[1:])
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--profile", choices=sorted(PROFILES), default="standard",
                    help='"long": the long-name QA company (@vitalsqalong, qal.* logins), on dev only (QA-1D step 4b); '
                         '"demo": the investor demo company (@suryodaydemo, demo.* logins; DEMO-PULSE-2)')
    ap.add_argument("--org-handle", help="default: the profile's (vitalsqa; vitalsqalong; suryodaydemo)")
    ap.add_argument("--org-name", help="default: the profile's")
    ap.add_argument("--as", dest="as_handle", default="savuzo", help="the platform admin who marks it a test company (@handle)")
    ap.add_argument("--approver", required=True, help='who approved, e.g. "Owner Name (owner)"')
    ap.add_argument("--words", required=True, help="the approver's words, verbatim (they go in the audit log)")
    ap.add_argument("--credentials", type=Path, help="default: ~/.config/vitals-qa/production.json (long: dev-long.json; demo: demo.json)")
    ap.add_argument("--base-url", help="recorded in the credentials file for the scripts that sign in (default: the profile's)")
    ap.add_argument("--rotate", action="store_true", help="new passwords for every login and a new agent key")
    ap.add_argument("--apply", action="store_true", help="commit (default: dry run, rolled back, no file written)")
    ap.add_argument("--database")
    ap.add_argument("--dsn-env")
    args = ap.parse_args(argv)
    prof = PROFILES[args.profile]
    staff, client, agent_spec, key_label = prof["staff"], prof["client"], prof["agent"], prof["key_label"]
    credentials = args.credentials or prof["credentials"]
    base_url = (args.base_url or prof["base_url"]).rstrip("/")

    def refuse(msg: str) -> int:
        print(f"Refused (nothing was written): {msg}", file=sys.stderr)
        return 2

    allowed = {h.strip() for h in os.environ.get("PULSE_ADMIN_TOOL_HOSTS", DEFAULT_HOSTS).split(",") if h.strip()}
    if socket.gethostname() not in allowed:
        return refuse(f"this tool runs only on {', '.join(sorted(allowed))}")
    approver, words = args.approver.strip()[:120], args.words.strip()[:380]
    if len(approver) < 3 or len(words) < 4:
        return refuse("name the approver and give their words")
    org_handle = (args.org_handle or prof["org_handle"]).strip().lstrip("@").lower()
    who = args.as_handle.strip().lstrip("@").lower()
    org_name = re.sub(r"\s+", " ", args.org_name or prof["org_name"]).strip()
    if not HANDLE.match(org_handle) or not HANDLE.match(who):
        return refuse("--org-handle and --as take handles (3 to 30 lower-case letters, digits, dots or underscores)")
    if not 2 <= len(org_name) <= 80:
        return refuse("--org-name is 2 to 80 characters")
    if not BASE_URL.match(base_url):
        return refuse("--base-url is an address like https://dev.vitalsos.ai")
    if prof["dev_only"] and base_url.split("://", 1)[1].split(":", 1)[0] in PRODUCTION_HOSTS:
        return refuse(f"the {args.profile} profile is for dev only, never production's address")
    actor = f"qa-org.py · approver: {approver}"[:120]
    old = read_credentials(credentials)
    if old and old.get("org", {}).get("handle") not in (None, org_handle):
        return refuse(f"{credentials} holds another QA organisation's logins")
    old_logins = old.get("logins", {})
    logins: dict = {}
    summary: dict = {"applied": args.apply, "profile": args.profile, "org": None, "people": {}}
    tmp: Path | None = None
    try:
        with psycopg.connect(dsn(args), application_name=APP) as c:
            c.execute("set lock_timeout = '15s'")
            c.execute("set statement_timeout = '120s'")
            if prof["dev_only"] and c.execute("select current_database()").fetchone()[0] in PRODUCTION_DATABASES:
                raise Refused(f"the {args.profile} profile is for dev only, never the production database")
            as_schema_owner(c)
            install, platform_person = platform_seat(c, who, actor)

            # 1. The synthetic accounts. A password is made for a new account, with --rotate, or when the file has none for
            #    it (the file is where the passwords live; nobody else knows them).
            accounts = {}
            for key, handle, name, _title, _roles in staff:
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
                raise Refused(f"@{staff[0][1]} is not an admin of @{org_handle}")
            rehearsal = c.execute("update pulse.org set rehearsal = true where id = %s and not rehearsal returning id", (org,)).fetchone()
            for key, handle, name, title, roles in staff:
                if key == "owner":
                    summary["people"][key] = {"handle": handle, "person": str(owner_person), "createdSeat": created_org, "rolesAdded": []}
                    continue
                summary["people"][key] = {"handle": handle, **ensure_seat(c, org, owner_person, accounts[key], handle, name, title, roles, approver, actor)}

            # 4. The client portal login (not in the demo profile).
            if client:
                ckey, chandle, cname = client
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

            # 5. The AI employee and its key (not in the demo profile).
            akey = None
            if agent_spec:
                akey, ahandle, aname, atitle = agent_spec
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
                                                    and revoked_at is null""", (org, agent[0], key_label)).fetchall():
                        c.execute("select pulse.agent_key_revoke(%s)", (prefix,))
                    key = c.execute("select pulse.agent_key_issue(%s, %s, 90)", (agent[0], key_label)).fetchone()[0]
                logins[akey] = {"kind": "agent", "username": ahandle, "key": key or had, "name": aname}
                summary["people"][akey] = {"username": ahandle, "person": str(agent[0]), "created": agent_created, "newKey": key is not None}
            for k, v in summary["people"].items():
                if v.get("person") and k != akey:
                    v["roles"] = roles_of(c, v["person"])

            # 6. The ledger: platform audit log and the company's own Audit, as the platform admin.
            state = c.execute("select name, purpose, rehearsal, status from pulse.org where id = %s", (org,)).fetchone()
            enter(c, install, platform_person, actor)
            detail = {"tool": SCRIPT, "profile": args.profile, "host": socket.gethostname(), "approver": approver, "words": words, "createdOrg": created_org,
                      "people": {k: {x: y for x, y in v.items() if x in ("handle", "username", "createdSeat", "created", "rolesAdded")}
                                 for k, v in summary["people"].items()},
                      "rotate": args.rotate, "applied": args.apply}
            c.execute("select pulse.platform_log('qa.org_setup', %s, 'org', %s, %s, %s, %s::jsonb)",
                      (org, str(org), state[0], f"{words} (approved by {approver})", json.dumps(detail)))
            summary["org"] = {"id": str(org), "handle": org_handle, "name": state[0], "purpose": state[1], "rehearsal": state[2],
                              "status": state[3], "created": created_org, "purposeChange": purpose, "rehearsalSet": rehearsal is not None}
            if args.apply:
                data = {"org": {"id": str(org), "handle": org_handle, "name": state[0]}, "baseUrl": base_url, "profile": args.profile,
                        "note": f"{'DEMO-PULSE-2 demo' if args.profile == 'demo' else 'QA-1'} synthetic logins (test and rehearsal "
                                "company). Never print or commit this file.",
                        "logins": logins}
                tmp = write_credentials(credentials, data)
                c.commit()
                os.replace(tmp, credentials)
                tmp = None
                summary["credentials"] = str(credentials)
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
