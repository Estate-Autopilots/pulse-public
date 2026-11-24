#!/usr/bin/env python3
"""Companies, seats, roles and logos set up at the Pulse server's terminal (ACCESS-SETUP, owner, 6 Nov 2026): "Kazuk must
have access to Vitals Technologies ... Sakobe must have access to Willow Lane ... create a NayaGrowth Private Limited company
... set each company's logo ... remove the old Pulse organisation."

    python3 tools/admin/grant-access.py seat --org willowlane --account shivambuilds --title "Operations" --roles leadership \\
        --approver "Owner Name (owner)" --words "the owner's words" [--apply]
    python3 tools/admin/grant-access.py org-create --name "Example Private Limited" --handle example --account savuzo ...
    python3 tools/admin/grant-access.py logo --org willowlane --kind mark --file mark.png ...
    python3 tools/admin/grant-access.py org-suspend --org oldorg ...

  * seat: what an organisation admin does on screen, as that admin (--as, default savuzo), in that organisation, as
    pulse_api: People → Add person (the statements of POST /api/v0/people) and Settings → Roles (POST
    /api/v0/settings/roles), then the person is linked to the Pulse account the way tools/consolidate/pulse-accounts.py
    links a seat (pulse_priv.account_member plus an 'account_link' row in the organisation's Audit), so the company shows
    in that account's switcher. The person's profile takes the account's own e-mail and handle, as an accepted invitation
    does. Run again, it adds only the roles still missing. Nothing is sent: no invitation, e-mail or notice.
  * org-create: pulse.connect_org_create, the app's function that starts an organisation for a Pulse account (Owner,
    admin and leadership) without signing anyone in.
  * logo: pulse.org_brand_save as the organisation's admin (Settings → Brand). SVG, PNG, WebP or JPEG.
  * legal-name: pulse.org_legal_name_save as the organisation's admin (Settings → Organisation → Registered name, the
    name contracts, quotes and invoices print), the approver's words as its note (CONNECTIONS, 16 Nov 2026).
  * connection: pulse.connection_make as the acting person in one of their spaces (--org a company handle, or
    "personal" for their own personal space), source backfill, status suggested (the owner confirms it), the approver's
    words as its note; then --draft (pulse.connection_agreement_draft: one DRAFT, never sent) or --link-contract <id>
    (pulse.connection_agreement_link: an agreement that exists becomes the connection's own). CONNECTIONS, 17 Nov 2026.
  * org-purpose: pulse.platform_org_purpose (work, test or demo), as a platform admin in the install's organisation: a
    test or demo company still opens, under its own heading, and is never counted among a person's companies.
  * org-suspend: pulse.platform_org_set(status suspended), as a platform admin in the install's organisation (the admin
    console's Suspend). Nothing is deleted; its people's sessions end and it leaves every switcher (account_seats lists
    active organisations only). Undo: the same with --status active.
  * No sign-in is made: no session, no token, nothing in the sign-in or session tables. One transaction per run; a dry run
    (the default) does all of it and rolls back. With --apply it commits, and in the same transaction writes the platform
    audit log (pulse_priv.platform_audit) and, through platform_log, the organisation's own Audit: who approved, their words
    verbatim, which admin acted, what changed.
  * It runs only on the Pulse server (PULSE_ADMIN_TOOL_HOSTS, default host-49a12d.internal.example) with the database's admin role there
    (docker exec into ea-postgres, as tools/runner/pair-code.py). There is no web route for it.

Exit codes: 0 done (or the dry run worked); 2 refused (arguments, host, organisation, admin, account); 1 the database failed.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shlex
import socket
import subprocess
import sys
from pathlib import Path

APP = "pulse-grant-access"
SCRIPT = "tools/admin/grant-access.py"
HANDLE_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{1,62}$")
DEFAULT_HOSTS = "host-49a12d.internal.example"
ROLES = ("admin", "leadership", "hr", "finance")          # the roles Settings → Roles grants without a team
MIMES = {".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".jpg": "image/jpeg", ".jpeg": "image/jpeg"}
MAX_LOGO = 1_000_000
# The role the acting person's statements run as. pulse_api (the API's own role) under the database superuser; with the
# server's migration login (no superuser, not a member of pulse_api), pulse_owner: every write here is a security-definer
# product function that checks the acting person (pulse.org_id / pulse.viewer_id), not the database role (CONNECTIONS).
ADMIN_ROLE = "pulse_api"


class Refused(Exception):
    pass


def lit(value: object) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def psql_argv(runner: str, user: str, database: str) -> list[str]:
    argv = shlex.split(runner)
    if argv[:2] == ["docker", "exec"]:
        argv[2:2] = ["-e", f"PGAPPNAME={APP}"]
    conn = ["-U", user, "-d", database] if user else ["-d", database]
    return [*argv, "psql", *conn, "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1"]


def handle(value: str, what: str) -> str:
    h = str(value or "").strip().lstrip("@").lower()
    if not HANDLE_RE.match(h):
        raise Refused(f"{what} takes a handle (letters, digits, dot, dash, underscore)")
    return h


def head(org_expr: str, as_handle: str) -> str:
    """Begin, and find the acting admin's staff seat in the organisation (as tools/admin/import-meetings.py). The seat is
    read inside the organisation, so the lookup also works without the superuser (forced row security); a login that is
    not the superuser reads as the schema owner (CONNECTIONS, 17 Nov 2026)."""
    return f"""\\set ON_ERROR_STOP on
set client_encoding = 'UTF8';
begin;
set local lock_timeout = '15s';
set local statement_timeout = '120s';
do $c$ begin
  if not (select rolsuper from pg_roles where rolname = session_user) then execute 'set local role pulse_owner'; end if;
end $c$;
select set_config('ga.org', coalesce((select o.id::text from pulse.org o where {org_expr} and o.status = 'active' limit 1), ''), true),
       set_config('ga.person', '', true);
select set_config('pulse.org_id', current_setting('ga.org'), true);
select set_config('ga.person', m.person_id::text, true), set_config('ga.name', p.display_name, true), set_config('ga.org_name', o.name, true)
  from pulse.org o
  join pulse_priv.account_member m on m.member_org = o.id
  join pulse_priv.pulse_account a on a.id = m.account_id
  join pulse.person p on p.id = m.person_id and p.org_id = o.id
 where o.id = nullif(current_setting('ga.org'), '')::uuid and a.handle = {lit(as_handle)} and p.status = 'active' and p.side = 'staff'
 limit 1;
do $c$ begin
  if coalesce(current_setting('ga.person', true), '') = '' then
    raise exception 'GRANT_REFUSED: no active organisation with a staff seat for @{as_handle}' using errcode = '42501';
  end if;
end $c$;
"""


def as_admin(actor: str) -> str:
    return f"""select set_config('pulse.org_id', current_setting('ga.org'), true), set_config('pulse.viewer_id', current_setting('ga.person'), true),
       set_config('pulse.actor_account', {lit(actor)}, true), set_config('pulse.agent_session', '', true);
set local role {ADMIN_ROLE};
do $c$ begin
  if not pulse.viewer_is('admin') then raise exception 'GRANT_REFUSED: the acting person is not an admin of this organisation' using errcode = '42501'; end if;
end $c$;
"""


def ledger(action: str, kind: str, ref_expr: str, words: str, detail: dict, actor: str, apply: bool) -> str:
    return f"""reset role;
select set_config('pulse.org_id', '', true), set_config('pulse.viewer_id', '', true), set_config('pulse.actor_account', {lit(actor)}, true);
select pulse.platform_log({lit(action)}, current_setting('ga.org')::uuid, {lit(kind)}, {ref_expr}, current_setting('ga.org_name'),
  {lit(words)}, {lit(json.dumps(detail, ensure_ascii=False))}::jsonb || jsonb_build_object('onBehalfOf', current_setting('ga.person', true),
  'applied', {'true' if apply else 'false'}));
"""


def platform_head(org: str, as_handle: str) -> str:
    """The acting person is a Pulse platform admin (an admin of the install's organisation listed in
    pulse_priv.platform_admin) who has no seat in the target organisation: the operator's own write, as the database's
    definer functions do it (acct_join), recorded in the platform audit log under that platform admin."""
    return head("o.id = pulse.install_org()", as_handle) + f"""do $c$ begin
  if not exists (select 1 from pulse_priv.platform_admin where person_id = current_setting('ga.person')::uuid) then
    raise exception 'GRANT_REFUSED: @{as_handle} is not a Pulse platform admin' using errcode = '42501';
  end if;
end $c$;
select set_config('ga.org', coalesce((select o.id::text from pulse.org o where o.handle = {lit(org)} and o.status = 'active'), ''), true),
       set_config('ga.org_name', coalesce((select o.name from pulse.org o where o.handle = {lit(org)} and o.status = 'active'), ''), true);
do $c$ begin
  if current_setting('ga.org') = '' then raise exception 'GRANT_REFUSED: no active organisation @{org}' using errcode = '42501'; end if;
end $c$;
"""


def seat_script(org: str, account: str, title: str, roles: list[str], as_handle: str, actor: str, detail: dict, words: str, apply: bool,
                platform: bool = False) -> str:
    by = "null::uuid" if platform else "current_setting('ga.person')::uuid"
    out = [platform_head(org, as_handle) if platform else head(f"o.handle = {lit(org)}", as_handle)]
    out.append(f"""select set_config('ga.acct', coalesce((select id::text from pulse_priv.pulse_account where handle = {lit(account)}), ''), true);
do $c$ begin
  if current_setting('ga.acct') = '' then raise exception 'GRANT_REFUSED: nobody on Pulse has the account @{account}' using errcode = '42501'; end if;
end $c$;
select set_config('ga.acct_name', display_name, true), set_config('ga.acct_email', coalesce(lower(email), ''), true)
  from pulse_priv.pulse_account where id = current_setting('ga.acct')::uuid;
select set_config('ga.seat', coalesce((select person_id::text from pulse_priv.account_member
  where account_id = current_setting('ga.acct')::uuid and member_org = current_setting('ga.org')::uuid), ''), true),
       set_config('ga.created', '', true), set_config('ga.roles_added', '', true);
""")
    out.append(f"""-- The platform operator, inside the organisation as its definer functions enter it (no viewer).
select pulse.acct_enter(current_setting('ga.org')::uuid, null);
select set_config('pulse.actor_account', {lit(actor)}, true);
""" if platform else as_admin(actor))
    out.append(f"""-- People → Add person (POST /api/v0/people), only when the account has no seat here yet.
select pg_advisory_xact_lock(hashtext('staff-identity:' || current_setting('ga.org')));
select set_config('ga.username', u, true) from (
  select coalesce((select c from (select {lit(account)} c union all select {lit(account)} || '.' || n from generate_series(2, 50) n) x
    where not exists (select 1 from pulse.people_profile pp where pp.org_id = pulse.current_org() and pp.username = x.c) limit 1), {lit(account)} || '.x') u) s;
with p as (
  insert into pulse.person(org_id, display_name, side) select pulse.current_org(), current_setting('ga.acct_name'), 'staff'
   where current_setting('ga.seat') = '' returning id)
select set_config('ga.seat', id::text, true), set_config('ga.created', '1', true) from p;
insert into pulse.people_profile(org_id, person_id, role, evidence, user_no, username, email, locked)
select pulse.current_org(), current_setting('ga.seat')::uuid, {lit(title)},
       'Added in Pulse by ' || current_setting('ga.name') || ' for the Pulse account @{account} (' || {lit(SCRIPT)} || ', approved by ' || {lit(detail['approver'])} || ').',
       (select coalesce(max(user_no), 0) + 1 from pulse.people_profile), current_setting('ga.username'),
       nullif(current_setting('ga.acct_email'), ''), '{{name,role,pod,status}}'
 where current_setting('ga.created') = '1';
insert into pulse.record_change(org_id, entity_type, entity_id, field, new_value, changed_by)
select pulse.current_org(), 'person', current_setting('ga.seat')::uuid, 'created', current_setting('ga.acct_name'), {by}
 where current_setting('ga.created') = '1';
do $c$ begin
  if not exists (select 1 from pulse.person where id = current_setting('ga.seat')::uuid and side = 'staff' and status = 'active') then
    raise exception 'GRANT_REFUSED: @{account} has a seat here that is not an active staff seat; HR decides on it' using errcode = '42501';
  end if;
end $c$;
""")
    for r in roles:
        out.append(f"""-- Settings → Roles → grant {r} (POST /api/v0/settings/roles), only if not held.
with g as (
  insert into pulse.role_assignment(org_id, person_id, role_key, unit_id, is_manager_of_unit, valid_from)
  select pulse.current_org(), current_setting('ga.seat')::uuid, {lit(r)}, null, false, current_date
   where not exists (select 1 from pulse.role_assignment where person_id = current_setting('ga.seat')::uuid and role_key = {lit(r)}
                      and current_date between valid_from and coalesce(valid_to, 'infinity'))
  returning person_id),
l as (
  insert into pulse.record_change(org_id, entity_type, entity_id, field, old_value, new_value, changed_by)
  select pulse.current_org(), 'role', person_id, {lit(r)}, null, 'granted', {by} from g
  returning entity_id)
select set_config('ga.roles_added', current_setting('ga.roles_added') || {lit(r)} || ' ', true) from l;
""")
    out.append(f"""reset role;
-- The link to the Pulse account: as tools/consolidate/pulse-accounts.py links a seat (account_member + the organisation's Audit).
do $l$ begin
  perform pulse.acct_enter(current_setting('ga.org')::uuid, null);
  if not exists (select 1 from pulse_priv.account_member where person_id = current_setting('ga.seat')::uuid) then
    insert into pulse_priv.account_member(account_id, member_org, person_id, kind)
    values (current_setting('ga.acct')::uuid, current_setting('ga.org')::uuid, current_setting('ga.seat')::uuid, 'staff');
    insert into pulse.audit_event(org_id, actor_account, action, resource, resource_id, source, changes)
    values (current_setting('ga.org')::uuid, {lit(actor)}, 'account_link', 'person', current_setting('ga.seat'), 'data-change',
            jsonb_build_object('account', current_setting('ga.acct'), 'why', 'owner_grant'));
  end if;
  perform pulse.acct_leave();
end $l$;
""")
    out.append(ledger("admin.seat_grant", "person", "current_setting('ga.seat')", words, detail, actor, apply).replace(
        "'applied',", "'createdSeat', current_setting('ga.created') = '1', 'rolesAdded', btrim(current_setting('ga.roles_added')), 'applied',"))
    out.append(f"""select json_build_object('org', current_setting('ga.org'), 'orgName', current_setting('ga.org_name'), 'admin', current_setting('ga.name'),
  'account', {lit(account)}, 'person', current_setting('ga.seat'), 'createdSeat', current_setting('ga.created') = '1',
  'username', (select username from pulse.people_profile where person_id = current_setting('ga.seat')::uuid),
  'title', (select role from pulse.people_profile where person_id = current_setting('ga.seat')::uuid),
  'roles', (select coalesce(json_agg(role_key order by role_key), '[]') from pulse.role_assignment where person_id = current_setting('ga.seat')::uuid
             and current_date between valid_from and coalesce(valid_to, 'infinity')),
  'rolesAdded', btrim(current_setting('ga.roles_added')), 'applied', {'true' if apply else 'false'})::text;
{'commit' if apply else 'rollback'};
""")
    return "".join(out)


def org_create_script(name: str, org_handle: str, account: str, actor: str, detail: dict, words: str, apply: bool) -> str:
    return f"""\\set ON_ERROR_STOP on
set client_encoding = 'UTF8';
begin;
set local lock_timeout = '15s';
select set_config('ga.acct', coalesce((select id::text from pulse_priv.pulse_account where handle = {lit(account)}), ''), true);
do $c$ begin
  if current_setting('ga.acct') = '' then raise exception 'GRANT_REFUSED: nobody on Pulse has the account @{account}' using errcode = '42501'; end if;
end $c$;
select set_config('ga.existing', coalesce((select id::text from pulse.org where handle = {lit(org_handle)}), ''), true);
select set_config('ga.org', case when current_setting('ga.existing') <> '' then current_setting('ga.existing')
  else pulse.connect_org_create(current_setting('ga.acct')::uuid, {lit(name)}, {lit(org_handle)}, null)::text end, true);
do $c$ begin
  if current_setting('ga.existing') <> '' and not exists (select 1 from pulse_priv.account_member where member_org = nullif(current_setting('ga.existing'), '')::uuid
       and account_id = current_setting('ga.acct')::uuid) then
    raise exception 'GRANT_REFUSED: @{org_handle} is someone else''s organisation' using errcode = '42501';
  end if;
end $c$;
select set_config('ga.org_name', name, true) from pulse.org where id = current_setting('ga.org')::uuid;
select set_config('ga.person', (select person_id::text from pulse_priv.account_member where member_org = current_setting('ga.org')::uuid
  and account_id = current_setting('ga.acct')::uuid), true);
{ledger("admin.org_create", "org", "current_setting('ga.org')", words, detail, actor, apply).replace("'applied',", "'created', current_setting('ga.existing') = '', 'applied',")}
select json_build_object('org', current_setting('ga.org'), 'orgName', current_setting('ga.org_name'), 'handle', {lit(org_handle)},
  'created', current_setting('ga.existing') = '', 'owner', {lit(account)}, 'applied', {'true' if apply else 'false'})::text;
{'commit' if apply else 'rollback'};
"""


def logo_script(org: str, kind: str, data_hex: str, mime: str, as_handle: str, actor: str, detail: dict, words: str, apply: bool) -> str:
    return (head(f"o.handle = {lit(org)}", as_handle) + as_admin(actor)
            + f"select set_config('ga.version', pulse.org_brand_save({lit(kind)}, decode({lit(data_hex)}, 'hex'), {lit(mime)})::text, true);\n"
            + ledger("admin.brand", "org_brand", "current_setting('ga.org')", words, detail, actor, apply)
            + f"""select json_build_object('org', current_setting('ga.org'), 'orgName', current_setting('ga.org_name'), 'kind', {lit(kind)},
  'version', current_setting('ga.version')::int, 'applied', {'true' if apply else 'false'})::text;
{'commit' if apply else 'rollback'};
""")


def org_status_script(org: str, status: str, as_handle: str, actor: str, words: str, apply: bool) -> str:
    return (head("o.id = pulse.install_org()", as_handle)
            + f"""select set_config('ga.target', coalesce((select id::text from pulse.org where handle = {lit(org)}), ''), true);
do $c$ begin
  if current_setting('ga.target') = '' then raise exception 'GRANT_REFUSED: no organisation @{org}' using errcode = '42501'; end if;
end $c$;
select set_config('pulse.org_id', current_setting('ga.org'), true), set_config('pulse.viewer_id', current_setting('ga.person'), true),
       set_config('pulse.actor_account', {lit(actor)}, true), set_config('pulse.agent_session', '', true);
set local role pulse_api;
-- The admin console's Suspend / Reactivate (platform_org_set writes the platform audit log itself).
select set_config('ga.changes', pulse.platform_org_set(current_setting('ga.target')::uuid, jsonb_build_object('status', {lit(status)}),
  {lit(words)})::text, true);
reset role;
-- platform_org_set runs in the install's organisation, and pulse.org's forced row security (own_org: id = current_org())
-- filters its update of any other organisation to nothing (ACCESS-SETUP found this on 6 Nov 2026): its ledger row and
-- its ended sessions are written, the status is not. Finish that one column here, as the operator, and say so in the log.
select set_config('pulse.org_id', '', true), set_config('pulse.viewer_id', '', true), set_config('pulse.actor_account', {lit(actor)}, true);
with u as (update pulse.org set status = {lit(status)} where id = current_setting('ga.target')::uuid and status <> {lit(status)} returning id)
select set_config('ga.completed', count(*)::text, true) from u;
select pulse.platform_log('org.status_completed', current_setting('ga.target')::uuid, 'org', current_setting('ga.target'),
  (select name from pulse.org where id = current_setting('ga.target')::uuid), {lit(words)},
  jsonb_build_object('tool', {lit(SCRIPT)}, 'status', {lit(status)}, 'why', 'platform_org_set update filtered by row security'))
 where current_setting('ga.completed') <> '0';
select json_build_object('org', current_setting('ga.target'), 'status', (select status from pulse.org where id = current_setting('ga.target')::uuid),
  'changes', current_setting('ga.changes')::jsonb, 'applied', {'true' if apply else 'false'})::text;
{'commit' if apply else 'rollback'};
""")


def legal_name_script(org: str, name: str, as_handle: str, actor: str, detail: dict, words: str, apply: bool) -> str:
    return (head(f"o.handle = {lit(org)}", as_handle) + as_admin(actor)
            + f"select set_config('ga.r', pulse.org_legal_name_save({lit(name)}, {lit(words)})::text, true);\n"
            # What its documents print now, read inside it (before the ledger leaves the organisation).
            + "select set_config('ga.printed', coalesce(pulse.org_legal_name(), ''), true);\n"
            + ledger("admin.legal_name", "org", "current_setting('ga.org')", words, detail, actor, apply)
            + f"""select json_build_object('org', current_setting('ga.org'), 'orgName', current_setting('ga.org_name'),
  'result', current_setting('ga.r')::jsonb, 'printed', current_setting('ga.printed'),
  'applied', {'true' if apply else 'false'})::text;
{'commit' if apply else 'rollback'};
""")


def org_purpose_script(org: str, purpose: str, as_handle: str, actor: str, words: str, apply: bool) -> str:
    return (head("o.id = pulse.install_org()", as_handle)
            + f"""select set_config('ga.target', coalesce((select id::text from pulse.org where handle = {lit(org)}), ''), true);
do $c$ begin
  if current_setting('ga.target') = '' then raise exception 'GRANT_REFUSED: no organisation @{org}' using errcode = '42501'; end if;
end $c$;
select set_config('pulse.org_id', current_setting('ga.org'), true), set_config('pulse.viewer_id', current_setting('ga.person'), true),
       set_config('pulse.actor_account', {lit(actor)}, true), set_config('pulse.agent_session', '', true);
set local role {ADMIN_ROLE};
-- pulse.platform_org_purpose checks the platform admin, changes the mark inside the target and writes both audit logs.
select set_config('ga.changes', pulse.platform_org_purpose(current_setting('ga.target')::uuid, {lit(purpose)}, {lit(words)})::text, true);
reset role;
select json_build_object('org', current_setting('ga.target'), 'purpose', (select purpose from pulse.org where id = current_setting('ga.target')::uuid),
  'changes', current_setting('ga.changes')::jsonb, 'applied', {'true' if apply else 'false'})::text;
{'commit' if apply else 'rollback'};
""")


def connection_script(org: str, as_handle: str, actor: str, detail: dict, words: str, apply: bool, p: dict, draft: bool, link: str | None) -> str:
    org_expr = (f"o.kind = 'personal' and o.personal_account = (select id from pulse_priv.pulse_account where handle = {lit(as_handle)})"
                if org == "personal" else f"o.handle = {lit(org)}")
    after = ""
    if link:
        after = f"select set_config('ga.ag', pulse.connection_agreement_link(current_setting('ga.conn')::uuid, {lit(link)}::uuid)::text, true);\n"
    elif draft:
        after = "select set_config('ga.ag', pulse.connection_agreement_draft(current_setting('ga.conn')::uuid)::text, true);\n"
    return (head(org_expr, as_handle) + f"""select set_config('pulse.org_id', current_setting('ga.org'), true), set_config('pulse.viewer_id', current_setting('ga.person'), true),
       set_config('pulse.actor_account', {lit(actor)}, true), set_config('pulse.agent_session', '', true), set_config('ga.ag', '', true);
set local role {ADMIN_ROLE};
select set_config('ga.made', pulse.connection_make({lit(json.dumps(p, ensure_ascii=False))}::jsonb)::text, true);
select set_config('ga.conn', current_setting('ga.made')::jsonb ->> 'id', true);
""" + after + ledger("admin.connection", "connection", "current_setting('ga.conn')", words, detail, actor, apply)
            + f"""select json_build_object('org', current_setting('ga.org'), 'orgName', current_setting('ga.org_name'), 'made', current_setting('ga.made')::jsonb,
  'agreement', nullif(current_setting('ga.ag'), '')::jsonb, 'applied', {'true' if apply else 'false'})::text;
{'commit' if apply else 'rollback'};
""")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)

    def common(p: argparse.ArgumentParser) -> None:
        p.add_argument("--approver", required=True, help='who approved this, e.g. "Owner Name (owner)"')
        p.add_argument("--words", required=True, help="the approver's words, verbatim (they go in the audit log)")
        p.add_argument("--as", dest="as_handle", default="savuzo", help="the organisation admin who acts (@handle)")
        p.add_argument("--apply", action="store_true", help="commit (without it: do everything, then roll back)")
        p.add_argument("--exec", default="docker exec -i ea-postgres", help='how to reach psql ("" for a local psql)')
        p.add_argument("--db-user", default="ea_admin", help='("" when --database is a connection string)')
        p.add_argument("--database", default="pulse")
        p.add_argument("--admin-role", default="pulse_api", choices=("pulse_api", "pulse_owner"),
                       help="the role the acting statements run as (pulse_owner with the server's migration login)")

    s = sub.add_parser("seat", help="give a Pulse account a staff seat (and roles) in an organisation")
    s.add_argument("--org", required=True)
    s.add_argument("--account", required=True, help="the person's Pulse account (@handle)")
    s.add_argument("--title", required=True, help="their title in this organisation")
    s.add_argument("--roles", default="", help=f"comma-separated, of {', '.join(ROLES)} (none: a team member)")
    s.add_argument("--platform", action="store_true",
                   help="--as is a Pulse platform admin with no seat in --org (the operator's own write, recorded as such)")
    common(s)
    o = sub.add_parser("org-create", help="start an organisation owned by a Pulse account")
    o.add_argument("--name", required=True)
    o.add_argument("--handle", required=True)
    o.add_argument("--account", required=True, help="the owner's Pulse account (@handle)")
    common(o)
    lg = sub.add_parser("logo", help="set an organisation's logo or square mark")
    lg.add_argument("--org", required=True)
    lg.add_argument("--kind", required=True, choices=("mark", "logo", "logo_dark", "logo_png"))
    lg.add_argument("--file", required=True, type=Path)
    common(lg)
    st = sub.add_parser("org-suspend", help="suspend (archive) an organisation, or --status active to bring it back")
    st.add_argument("--org", required=True)
    st.add_argument("--status", default="suspended", choices=("suspended", "active"))
    common(st)
    ln = sub.add_parser("legal-name", help="set an organisation's registered (legal) name, printed on contracts, quotes and invoices")
    ln.add_argument("--org", required=True)
    ln.add_argument("--name", required=True)
    common(ln)
    cn = sub.add_parser("connection", help="record a connection (suggested, for the owner to confirm), and draft or link its agreement")
    cn.add_argument("--org", required=True, help='where it lives: a company handle, or "personal" (the acting person\'s own space)')
    cn.add_argument("--kind", required=True, choices=("client", "vendor", "partner", "freelancer", "employee", "cofounder", "advisor", "investor", "accountant"))
    cn.add_argument("--other-org", default="", help="the other side's company handle")
    cn.add_argument("--other-account", default="", help="the other side's person (@handle)")
    cn.add_argument("--a-role", default="")
    cn.add_argument("--b-role", default="")
    cn.add_argument("--as-person", action="store_true", help="side A is the acting person (inside --org), e.g. co-founders")
    cn.add_argument("--draft", action="store_true", help="draft its agreement (never sent)")
    cn.add_argument("--link-contract", default="", help="an existing agreement (contract id in --org) becomes the connection's own")
    common(cn)
    pu = sub.add_parser("org-purpose", help="mark an organisation as a real company (work), a test company or a demo company")
    pu.add_argument("--org", required=True)
    pu.add_argument("--purpose", required=True, choices=("work", "test", "demo"))
    common(pu)
    args = ap.parse_args(argv)

    global ADMIN_ROLE
    ADMIN_ROLE = args.admin_role
    approver, words = args.approver.strip(), args.words.strip()
    if len(approver) < 3 or len(words) < 4:
        print("Refused: --approver (a name) and --words (the approval, verbatim) are both needed.", file=sys.stderr)
        return 2
    host = socket.gethostname()
    allowed = {h.strip() for h in os.environ.get("PULSE_ADMIN_TOOL_HOSTS", DEFAULT_HOSTS).split(",") if h.strip()}
    if host not in allowed:
        print(f"Refused: this tool runs only on the Pulse server ({', '.join(sorted(allowed))}), not on {host}.", file=sys.stderr)
        return 2
    actor = f"grant-access.py · approver: {approver}"[:120]
    approver, words = approver[:120], words[:380]
    detail = {"tool": SCRIPT, "host": host, "approver": approver, "words": words, "onBehalfOfHandle": None}
    try:
        as_handle = handle(args.as_handle, "--as")
        detail["onBehalfOfHandle"] = as_handle
        if args.cmd == "seat":
            org, account = handle(args.org, "--org"), handle(args.account, "--account")
            title = re.sub(r"\s+", " ", args.title).strip()
            if not 2 <= len(title) <= 80:
                raise Refused("--title is 2 to 80 characters")
            roles = [r.strip() for r in args.roles.split(",") if r.strip()]
            if any(r not in ROLES for r in roles):
                raise Refused(f"--roles are of {', '.join(ROLES)}")
            detail.update(account=account, title=title, roles=roles)
            detail["asPlatformAdmin"] = args.platform
            script = seat_script(org, account, title, roles, as_handle, actor, detail, words, args.apply, args.platform)
        elif args.cmd == "org-create":
            org, account = handle(args.handle, "--handle"), handle(args.account, "--account")
            name = re.sub(r"\s+", " ", args.name).strip()
            detail.update(name=name, handle=org, owner=account, via="pulse.connect_org_create")
            script = org_create_script(name, org, account, actor, detail, words, args.apply)
        elif args.cmd == "logo":
            org = handle(args.org, "--org")
            mime = MIMES.get(args.file.suffix.lower())
            if not mime:
                raise Refused("the logo is an SVG, PNG, WebP or JPEG file")
            data = args.file.read_bytes()
            if not data or len(data) > MAX_LOGO:
                raise Refused(f"the logo must be 1 byte to 1 MB (it is {len(data)} bytes)")
            detail.update(kind=args.kind, mime=mime, size=len(data), sha256=hashlib.sha256(data).hexdigest(), file=args.file.name)
            script = logo_script(org, args.kind, data.hex(), mime, as_handle, actor, detail, words, args.apply)
        elif args.cmd == "legal-name":
            org = handle(args.org, "--org")
            name = re.sub(r"\s+", " ", args.name).strip()
            if not 2 <= len(name) <= 160:
                raise Refused("--name is 2 to 160 characters")
            detail.update(legalName=name, via="pulse.org_legal_name_save")
            script = legal_name_script(org, name, as_handle, actor, detail, words, args.apply)
        elif args.cmd == "connection":
            org = "personal" if args.org.strip().lower() == "personal" else handle(args.org, "--org")
            if not (args.other_org or args.other_account):
                raise Refused("name the other side: --other-org or --other-account")
            if args.link_contract and not re.fullmatch(r"[0-9a-f-]{36}", args.link_contract):
                raise Refused("--link-contract takes a contract id")
            p = {"kind": args.kind, "source": "backfill", "status": "suggested", "note": words[:400], "asPerson": args.as_person}
            if args.other_org:
                p["orgHandle"] = handle(args.other_org, "--other-org")
            if args.other_account:
                p["accountHandle"] = handle(args.other_account, "--other-account")
            if args.a_role:
                p["aRole"] = args.a_role.strip()[:80]
            if args.b_role:
                p["bRole"] = args.b_role.strip()[:80]
            detail.update(connection=p, draft=args.draft, linkContract=args.link_contract or None, via="pulse.connection_make")
            script = connection_script(org, as_handle, actor, detail, words, args.apply, p, args.draft, args.link_contract or None)
        elif args.cmd == "org-purpose":
            script = org_purpose_script(handle(args.org, "--org"), args.purpose, as_handle, actor, words, args.apply)
        else:
            script = org_status_script(handle(args.org, "--org"), args.status, as_handle, actor, words, args.apply)
    except (Refused, OSError) as e:
        print(f"Refused: {e}", file=sys.stderr)
        return 2
    proc = subprocess.run(psql_argv(args.exec, args.db_user, args.database), input=script.encode("utf-8"), capture_output=True, check=False)
    out, err = proc.stdout.decode("utf-8", "replace"), proc.stderr.decode("utf-8", "replace")
    if proc.returncode != 0:
        msg = (re.findall(r"ERROR:\s*(.*)", err) or [err.strip()[-400:]])[-1]
        if "GRANT_REFUSED" in msg or "42501" in err or "Only " in msg:
            print(f"Refused (nothing was written): {msg.replace('GRANT_REFUSED: ', '')}", file=sys.stderr)
            return 2
        print(f"The database failed; nothing was written: {msg}", file=sys.stderr)
        return 1
    rows = [json.loads(x) for x in out.splitlines() if x.startswith("{")]
    print(json.dumps(rows[-1], ensure_ascii=False))
    print(("Applied. Written to the platform audit log and the organisation's Audit." if args.apply
           else "Dry run (rolled back). Run again with --apply."), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
