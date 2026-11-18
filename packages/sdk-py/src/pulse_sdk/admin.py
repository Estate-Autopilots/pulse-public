"""pulse-admin: set up and run a Pulse install from its own server, through the operator API (ADR-0031 §2).

    pulse-admin init --name "Northwind Studio" --slug northwind --code NWS --time-zone Europe/London \\
                     --admin-email admin@northwind.example --admin-name "Admin"
    pulse-admin status [--json]
    pulse-admin org set --name "Northwind Studio Ltd"
    pulse-admin grant --email hr@northwind.example --role hr
    pulse-admin revoke --email hr@northwind.example --role hr
    pulse-admin roles [--json]

The token comes from $PULSE_OPERATOR_TOKEN (the same value the API has); it is sent only as a bearer header and is
never printed. --url defaults to the API inside the container (http://127.0.0.1:8081): run it with
``docker exec <container> pulse-admin …``. init prints the first admin's temporary password once, on standard
output only; nothing is logged. Python standard library only. Exit codes: 0 ok, 1 refused or failed, 2 usage.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request

DEFAULT_URL = "http://127.0.0.1:8081"
ROLES = ("admin", "hr", "leadership", "privacy")
PREFIX = "/api/v1/operator/"
HINTS = {
    401: "the operator token was refused: PULSE_OPERATOR_TOKEN must match the API's value",
    404: "the operator API is off: set PULSE_OPERATOR_TOKEN for the API and restart it",
}


class AdminError(Exception):
    pass


def call(url: str, token: str, method: str, route: str, body: dict | None = None) -> dict:
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(url.rstrip("/") + PREFIX + route, data=data, method=method, headers={
        "authorization": f"Bearer {token}", "content-type": "application/json", "accept": "application/json",
        "user-agent": "pulse-admin"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as error:
        try:
            detail = json.loads(error.read() or b"{}")
        except ValueError:
            detail = {}
        message = detail.get("error") if isinstance(detail, dict) and isinstance(detail.get("error"), str) else None
        raise AdminError(f"{error.code}: {HINTS.get(error.code) or message or error.reason}") from None
    except (urllib.error.URLError, OSError) as error:
        raise AdminError(f"cannot reach the Pulse API at {url}: {getattr(error, 'reason', error)}") from None


def run_init(args: argparse.Namespace, token: str) -> int:
    result = call(args.url, token, "POST", "init", {
        "name": args.name, "slug": args.slug, "code": args.code, "timeZone": args.time_zone,
        "adminEmail": args.admin_email, "adminName": args.admin_name})
    print(f"Initialised {args.name} ({args.code}).")
    print(f"Company id:  {result['orgId']}")
    print(f"First admin: {args.admin_name} <{args.admin_email.strip().lower()}>")
    print(f"Username:    {result['username']}")
    print(f"Temporary password (shown once, change it at first sign-in): {result['temporaryPassword']}")
    return 0


def run_status(args: argparse.Namespace, token: str) -> int:
    result = call(args.url, token, "GET", "status")
    if args.json:
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0
    org = result.get("org") or {}
    if not result.get("initialised"):
        print(f"Not initialised (version {result.get('version')}): run pulse-admin init")
        return 0
    print(f"Initialised: {org.get('name')} (slug {org.get('slug')}, code {org.get('code')}, "
          f"time zone {org.get('time_zone')}) · version {result.get('version')}")
    return 0


def run_org_set(args: argparse.Namespace, token: str) -> int:
    call(args.url, token, "POST", "org", {"name": args.name})
    print(f"Company name set to {args.name}.")
    return 0


def run_role(args: argparse.Namespace, token: str) -> int:
    result = call(args.url, token, "POST", "roles", {"email": args.email, "role": args.role, "action": args.command})
    done = "Granted" if args.command == "grant" else "Revoked"
    print(f"{done} {args.role} {'to' if args.command == 'grant' else 'from'} {result['name']} "
          f"<{args.email.strip().lower()}>.")
    return 0


def run_roles(args: argparse.Namespace, token: str) -> int:
    roles = call(args.url, token, "GET", "roles")["roles"]
    if args.json:
        print(json.dumps(roles, indent=2, sort_keys=True))
        return 0
    if not roles:
        print("Nobody holds admin, hr, leadership or privacy.")
    for row in roles:
        inactive = "" if row["active"] else " (not active)"
        print(f"{row['role']:<11} {row['name']} <{row['email'] or '-'}> since {row['since']}{inactive}")
    return 0


def parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="pulse-admin", description=__doc__.split("\n\n")[0])
    url = argparse.ArgumentParser(add_help=False)
    url.add_argument("--url", default=argparse.SUPPRESS, help=f"operator API base URL (default: {DEFAULT_URL})")
    ap.add_argument("--url", default=DEFAULT_URL, help=f"operator API base URL (default: {DEFAULT_URL})")
    commands = ap.add_subparsers(dest="command", required=True)

    init = commands.add_parser("init", parents=[url], help="create the company and its first admin (once)")
    for flag, text in [("--name", "company name"), ("--slug", "company slug, e.g. northwind"),
                       ("--code", "2 to 4 capital letters, e.g. NWS"), ("--time-zone", "IANA name, e.g. Europe/London"),
                       ("--admin-email", "first admin's email"), ("--admin-name", "first admin's name")]:
        init.add_argument(flag, required=True, help=text)
    init.set_defaults(handler=run_init)

    status = commands.add_parser("status", parents=[url], help="show whether the install is initialised")
    status.add_argument("--json", action="store_true", help="print the raw JSON answer")
    status.set_defaults(handler=run_status)

    org = commands.add_parser("org", help="company settings").add_subparsers(dest="org_command", required=True)
    org_set = org.add_parser("set", parents=[url], help="rename the company")
    org_set.add_argument("--name", required=True, help="new company name")
    org_set.set_defaults(handler=run_org_set)

    for action, text in [("grant", "give a staff member a role (break-glass)"),
                         ("revoke", "end a staff member's role")]:
        role = commands.add_parser(action, parents=[url], help=text)
        role.add_argument("--email", required=True, help="the person's work email or one of their Google accounts")
        role.add_argument("--role", required=True, choices=ROLES)
        role.set_defaults(handler=run_role)

    roles = commands.add_parser("roles", parents=[url], help="who holds admin, hr, leadership and privacy")
    roles.add_argument("--json", action="store_true", help="print the raw JSON answer")
    roles.set_defaults(handler=run_roles)
    return ap


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    token = os.environ.get("PULSE_OPERATOR_TOKEN", "")
    if not token:
        print("pulse-admin: PULSE_OPERATOR_TOKEN is not set (use the API's operator token)", file=sys.stderr)
        return 2
    try:
        return args.handler(args, token)
    except AdminError as error:
        print(f"pulse-admin: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
