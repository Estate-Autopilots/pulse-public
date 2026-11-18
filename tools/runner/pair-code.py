#!/usr/bin/env python3
"""A pairing code for "Connect a server" (Pulse Runner), made on the Pulse server itself (EA-RUNNER, owner, 6 Nov 2026).

Settings → Servers & AI → "Add a server" makes the code in the browser: POST /api/v0/admin/runners/pair-code calls
pulse.runner_pair_code_create(hash) as the signed-in organisation admin (migration 1560). This tool is the same step for
the platform's operator at the server's own terminal, when the admin is not at a browser:

    python3 tools/runner/pair-code.py --org estateautopilots --approver "Owner Name (owner)" --words "the owner's words"

  * It calls the same database function, in that organisation, on behalf of one of its admins (--as, an @handle;
    default savuzo). The function checks that the person is an organisation admin, as it does for the browser. No
    sign-in is made: no session, no token, nothing written to the sign-in or session tables.
  * In the same transaction it writes the platform audit log (pulse_priv.platform_audit, append-only) and the
    organisation's own Audit: who approved, their words verbatim, which admin, which server, when the code ends. If
    the log cannot be written, no code is made.
  * The code is printed once, on stdout, and nowhere else: only its SHA-256 reaches the database (as from the API),
    and it is never on a command line, in a log or in a file. Everything else goes to stderr.
  * It runs only on the Pulse server (its hostname is in PULSE_PAIR_CODE_HOSTS, default host-49a12d.internal.example) and needs the
    database's admin role there (docker exec into ea-postgres, as tools/consolidate/pulse-accounts.py). There is no web
    route for it.

Exit codes: 0 made; 2 refused (arguments, host, organisation, admin); 1 the database failed.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import secrets
import shlex
import socket
import subprocess
import sys

APP = "pulse-pair-code"
SCRIPT = "tools/runner/pair-code.py"
# services/api/src/runner-model.ts: ALPHABET, makeCode() and codeHash() (tests/core/test_runner_pair_code.py keeps them equal)
ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
CODE_PREFIX = "runner-code:"
HANDLE_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{1,62}$")
DEFAULT_HOSTS = "host-49a12d.internal.example"


def make_code(raw: bytes | None = None) -> str:
    raw = raw if raw is not None else secrets.token_bytes(8)
    s = "".join(ALPHABET[b % 32] for b in raw[:8])
    return f"{s[:4]}-{s[4:]}"


def code_hash(code: str) -> str:
    return hashlib.sha256(f"{CODE_PREFIX}{code}".encode()).hexdigest()


def lit(value: object) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def install_command(api_url: str) -> str:
    origin = api_url.rstrip("/")
    extra = "" if origin == "https://api.vitalsos.ai" else f" --api-url {origin}"
    return f"sudo npx --yes @vitalsos/pulse-runner connect --code <the code above>{extra}"


def psql_argv(runner: str, user: str, database: str) -> list[str]:
    argv = shlex.split(runner)
    if argv[:2] == ["docker", "exec"]:
        argv[2:2] = ["-e", f"PGAPPNAME={APP}"]
    conn = ["-U", user, "-d", database] if user else ["-d", database]
    return [*argv, "psql", *conn, "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1"]


def mint_script(org: str, handle: str, hashed: str, actor: str, approver: str, words: str, host: str) -> str:
    """One transaction: find the admin's seat, make the code exactly as the API does (as that admin, in that
    organisation, as pulse_api), then write the ledger as the operator. Any failure rolls all of it back."""
    return f"""\\set ON_ERROR_STOP on
begin;
set local lock_timeout = '15s';
set local statement_timeout = '60s';
select set_config('pair.org', o.id::text, true), set_config('pair.person', m.person_id::text, true),
       set_config('pair.name', p.display_name, true), set_config('pair.org_name', o.name, true)
  from pulse.org o
  join pulse_priv.account_member m on m.member_org = o.id
  join pulse_priv.pulse_account a on a.id = m.account_id
  join pulse.person p on p.id = m.person_id and p.org_id = o.id
 where o.handle = {lit(org)} and o.status = 'active' and a.handle = {lit(handle)} and p.status = 'active' and p.side = 'staff'
 limit 1;
do $c$ begin
  if coalesce(current_setting('pair.org', true), '') = '' then
    raise exception 'PAIR_REFUSED: no active organisation {org.replace("'", "")} with a staff seat for @{handle.replace("'", "")}' using errcode = '42501';
  end if;
end $c$;
-- What Settings → Servers & AI → "Add a server" does: pulse.runner_pair_code_create as the admin, in the organisation.
select set_config('pulse.org_id', current_setting('pair.org'), true), set_config('pulse.viewer_id', current_setting('pair.person'), true),
       set_config('pulse.actor_account', {lit(actor)}, true), set_config('pulse.agent_session', '', true);
set local role pulse_api;
select json_build_object('until', pulse.runner_pair_code_create({lit(hashed)}))::text;
reset role;
-- The ledger: the platform audit log, and (platform_log enters the organisation) the organisation's own Audit.
select set_config('pair.until', (select max(expires_at)::text from pulse_priv.runner_pair_code where code_hash = {lit(hashed)}), true);
select set_config('pulse.org_id', '', true), set_config('pulse.viewer_id', '', true), set_config('pulse.actor_account', {lit(actor)}, true);
select pulse.platform_log('runner.pair_code', current_setting('pair.org')::uuid, 'runner_pair_code', null, current_setting('pair.org_name'),
  {lit(words)}, jsonb_build_object('tool', {lit(SCRIPT)}, 'host', {lit(host)}, 'approver', {lit(approver)}, 'words', {lit(words)},
    'onBehalfOf', current_setting('pair.person'), 'onBehalfOfHandle', {lit(handle)}, 'expiresAt', current_setting('pair.until')));
select json_build_object('org', current_setting('pair.org'), 'orgName', current_setting('pair.org_name'),
  'admin', current_setting('pair.name'), 'until', current_setting('pair.until'))::text;
commit;
"""


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--org", required=True, help="the organisation's handle, e.g. estateautopilots")
    ap.add_argument("--approver", required=True, help="who approved this, e.g. \"Owner Name (owner)\"")
    ap.add_argument("--words", required=True, help="the approver's words, verbatim (they go in the audit log)")
    ap.add_argument("--as", dest="as_handle", default="savuzo", help="the organisation admin the code is made for (@handle)")
    ap.add_argument("--api-url", default=os.environ.get("PULSE_RUNNER_API_URL", "https://api.vitalsos.ai"),
                    help="the runner API this Pulse answers on (only for the hint printed on stderr)")
    ap.add_argument("--exec", default="docker exec -i ea-postgres", help='how to reach psql ("" for a local psql)')
    ap.add_argument("--db-user", default="ea_admin", help='("" when --database is a connection string)')
    ap.add_argument("--database", default="pulse")
    args = ap.parse_args(argv)

    approver, words = args.approver.strip(), args.words.strip()
    org, handle = args.org.strip().lower(), args.as_handle.strip().lstrip("@").lower()
    if len(approver) < 3 or len(words) < 4:
        print("Refused: --approver (a name) and --words (the approval, verbatim) are both needed.", file=sys.stderr)
        return 2
    if not HANDLE_RE.match(org) or not HANDLE_RE.match(handle):
        print("Refused: --org and --as take handles (letters, digits, dot, dash, underscore).", file=sys.stderr)
        return 2
    host = socket.gethostname()
    allowed = {h.strip() for h in os.environ.get("PULSE_PAIR_CODE_HOSTS", DEFAULT_HOSTS).split(",") if h.strip()}
    if host not in allowed:
        print(f"Refused: this tool runs only on the Pulse server ({', '.join(sorted(allowed))}), not on {host}.", file=sys.stderr)
        return 2

    actor = f"pair-code.py · approver: {approver}"[:120]
    approver, words = approver[:120], words[:380]
    for _ in range(4):
        code = make_code()
        proc = subprocess.run(psql_argv(args.exec, args.db_user, args.database),
                              input=mint_script(org, handle, code_hash(code), actor, approver, words, host).encode(),
                              capture_output=True, check=False)
        out, err = proc.stdout.decode("utf-8", "replace"), proc.stderr.decode("utf-8", "replace")
        if proc.returncode == 0:
            break
        if "runner_pair_code_code_hash_key" in err or "duplicate key" in err:
            continue                      # the same code waiting already (as the API, try another)
        msg = (re.findall(r"ERROR:\s*(.*)", err) or [err.strip()[-400:]])[-1]
        if "PAIR_REFUSED" in msg or "organisation admins" in msg or "Five codes" in msg:
            print(f"Refused: {msg.replace('PAIR_REFUSED: ', '')}", file=sys.stderr)
            return 2
        print(f"The database failed; no code was made: {msg}", file=sys.stderr)
        return 1
    else:
        print("Pulse could not make a code. Try again.", file=sys.stderr)
        return 1
    info = [json.loads(x) for x in out.splitlines() if x.startswith("{")][-1]
    print(f"Pairing code for {info['orgName']}, made for {info['admin']} (@{handle}), approved by {approver}. "
          f"Single use, until {info['until']}. Written to the platform audit log; the code itself is not.", file=sys.stderr)
    print(f"On the server to connect, run: {install_command(args.api_url)}", file=sys.stderr)
    print(code, flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
