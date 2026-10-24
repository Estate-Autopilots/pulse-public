#!/usr/bin/env python3
"""Link non-shared uploader accounts proven by Workspace directory metadata.

The Pulse connection must be the staging migration connection. This tool checks
both the database name and role before writing. It reads only ``ws_user`` from
the EA index and emits aggregate counts; account handles and person IDs stay in
memory and are written only to the staging Pulse database when ``--apply`` is
passed.
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from typing import Any

INDEX_ENV = Path("/etc/estate-autopilots/db/ea_index.env")


def normalized_email(value: str | None) -> str:
    return (value or "").strip().lower()


def staging_connection_allowed(database: str, role: str) -> bool:
    """Require the staging database as well as its owner role."""
    return database == "pulse_staging" and role == "pulse_staging_owner"


def plan_links(
    candidates: list[dict[str, Any]],
    directory_emails: set[str],
    people_by_email: dict[str, list[str]],
) -> tuple[list[dict[str, str]], int, int]:
    """Return proven links, directory matches, and already-linked matches."""
    links: list[dict[str, str]] = []
    directory_matches = 0
    already_linked = 0
    for candidate in candidates:
        handle = normalized_email(candidate["handle"])
        if handle not in directory_emails:
            continue
        directory_matches += 1
        person_ids = people_by_email.get(handle, [])
        if len(person_ids) != 1:
            continue
        person_id = person_ids[0]
        existing_holder = candidate.get("holder_person_id")
        if existing_holder:
            if existing_holder == person_id:
                already_linked += 1
            continue
        links.append({
            "account_id": candidate["account_id"],
            "handle": handle,
            "person_id": person_id,
        })
    return links, directory_matches, already_linked


def index_database_url() -> str:
    """Read the index URL without shell evaluation or printing it."""
    if os.environ.get("EA_INDEX_DATABASE_URL"):
        return os.environ["EA_INDEX_DATABASE_URL"]
    try:
        lines = INDEX_ENV.read_text().splitlines()
    except OSError as exc:
        raise RuntimeError("EA index connection is unavailable") from exc
    for line in lines:
        key, separator, value = line.partition("=")
        if separator and key.strip() == "DATABASE_URL":
            url = value.strip().strip("\"'")
            if url:
                return url
    raise RuntimeError("EA index connection is unavailable")


def outcome_counts(
    candidate_count: int,
    directory_matches: int,
    planned_links: int,
    already_linked: int,
    linked: int,
) -> dict[str, int]:
    """Summarize safe per-account outcomes without exposing account-level data."""
    pending = planned_links - linked
    refused = candidate_count - planned_links - already_linked
    return {
        "candidates": candidate_count,
        "directory_matches": directory_matches,
        "linked": linked,
        "already_linked": already_linked,
        "refused": refused,
        "pending": pending,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="commit the verified staging links")
    args = parser.parse_args()

    pulse_url = os.environ.get("PULSE_DATABASE_URL_MIGRATE")
    if not pulse_url:
        print("staging Pulse connection unavailable; no links changed", file=sys.stderr)
        return 2
    try:
        import psycopg
        from psycopg.rows import dict_row
    except ImportError:
        print("database driver unavailable; no links changed", file=sys.stderr)
        return 2

    try:
        # The configured index connection is read-only by database grant and session mode.
        # Keep the independent index read transaction scoped apart from Pulse writes.
        with psycopg.connect(index_database_url(), options="-c default_transaction_read_only=on") as index_db:  # noqa: SIM117
            with index_db.cursor() as cur:
                cur.execute("SET TRANSACTION READ ONLY")

                with psycopg.connect(pulse_url, row_factory=dict_row) as pulse_db:  # noqa: SIM117
                    with pulse_db.transaction():
                        pulse_db.execute("SET LOCAL ROLE pulse_staging_owner")
                        guard = pulse_db.execute(
                            "select current_database() as database, current_user as role"
                        ).fetchone()
                        if not staging_connection_allowed(guard["database"], guard["role"]):
                            raise RuntimeError("staging-only database guard failed")

                        orgs = pulse_db.execute(
                            "select id from pulse.org where code='EA' and status='active'"
                        ).fetchall()
                        if len(orgs) != 1:
                            raise RuntimeError("active EA organization is unavailable")
                        org_id = orgs[0]["id"]
                        pulse_db.execute("select set_config('pulse.org_id', %s, true)", (str(org_id),))
                        candidates = pulse_db.execute(
                            """select a.id::text account_id,a.handle,a.holder_person_id::text holder_person_id
                               from pulse.account a
                               where a.org_id=%s and a.provider='google' and not a.is_shared
                                 and exists (
                                   select 1 from pulse.delivery d
                                   where d.org_id=a.org_id and d.uploader_account=a.handle
                                 )
                               order by a.handle""",
                            (org_id,),
                        ).fetchall()
                        handles = [normalized_email(row["handle"]) for row in candidates]
                        if not handles:
                            directory_emails: set[str] = set()
                            people_by_email: dict[str, list[str]] = {}
                        else:
                            cur.execute(
                                "select lower(trim(email)) from ws_user "
                                "where suspended is false and lower(trim(email)) = any(%s)",
                                (handles,),
                            )
                            directory_emails = {row[0] for row in cur.fetchall()}
                            people = pulse_db.execute(
                                """select p.id::text person_id,lower(trim(pp.work_email)) email
                                   from pulse.person p
                                   join pulse_priv.person_private pp on pp.person_id=p.id
                                   where p.org_id=%s and p.status='active'
                                     and lower(trim(pp.work_email)) = any(%s)""",
                                (org_id, handles),
                            ).fetchall()
                            people_by_email = {}
                            for person in people:
                                people_by_email.setdefault(person["email"], []).append(person["person_id"])

                        links, directory_matches, already_linked = plan_links(
                            candidates, directory_emails, people_by_email
                        )
                        updated = 0
                        if args.apply:
                            for link in links:
                                changed = pulse_db.execute(
                                    """update pulse.account set holder_person_id=%s,purpose='Workspace account'
                                       where org_id=%s and id=%s and provider='google'
                                         and not is_shared and holder_person_id is null""",
                                    (link["person_id"], org_id, link["account_id"]),
                                ).rowcount
                                if changed != 1:
                                    raise RuntimeError("account changed during seed; transaction rolled back")
                                pulse_db.execute(
                                    """update pulse.people_profile pp set accounts=coalesce((
                                         select array_agg(a.handle order by a.handle) from pulse.account a
                                         where a.org_id=pp.org_id and a.holder_person_id=pp.person_id
                                           and a.provider='google'), '{}')
                                       where pp.org_id=%s and pp.person_id=%s""",
                                    (org_id, link["person_id"]),
                                )
                                pulse_db.execute(
                                    """insert into pulse.record_change
                                         (org_id,entity_type,entity_id,field,old_value,new_value,changed_by)
                                       values (%s,'person',%s,'account',null,%s,null)""",
                                    (org_id, link["person_id"], link["handle"]),
                                )
                                updated += 1
        action = "applied" if args.apply else "ready"
        counts = outcome_counts(
            len(candidates), directory_matches, len(links), already_linked, updated
        )
        print(
            f"candidates={counts['candidates']} "
            f"directory_matches={counts['directory_matches']} "
            f"linked={counts['linked']} already_linked={counts['already_linked']} "
            f"refused={counts['refused']} pending={counts['pending']} result={action}"
        )
        return 0
    except (OSError, RuntimeError, ValueError, psycopg.Error):
        # Driver exceptions may contain parameter values; never emit their text.
        print("seed failed; no personal values printed", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
