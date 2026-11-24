#!/usr/bin/env python3
"""A tester register (CSV) kept in step with an organisation's Contacts (AC-CONTACTS-2, owner, 18 Nov 2026: "file the Sales
X-Ray tester register as contacts ... and keep it syncing").

    python3 tools/admin/sync-testers.py REGISTER.csv --org <organisation id> --as <admin username> \\
        --approver "Owner Name (owner)" --came-from "Sales X-Ray Play testers" \\
        [--own-domain example.com ...] [--own-label owner ...] [--apply] [--log FILE]

  * Each row goes through API v1's own add_contact and update_contact (services/api, v1-money.ts: the AI tools' and the
    Contacts screens' code), run by tools/admin/sync-testers.mjs on one transaction as the --as admin, with the approver
    as the audit actor. Nothing writes a contact table directly. services/api must be built (dist) in --tree.
  * add_contact looks for the person first (phone's last 10 digits, e-mail, exact name). A match on the name alone is
    used only when the company is the same too; two matches, or a name match at another company, are left for a person
    to sort out. Never a second copy.
  * Tags: `tester` on every row; `prospect` too unless the person is our own or their company is a client (a client in
    Vitals, or someone there tagged or marked `client`); `staff` for our own accounts already in Contacts. Our own
    accounts (--own-domain, --own-label, and anyone who is staff or an AI member of the organisation) are never added.
  * Status from the register: `invited` (in the tester group), `installed`, `active`, `stopped`, else `new`. The
    register only moves a status forward on the tester path (new → invited → installed → active, or to stopped); a
    status set by a person (client, talking, not_now) or a later step is kept. Device: Android → android, iOS → iphone.
  * An existing contact keeps its name, company and tags; only missing tags, an empty e-mail, phone, device or "came
    from", and a forward status are added, with one dated note saying what changed. A row already in step changes
    nothing: running the same register twice writes nothing the second time.
  * The register's name is used as it is; a row without a name is filed under its e-mail, and its note says so.
  * Dry run by default: everything runs, then ROLLBACK. --apply commits. Any error: nothing is written.
  * Runs only on the Pulse server (PULSE_ADMIN_TOOL_HOSTS, default host-49a12d.internal.example), as the database's API login
    (--dsn-env FILE:VAR, default the server's pulse.env, PULSE_DATABASE_URL_API) so row security applies as in the API.

Register columns (header names; others are ignored): email, name, phone, company, platform or device, invited or
status_on (YYYY-MM-DD), status, installed, tags (";"), note. The register names real people: keep it out of git.

Exit codes: 0 done (or the dry run worked); 2 refused (arguments, host, register); 1 a row or the database failed.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import socket
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote, urlencode

SCRIPT = "tools/admin/sync-testers.py"
RUNNER = Path(__file__).resolve().with_name("sync-testers.mjs")
DEFAULT_HOSTS = "host-49a12d.internal.example"
DEFAULT_DSN_ENV = "/etc/estate-autopilots/db/pulse.env:PULSE_DATABASE_URL_API"
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
DAY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
TAG_WORDS = {"tester", "prospect", "client", "staff"}


class Refused(Exception):
    pass


def status_of(row: dict) -> str:
    """The register's status words → a contact status (the tester path only)."""
    s = (row.get("status") or "").strip().lower()
    installed = (row.get("installed") or "").strip().lower()
    if installed.startswith("yes") and s.startswith("invited"):      # the Play Console shows the install
        return "installed"
    for word, status in (("active", "active"), ("installed", "installed"), ("opted in", "installed"), ("stopped", "stopped"),
                         ("left", "stopped"), ("invited", "invited")):
        if s.startswith(word):
            return status
    return "new"


def device_of(row: dict) -> str | None:
    d = (row.get("device") or row.get("platform") or "").strip().lower()
    return {"android": "android", "ios": "iphone", "iphone": "iphone", "both": "both"}.get(d, "other" if d else None)


def plan_row(n: int, row: dict, own_domains: set[str], own_labels: set[str]) -> dict:
    email = (row.get("email") or "").strip().lower()
    phone = (row.get("phone") or "").strip()
    if email and not EMAIL_RE.match(email):
        raise Refused(f"row {n}: “{email[:60]}” is not an e-mail address")
    if not email and len(re.sub(r"\D", "", phone)) < 6:
        raise Refused(f"row {n}: no e-mail and no phone; the row cannot be matched")
    name = re.sub(r"\s+", " ", (row.get("name") or "")).strip()
    raw_company = re.sub(r"\s+", " ", (row.get("company") or "")).strip()
    company = re.sub(r"\s*\([^)]*\)\s*$", "", raw_company).strip()   # "Willow Lane (Sakobe Putig)" → "Willow Lane"
    tags = ["tester"] + [t.strip().lower() for t in (row.get("tags") or "").split(";") if t.strip()]
    if company.lower() in TAG_WORDS:                                    # "prospect (owner, 18 Nov)" is a label, not a company
        tags.append(company.lower())
        company = ""
    own = (email.rsplit("@", 1)[-1] in own_domains) or company.lower() in own_labels or raw_company.lower() in own_labels
    since = next((row.get(k, "").strip() for k in ("status_on", "invited") if DAY_RE.match(row.get(k, "").strip())), "")
    status = status_of(row)
    said = [f"register status “{(row.get('status') or '').strip()[:80]}”" if row.get("status") else "",
            f"in the tester group since {since}" if since and status != "new" else "",
            f"installed: {row['installed'].strip()[:60]}" if (row.get("installed") or "").strip() else "",
            f"company in the register: “{raw_company[:80]}”" if raw_company and raw_company != company else "",
            (row.get("note") or "").strip()[:300]]
    return {"row": n, "email": email or None, "phone": phone or None, "name": name or None, "label": name or email or phone,
            "company": None if own else (company or None), "companyLabel": raw_company or None, "tags": list(dict.fromkeys(tags)),
            "own": own, "status": status, "since": since or None, "device": device_of(row),
            "said": "; ".join(x for x in said if x)}


def load_register(path: Path, own_domains: set[str], own_labels: set[str]) -> list[dict]:
    try:
        text = path.read_text(encoding="utf-8-sig")
    except OSError as e:
        raise Refused(f"cannot read the register: {e.strerror}") from e
    reader = csv.DictReader(text.splitlines())
    if not reader.fieldnames or "email" not in reader.fieldnames:
        raise Refused("the register needs a header row with an email column")
    plan, seen = [], {}
    for n, row in enumerate(reader, 1):
        item = plan_row(n, {k.strip().lower(): (v or "") for k, v in row.items() if k}, own_domains, own_labels)
        key = item["email"] or re.sub(r"\D", "", item["phone"] or "")[-10:]
        if key in seen:
            raise Refused(f"rows {seen[key]} and {n} are the same person ({'e-mail' if item['email'] else 'phone'}); keep one")
        seen[key] = n
        plan.append(item)
    if not plan:
        raise Refused("the register has no rows")
    return plan


def as_url(dsn: str) -> str:
    """node-pg reads URLs only: a libpq "host=… dbname=…" string becomes a postgresql URL (host, port and the rest as
    query parameters, which node-pg prefers to the URL's own host)."""
    if dsn.startswith(("postgres://", "postgresql://")):
        return dsn
    kv = {k: v[1:-1].replace("\\'", "'").replace("\\\\", "\\") if v.startswith("'") else v
          for k, v in re.findall(r"(\w+)\s*=\s*('(?:[^'\\]|\\.)*'|\S+)", dsn)}
    user, password, db = kv.pop("user", ""), kv.pop("password", ""), kv.pop("dbname", "")
    auth = quote(user, safe="") + (":" + quote(password, safe="") if password else "") + ("@" if user else "")
    return f"postgresql://{auth}localhost/{quote(db, safe='')}" + ("?" + urlencode(kv) if kv else "")


def dsn_from(spec: str) -> str:
    file, _, var = spec.rpartition(":")
    try:
        for line in Path(file).read_text(encoding="utf-8").splitlines():
            if line.startswith(var + "="):
                return line.split("=", 1)[1].strip().strip("'\"")
    except OSError as e:
        raise Refused(f"cannot read {file}: {e.strerror}") from e
    raise Refused(f"{var} is not in {file}")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0], formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("register", type=Path)
    ap.add_argument("--org", required=True, help="the organisation's id")
    ap.add_argument("--as", dest="as_user", required=True, help="the admin's username in that organisation (who acts)")
    ap.add_argument("--approver", required=True, help='who approved the sync, e.g. "Owner Name (owner)"')
    ap.add_argument("--came-from", required=True, help='"where they came from" for new rows, e.g. "Sales X-Ray Play testers"')
    ap.add_argument("--own-domain", action="append", default=[], help="e-mail domain of our own accounts (never added)")
    ap.add_argument("--own-label", action="append", default=[], help='company words that mean our own account, e.g. "owner"')
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--log", type=Path, help="write every answer, with ids, phones and e-mails, to this file (mode 600)")
    ap.add_argument("--tree", type=Path, default=Path(__file__).resolve().parents[2], help="a Pulse checkout with services/api built")
    ap.add_argument("--dsn-env", default=DEFAULT_DSN_ENV, help="FILE:VAR holding the API login's connection string")
    ap.add_argument("--database", default="", help="a connection string instead of --dsn-env (tests)")
    args = ap.parse_args(argv)

    host = socket.gethostname()
    allowed = {h.strip() for h in os.environ.get("PULSE_ADMIN_TOOL_HOSTS", DEFAULT_HOSTS).split(",") if h.strip()}
    try:
        if host not in allowed:
            raise Refused(f"this tool runs only on the Pulse server ({', '.join(sorted(allowed))}), not on {host}")
        if len(args.approver.strip()) < 3 or len(args.came_from.strip()) < 3:
            raise Refused("--approver and --came-from need words")
        if not re.fullmatch(r"[0-9a-f-]{36}", args.org):
            raise Refused("--org is the organisation's id (a UUID)")
        built = args.tree / "services/api/dist/v1-money.js"
        if not built.is_file() or "addContact" not in built.read_text(encoding="utf-8"):
            raise Refused(f"services/api in {args.tree} is not built with add_contact (AC-CONTACTS): build it, or give --tree")
        plan = load_register(args.register, {d.strip().lower().lstrip("@") for d in args.own_domain if d.strip()},
                             {x.strip().lower() for x in args.own_label if x.strip()})
        dsn = as_url(args.database or dsn_from(args.dsn_env))
    except Refused as e:
        print(f"Refused (nothing was written): {e}", file=sys.stderr)
        return 2

    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    job = {"tree": str(args.tree), "org": args.org, "as": args.as_user, "apply": args.apply, "cameFrom": args.came_from.strip()[:120],
           "actor": f"sync-testers.py · approver: {args.approver.strip()}"[:120], "today": stamp,
           "register": args.register.name, "items": plan}
    proc = subprocess.run(["node", str(RUNNER)], input=json.dumps(job).encode(), capture_output=True, check=False,
                          env={**os.environ, "SYNC_TESTERS_DSN": dsn}, timeout=600)
    out = proc.stdout.decode("utf-8", "replace")
    answers = [json.loads(x) for x in out.splitlines() if x.startswith("{")]
    if args.log:
        args.log.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(args.log, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        with os.fdopen(fd, "a", encoding="utf-8") as f:
            for a in answers:
                f.write(json.dumps(a, ensure_ascii=False) + "\n")
    tally: dict[str, int] = {}
    for a in answers:
        if a.get("kind") == "row":
            tally[a["result"]] = tally.get(a["result"], 0) + 1
            print(f"row {a['row']:>3}  {a['result']:<14} {a.get('name') or '-'}  {a.get('why') or ''}".rstrip())
    end = next((a for a in answers if a.get("kind") in ("end", "error")), None)
    print(json.dumps({"apply": args.apply, "rows": len(plan), "results": tally, "testers": (end or {}).get("testers")}, ensure_ascii=False))
    if proc.returncode != 0 or not end or end.get("kind") == "error":
        why = (end or {}).get("error") or proc.stderr.decode("utf-8", "replace").strip()[-600:]
        print(f"Failed; nothing was written: {why}", file=sys.stderr)
        return 1
    print("Applied." if args.apply else "Dry run: everything rolled back. Run again with --apply to commit.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
