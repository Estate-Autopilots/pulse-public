"""LIFECYCLE: evidence that someone has probably left, for HR's review list ("Possibly left: confirm").

Reads exit mail (resignations, terminations, closure and experience letters, a withdrawn resignation) and the
Workspace directory from the read-only EA index, and Pulse's roster import; writes pulse.lifecycle_signal and lets
pulse.lifecycle_detect() rebuild the proposals with Pulse's own evidence (salary sheets, quiet weeks). It changes no
person, sends nothing and never touches Workspace. Summaries are plain words ("Resignation mail to HR, 21 Sep 2026");
message text is never stored or printed, and the receipt it prints holds counts only.

    python -m pulse_workers.lifecycle_scan --org UUID [--dry-run] [--today YYYY-MM-DD]

EA_INDEX_DATABASE_URL: the read-only EA index. PULSE_DATABASE_URL_WORKER (or DATABASE_URL): Pulse, worker role.
"""

from __future__ import annotations

import argparse
import html
import json
import re
import sys
import uuid
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

IST = ZoneInfo("Asia/Kolkata")
MONTHS = {
    m: i for i, m in enumerate(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1)
}
# What a letter is, from its subject; a withdrawn resignation is read from the reply itself.
KINDS = (
    ("terminated", re.compile(r"\bterminat", re.I)),
    ("closed", re.compile(r"closure|relieving|experience\s+letter|full\s*(?:and|&)\s*final|\bf\s*&\s*f\b", re.I)),
    ("resigned", re.compile(r"\bresign", re.I)),
)
CANCEL = re.compile(
    r"(?:cancel+ed|withdr[ae]wn?|taken back|revoked?)\s+(?:my\s+)?resignation"
    r"|resignation\s+(?:is\s+|has been\s+)?(?:cancel+ed|withdrawn)",
    re.I,
)
REPLY = re.compile(r"^\s*(?:re|fwd?|fw)\s*:", re.I)
# Words that follow "Dear" without naming a person.
GENERIC = {"management", "hr", "team", "sir", "mam", "maam", "madam", "all", "employee", "employees", "candidate"}
DATE = r"(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})"
LAST_DAY = (
    re.compile(r"last\s+working\s+day\W{0,3}(?:is|will\s+be|being|on|as)?\W{0,3}" + DATE, re.I),
    re.compile(DATE + r"\s+(?:being|as|will\s+be|is)\s+my\s+last\s+working\s+day", re.I),
    re.compile(r"effective\s+from\s+[^.]{0,40}?\bto\s+" + DATE, re.I),
    re.compile(r"effective\s+(?:from\s+)?" + DATE, re.I),
)


@dataclass
class Person:
    id: uuid.UUID
    name: str
    status: str
    joined: date | None = None


@dataclass
class Signal:
    person_id: uuid.UUID | None
    source: str
    kind: str
    observed_on: date
    weight: int
    summary: str
    ref: str
    last_day: date | None = None
    written_name: str | None = None


def norm(s: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^a-z ]", " ", s.lower())).strip()


def day(d: date) -> str:
    return f"{d.day} {d.strftime('%b %Y')}"


def last_day(text: str) -> date | None:
    for pattern in LAST_DAY:
        m = pattern.search(text)
        if m:
            dd, mon, yy = m.groups()[-3:]
            month = MONTHS.get(mon[:3].lower())
            if month:
                try:
                    return date(int(yy), month, int(dd))
                except ValueError:
                    continue
    return None


def kind_of(subject: str, snippet: str) -> str | None:
    if CANCEL.search(snippet) or CANCEL.search(subject):
        return "cancelled"
    if REPLY.match(subject):
        return None  # an acknowledgement or a thread reply: the letter itself is the evidence
    for kind, pattern in KINDS:
        if pattern.search(subject):
            return kind
    return None


def _display(from_addr: str) -> tuple[str, str]:
    m = re.match(r"\s*\"?([^<\"]*)\"?\s*<([^>]+)>", from_addr or "")
    return (m.group(1).strip(), m.group(2).strip().lower()) if m else ("", (from_addr or "").strip().lower())


def names_in(kind: str, subject: str, from_addr: str, snippet: str, hr_mailboxes: set[str]) -> list[str]:
    """The person a letter is about: named in the subject ("Resignation Letter – Ridihu Sulis"), the sender of their
    own resignation, or the person HR greets in a letter it sent ("Dear Adunor Wekupu,")."""
    out: list[str] = []
    m = re.search(r"\s[–—-]\s+([A-Za-z][A-Za-z.]*(?:\s+[A-Za-z][A-Za-z.]*){0,3})\s*(?:\||$)", subject)
    if m and "working" not in m.group(1).lower():
        out.append(m.group(1))
    name, addr = _display(from_addr)
    if (
        kind in ("resigned", "cancelled")
        and name
        and addr not in hr_mailboxes
        and "estate autopilots" not in name.lower()
    ):
        out.append(re.sub(r"\s+EA$", "", name, flags=re.I))
    if kind in ("terminated", "closed"):
        g = re.search(r"(?:^|\s)(?:Dear|Hi|Hello)\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,2})\s*[,!]", snippet)
        if g:
            out.append(g.group(1))
    seen: list[str] = []
    for n in out:
        n = " ".join(w.capitalize() if w.isupper() else w for w in n.split())
        if n and norm(n) not in GENERIC and norm(n) not in [norm(s) for s in seen]:
            seen.append(n)
    return seen


def match(name: str, people: list[Person], aliases: dict[str, list[str]]) -> list[uuid.UUID]:
    """Exact names and the roster's aliases first. A first name alone is used only when exactly one name in the team
    starts with it ("Aum" → Amen Lazuno), and a full name only reaches a record that holds just its first name
    ("Sefozalu Kharad" → "Sefozalu"). "Omoza Dendge" never becomes Omoza Ubuk."""
    n = norm(name)
    if not n:
        return []
    alias_of = {norm(a): norm(canon) for canon, names in aliases.items() for a in names}
    target = alias_of.get(n, n)
    exact = [p.id for p in people if norm(p.name) == target]
    if exact:
        return exact
    first = n.split()[0]
    same = [p for p in people if norm(p.name).split()[:1] == [first]]
    if len({norm(p.name) for p in same}) != 1:
        return []
    if len(n.split()) == 1 or all(len(norm(p.name).split()) == 1 for p in same):
        return [p.id for p in same]
    return []


def exact(name: str, people: list[Person], aliases: dict[str, list[str]]) -> bool:
    alias_of = {norm(a): norm(canon) for canon, names in aliases.items() for a in names}
    return any(norm(p.name) == alias_of.get(norm(name), norm(name)) for p in people)


def mail_signals(
    rows: list[dict], people: list[Person], aliases: dict[str, list[str]], hr_mailboxes: set[str]
) -> list[Signal]:
    out: dict[str, Signal] = {}
    by_id = {p.id: p for p in people}
    letters = []
    for r in sorted(rows, key=lambda r: r["sent_at"]):
        subject, snippet = html.unescape(r["subject"] or ""), html.unescape(r["snippet"] or "")
        kind = kind_of(subject, snippet)
        if kind:
            letters.append(
                (r, subject, snippet, kind, names_in(kind, subject, r["from_addr"] or "", snippet, hr_mailboxes))
            )
    # A first name alone is not trusted when another exit letter names someone else with that first name ("Dear
    # Omoza," after "Omoza Dendge" resigned is not Omoza Ubuk).
    elsewhere = {
        norm(n).split()[0]
        for *_, names in letters
        for n in names
        if len(norm(n).split()) > 1 and not match(n, people, aliases)
    }
    for r, subject, snippet, kind, names in letters:
        on = r["sent_at"].astimezone(IST).date()
        last = last_day(subject + " " + snippet) if kind != "cancelled" else None
        if last and abs((last - on).days) > 200:
            last = None
        for written in names or [""]:
            ids = match(written, people, aliases) if written else []
            if ids and not exact(written, people, aliases) and norm(written).split()[0] in elsewhere:
                ids = []
            # Nobody leaves before they joined: a letter from before someone's joining date is about someone else.
            ids = [i for i in ids if not (by_id[i].joined and on < by_id[i].joined)]
            what = {
                "resigned": "Resignation mail to HR",
                "terminated": "Termination notice from HR",
                "closed": "Closure or experience letter from HR",
                "cancelled": "Resignation withdrawn by mail",
            }[kind]
            summary = f"{what}, {day(on)}" + (f" (last working day {day(last)})" if last else "")
            for pid in ids or [None]:
                if pid is None and not written:
                    continue
                key = f"mail:{kind}:{pid or norm(written)}:{on.isoformat()}"
                out.setdefault(
                    key,
                    Signal(
                        pid,
                        "mail",
                        kind,
                        on,
                        1 if kind == "cancelled" else 3,
                        summary,
                        key,
                        last,
                        None if pid else written,
                    ),
                )
            if ids:
                break  # the first name that matches is the person the letter is about
    return list(out.values())


def workspace_signals(users: list[dict], holders: dict[str, list[uuid.UUID]], today: date) -> list[Signal]:
    out = []
    for u in users:
        email = (u["email"] or "").lower()
        for pid in holders.get(email, []):
            if u.get("suspended"):
                out.append(
                    Signal(
                        pid,
                        "workspace",
                        "suspended",
                        today,
                        3,
                        f"Workspace account {email} is suspended",
                        f"ws:suspended:{email}:{pid}",
                    )
                )
                continue
            created = u["created"].astimezone(IST).date() if u.get("created") else None
            last = (
                u["last_login"].astimezone(IST).date() if u.get("last_login") and u["last_login"].year > 1971 else None
            )
            if (
                created
                and created <= today - timedelta(days=30)
                and (last is None or last <= today - timedelta(days=30))
            ):
                text = (
                    f"No Workspace sign-in since {day(last)}"
                    if last
                    else f"Never signed in to Workspace (account from {day(created)})"
                )
                out.append(
                    Signal(pid, "workspace", "no_signin", last or created, 2, text, f"ws:no_signin:{email}:{pid}")
                )
    return out


def roster_signals(
    listed: list[str], imported_on: date | None, people: list[Person], aliases: dict[str, list[str]]
) -> list[Signal]:
    """Current people the latest roster import does not list (weak: a roster can be partial)."""
    if not imported_on or len(listed) < 10:
        return []
    found = {pid for n in listed for pid in match(n, people, aliases)}
    return [
        Signal(
            p.id,
            "roster",
            "not_listed",
            imported_on,
            1,
            f"Not on the roster import of {day(imported_on)}",
            f"roster:{p.id}",
        )
        for p in people
        if p.status == "active" and p.id not in found
    ]


def load_aliases() -> dict[str, list[str]]:
    path = Path(__file__).resolve().parents[4] / "config/ea-team.json"
    try:
        return json.loads(path.read_text()).get("name_aliases", {})
    except (OSError, ValueError):
        return {}


def run(args) -> dict:
    import os

    import psycopg
    from psycopg.rows import dict_row

    from pulse_sdk.db import connect, tenant_tx

    org = uuid.UUID(args.org)
    today = date.fromisoformat(args.today) if args.today else datetime.now(IST).date()
    aliases = load_aliases()
    with (
        psycopg.connect(os.environ["EA_INDEX_DATABASE_URL"], row_factory=dict_row, autocommit=True) as index,
        connect("worker") as conn,
    ):
        with tenant_tx(conn, org):
            people = [
                Person(r["id"], r["display_name"], r["status"], r["joined"])
                for r in conn.execute(
                    """select p.id,p.display_name,p.status,coalesce(pp.joined_on,p.active_from) joined from
                       pulse.person p left join pulse.people_profile pp on pp.person_id=p.id
                   where p.side='staff' and not exists(select 1 from pulse.record_merge m where
                      m.entity_type='person' and m.gone_id=p.id and m.undone_at is null)"""
                ).fetchall()
            ]
            holders: dict[str, list[uuid.UUID]] = {}
            for r in conn.execute("""select lower(a.handle) handle,a.holder_person_id pid from pulse.account a join
               pulse.person p on p.id=a.holder_person_id
                                     where a.provider='google' and not a.is_shared and a.purpose like 'Workspace%'
                                        and p.side='staff'""").fetchall():
                holders.setdefault(r["handle"], []).append(r["pid"])
            hr_boxes = {
                r["handle"]
                for r in conn.execute(
                    """select lower(a.handle) handle from pulse.account a join pulse.role_assignment r on
                       r.person_id=a.holder_person_id
                   where a.provider='google' and r.role_key='hr' and current_date between r.valid_from and
                      coalesce(r.valid_to,'infinity')"""
                ).fetchall()
            }
            hr_boxes.add("hr@estateautopilots.com")
            roster = conn.execute("""select o.payload->>'name' name,b.imported_at::date on_ from
               pulse.source_observation o join pulse.import_batch b on b.id=o.import_id
                                     where o.dataset='people' and b.id=(select id from pulse.import_batch where
                                        dataset='people' order by imported_at desc limit 1)""").fetchall()
        # Letters a person and HR exchange; marketing mail never matches the letter subjects these patterns read.
        mails = index.execute(
            r"""select distinct on (lower(subject),from_addr,sent_at::date) subject,from_addr,snippet,sent_at from
               gmail_message
                where (subject ~* '(resign|terminat|closure|relieving|experience letter|full\s*(and|&)\s*final)' or
                   snippet ~* '(cancel+ed|withdr[ae]wn?)\s+(my\s+)?resignation')
                  and sent_at > now() - interval '3 years'"""
        ).fetchall()
        users = index.execute("select email,suspended,created,last_login from ws_user").fetchall()
        signals = (
            mail_signals(mails, people, aliases, hr_boxes)
            + workspace_signals(users, holders, today)
            + roster_signals(
                [r["name"] for r in roster if r["name"]], roster[0]["on_"] if roster else None, people, aliases
            )
        )
        receipt = {
            "org": str(org)[:8],
            "today": today.isoformat(),
            "dryRun": args.dry_run,
            "mails": len(mails),
            "signals": {s: sum(1 for x in signals if x.source == s) for s in ("mail", "workspace", "roster")},
            "unmatched": sum(1 for x in signals if x.person_id is None),
        }
        if args.dry_run:
            return receipt
        with tenant_tx(conn, org):
            refs = [s.ref for s in signals]
            conn.execute(
                "update pulse.lifecycle_signal set retired_at=now() where source in ('mail','workspace','roster')"
                " and retired_at is null and not (ref = any(%s))",
                (refs,),
            )
            for s in signals:
                conn.execute(
                    """insert into pulse.lifecycle_signal(org_id,person_id,source,kind,observed_on,last_day,weight,
                       summary,
                         written_name,ref)
                       values(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) on conflict(org_id,source,ref) do update set
                          person_id=excluded.person_id,kind=excluded.kind,
                       observed_on=excluded.observed_on,last_day=excluded.last_day,weight=excluded.weight,summary=excluded.summary,written_name=excluded.written_name,
                       seen_at=now(),retired_at=null""",
                    (
                        org,
                        s.person_id,
                        s.source,
                        s.kind,
                        s.observed_on,
                        s.last_day,
                        s.weight,
                        s.summary[:240],
                        s.written_name,
                        s.ref,
                    ),
                )
            receipt["people"] = conn.execute("select pulse.lifecycle_detect() n").fetchone()["n"]
            receipt["open"] = conn.execute(
                "select count(*) n from pulse.lifecycle_review where status='open'"
            ).fetchone()["n"]
        return receipt


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="pulse_workers.lifecycle_scan", description=__doc__.split("\n\n")[0])
    parser.add_argument("--org", required=True)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--today")
    receipt = run(parser.parse_args(argv))
    receipt["at"] = datetime.now(UTC).isoformat(timespec="seconds")
    print(json.dumps(receipt))
    return 0


if __name__ == "__main__":
    sys.exit(main())
