"""Useful text and lossless compressed facts from approved Drive roots (R45, plan P25).

Files come only from the R44 feed's accepted state (pulse.drive_source_file) of roots that are tracked, approved, and
have a content approval in force: there is no Drive listing or search here and no unrestricted scan. Each run is
bounded (files and bytes per root). For each file the worker decides before fetching (excluded, unsupported,
quarantined by type or size), fetches at most the approved size, extracts in the sandbox, screens the text, and then
stores in one transaction that first rechecks the approval and the file's state: a capture is never written for a
file that left the root, changed version or lost its approval while it was being read.

What was captured stays when the raw file goes: deletion, unsharing or a move out of the root only change what
pulse.drive_text() lets people read. Nothing here deletes or updates a capture or a payload.
"""

from __future__ import annotations

import hashlib
import re
import uuid
from collections.abc import Callable, Mapping
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from typing import Any

import psycopg

from pulse_gdrive_changes import feed
from pulse_gdrive_changes.drive import AccessLost, DriveError
from pulse_sdk.db import tenant_tx

from . import payload as pl
from .content import DriveContent, Flagged, TooLarge
from .extract import (
    DEFAULT_MEMORY,
    DEFAULT_TIMEOUT,
    FORMAT_GAPS,
    FORMAT_KEYS,
    FORMATS,
    GOOGLE_EXPORT_LIMIT,
    Outcome,
    plan,
    run_extractor,
    screen,
)

EXTRACTOR = "pulse-drive-extract/1.0.0"
COLLECTOR = "gdrive_extract"
DEFAULT_FILES_PER_RUN = 25
DEFAULT_BYTES_PER_RUN = 100 * 1024 * 1024
FOLDER_MIME = "application/vnd.google-apps.folder"
ROLE = re.compile(r"^[a-z_]{2,40}$")
VERSION_SQL = """case when f.md5 is not null then 'md5:' || f.md5
  else 'modified:' || coalesce(to_char(f.modified_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), 'unknown')
  end"""
POLICY_SQL = """
select p.source_id as id, p.org_id, p.formats, p.audience, p.max_bytes, p.enabled, p.approved_at, p.withdrawn_at,
       s.kind, s.drive_id, s.root_id, s.subject, s.credential_ref, s.install_id, s.enabled as root_enabled,
       s.approved_at as root_approved_at, s.status as root_status
  from pulse.drive_extract_policy p join pulse.drive_source s on s.id = p.source_id
 where p.source_id = %s
"""
CANDIDATES_SQL = f"""
select f.file_id, f.name, f.mime, f.parents, f.size, f.modified_at, {VERSION_SQL} as version
  from pulse.drive_source_file f
 where f.source_id = %(source)s and f.availability = 'available' and f.mime <> '{FOLDER_MIME}'
   and not exists (select 1 from pulse.drive_extract x where x.source_id = f.source_id and x.file_id = f.file_id
                     and x.source_version = {VERSION_SQL} and x.extractor = %(extractor)s)
 order by f.last_change_at, f.file_id
 limit %(limit)s
"""
CURRENT_SQL = f"""select availability, {VERSION_SQL} as version from pulse.drive_source_file f
                   where f.source_id = %s and f.file_id = %s"""


class _Stop(Exception):
    """The provider asked us to wait (rate limit, outage): stop this root's run; nothing is recorded for the file."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


@dataclass
class RunResult:
    source: str
    status: str
    files: int = 0
    extracted: int = 0
    quarantined: int = 0
    unsupported: int = 0
    excluded: int = 0
    failed: int = 0
    duplicates: int = 0
    skipped: int = 0
    fetched_bytes: int = 0
    error_code: str | None = None

    def summary(self) -> dict[str, Any]:
        """Counts and codes only: no file name, text, account or token."""
        return asdict(self)


@dataclass(frozen=True)
class Limits:
    files_per_run: int = DEFAULT_FILES_PER_RUN
    bytes_per_run: int = DEFAULT_BYTES_PER_RUN
    timeout: float = DEFAULT_TIMEOUT
    memory: int = DEFAULT_MEMORY


DEFAULT_LIMITS = Limits()


def in_force(policy: Mapping[str, Any] | None) -> bool:
    """A content approval is in force while it is approved and not withdrawn and its R44 root is tracked."""
    return bool(policy and policy["enabled"] and policy["approved_at"] and policy["withdrawn_at"] is None
                and policy["root_enabled"] and policy["root_approved_at"] and policy["root_status"] != "access_lost")


def load_policy(conn: psycopg.Connection, source_id: uuid.UUID | str) -> dict[str, Any] | None:
    row = conn.execute(POLICY_SQL, (source_id,)).fetchone()
    return dict(row) if row else None


# ------------------------------------------------------------------------------------------------------------ run
def run_source(conn: psycopg.Connection, api: DriveContent, org_id: uuid.UUID | str, source_id: uuid.UUID | str, *,
               limits: Limits = DEFAULT_LIMITS, now: Callable[[], datetime] = lambda: datetime.now(UTC)) -> RunResult:
    org = uuid.UUID(str(org_id))
    with tenant_tx(conn, org):
        policy = load_policy(conn, source_id)
    if not in_force(policy):
        return RunResult(str(source_id), "not_approved")
    result = RunResult(str(source_id), "ok")
    lock = f"{org}:{COLLECTOR}:{source_id}"
    if not conn.execute("select pg_try_advisory_lock(hashtextextended(%s, 0)) as ok", (lock,)).fetchone()["ok"]:
        return RunResult(str(source_id), "busy")
    try:
        with tenant_tx(conn, org):
            rows = conn.execute(CANDIDATES_SQL, {"source": source_id, "extractor": EXTRACTOR,
                                                 "limit": limits.files_per_run}).fetchall()
        scope = feed.Scope(conn, api, policy)
        for row in rows:
            if result.fetched_bytes >= limits.bytes_per_run:
                result.skipped += len(rows) - result.files
                break
            result.files += 1
            _file(conn, api, org, policy, dict(row), scope, limits, result)
    except _Stop as stop:
        result.status, result.error_code = "waiting", stop.code
    finally:
        conn.execute("select pg_advisory_unlock(hashtextextended(%s, 0))", (lock,))
        with tenant_tx(conn, org):
            conn.execute("update pulse.drive_extract_policy set last_run_at = %s, last_error_code = %s "
                         "where source_id = %s", (now(), result.error_code, source_id))
    return result


def _file(conn: psycopg.Connection, api: DriveContent, org: uuid.UUID, policy: Mapping[str, Any],
          row: dict[str, Any], scope: feed.Scope, limits: Limits, result: RunResult) -> None:
    meta = {"name": row["name"], "parents": list(row["parents"] or []), "mime": row["mime"]}
    try:
        with tenant_tx(conn, org):
            inside, names = scope.locate(row["file_id"], meta)
    except AccessLost:
        inside, names = False, [row["name"]]
    except DriveError as exc:
        raise _Stop(exc.code) from None
    known = FORMATS.get((row["mime"] or "").lower())
    fmt = known[0] if known else None
    if not inside:
        _store(conn, org, policy, row, fmt, Outcome("excluded", "outside_root"), None, result)
        return
    decided = plan(row["mime"], row["size"], names, list(policy["formats"]), int(policy["max_bytes"]))
    if decided.status:
        _store(conn, org, policy, row, fmt, Outcome(decided.status, decided.reason), None, result)
        return
    max_bytes = min(int(policy["max_bytes"]), GOOGLE_EXPORT_LIMIT) if decided.export_mime else int(policy["max_bytes"])
    try:
        if decided.export_mime:
            data = api.export(row["file_id"], decided.export_mime, max_bytes)
        else:
            data = api.download(row["file_id"], max_bytes)
    except (TooLarge, Flagged) as exc:
        _store(conn, org, policy, row, fmt, Outcome("quarantined", exc.code), None, result, export=decided.export_mime)
        return
    except AccessLost:
        _store(conn, org, policy, row, fmt, Outcome("failed", "access_lost"), None, result, export=decided.export_mime)
        return
    except DriveError as exc:
        raise _Stop(exc.code) from None
    result.fetched_bytes += len(data)
    outcome = run_extractor(decided.kind or "", data, timeout=limits.timeout, memory=limits.memory,
                            max_input=max_bytes)
    outcome.gaps = sorted(set(FORMAT_GAPS.get(decided.format or "", []) + outcome.gaps))
    if outcome.status == "extracted":
        blocked = screen(outcome.text or "")
        if blocked:          # the text is dropped here; only the label is kept
            outcome = Outcome("excluded", blocked, extractor=outcome.extractor, sandbox=outcome.sandbox,
                              elapsed_ms=outcome.elapsed_ms)
    _store(conn, org, policy, row, fmt, outcome, data, result, export=decided.export_mime)


def _store(conn: psycopg.Connection, org: uuid.UUID, policy: Mapping[str, Any], row: Mapping[str, Any],
           fmt: str | None, outcome: Outcome, data: bytes | None, result: RunResult, *,
           export: str | None = None) -> None:
    """One file's capture in one transaction, after rechecking that its approval and state still allow it."""
    source = policy["id"]
    text = facts = None
    if outcome.status == "extracted":
        text = pl.text_payload(outcome.text or "")
        facts = pl.facts_payload({**(outcome.facts or {}), "extractor": outcome.extractor, "gaps": outcome.gaps})
    with tenant_tx(conn, org):
        current = load_policy(conn, source)
        state = conn.execute(CURRENT_SQL, (source, row["file_id"])).fetchone()
        if (not in_force(current) or (fmt is not None and outcome.status == "extracted"
                                      and fmt not in current["formats"])
                or state is None or state["availability"] != "available" or state["version"] != row["version"]):
            result.skipped += 1          # approval, scope or version changed while the file was being read
            return
        for item in (text, facts):
            if item is not None:
                conn.execute(
                    """insert into pulse_priv.drive_payload (org_id, sha256, schema, codec, raw_length, stored_length,
                                                             data)
                       values (%s, %s, %s, %s, %s, %s, %s) on conflict do nothing""",
                    (org, item.sha256, item.schema, item.codec, item.raw_length, item.stored_length, item.data))
        inserted = conn.execute(
            """insert into pulse.drive_extract (org_id, source_id, file_id, source_version, extractor, format, status,
                                                reason, file_name, mime, file_modified_at, export_mime, original_size,
                                                original_sha256, text_sha256, text_schema, facts_sha256, facts_schema,
                                                sandbox, elapsed_ms, gaps)
               values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
               on conflict (org_id, source_id, file_id, source_version, extractor) do nothing returning id""",
            (org, source, row["file_id"], row["version"], EXTRACTOR, fmt, outcome.status, outcome.reason,
             row["name"], row["mime"], row["modified_at"], export,
             len(data) if data is not None else None, hashlib.sha256(data).hexdigest() if data is not None else None,
             text.sha256 if text else None, text.schema if text else None,
             facts.sha256 if facts else None, facts.schema if facts else None,
             outcome.sandbox, outcome.elapsed_ms if data is not None else None, outcome.gaps)).fetchone()
    if inserted is None:
        result.duplicates += 1
        return
    setattr(result, outcome.status, getattr(result, outcome.status) + 1)


DUE_SQL = """
select p.source_id from pulse.drive_extract_policy p join pulse.drive_source s on s.id = p.source_id
 where p.enabled and p.withdrawn_at is null and s.enabled and s.approved_at is not null and s.status <> 'access_lost'
   and s.install_id is null                     -- R52: a company connector's root is metadata only
 order by coalesce(p.last_run_at, '-infinity') limit 50
"""


def run_once(conn: psycopg.Connection, org_id: uuid.UUID | str, api_for: Callable[[Mapping[str, Any]], DriveContent],
             *, limits: Limits = DEFAULT_LIMITS) -> list[RunResult]:
    """Every root of one tenant with a content approval in force, each bounded by `limits`."""
    org = uuid.UUID(str(org_id))
    with tenant_tx(conn, org):
        due = [row["source_id"] for row in conn.execute(DUE_SQL).fetchall()]
    results = []
    for source_id in due:
        with tenant_tx(conn, org):
            policy = load_policy(conn, source_id)
        try:
            results.append(run_source(conn, api_for(policy), org, source_id, limits=limits))
        except DriveError as exc:                  # the credential could not be opened
            results.append(RunResult(str(source_id), "waiting", error_code=exc.code))
    return results


# ------------------------------------------------------------------------------------------------ reviewed actions
def approve(conn: psycopg.Connection, org_id: uuid.UUID | str, source_id: uuid.UUID | str, *,
            approved_by: uuid.UUID | str, approval_ref: str, formats: list[str], audience: list[str],
            max_bytes: int = 10 * 1024 * 1024, retention_note: str | None = None) -> None:
    """Record the owner's content approval for a root (or new terms: a narrower audience applies at the next read)."""
    if not formats or not set(formats) <= set(FORMAT_KEYS):
        raise ValueError(f"formats are some of {', '.join(FORMAT_KEYS)}")
    if not audience or not all(ROLE.match(role) for role in audience):
        raise ValueError("the audience is one or more Pulse role keys")
    with tenant_tx(conn, uuid.UUID(str(org_id))):
        if not feed._is_admin(conn, approved_by):
            raise PermissionError("an active organisation admin records the approval")
        if feed.load_source(conn, source_id) is None:
            raise LookupError("no such root in this organisation")
        conn.execute(
            """insert into pulse.drive_extract_policy (org_id, source_id, formats, audience, max_bytes, retention_note,
                                                       approval_ref, approved_by, approved_at, enabled, updated_by)
               values (%s, %s, %s, %s, %s, %s, %s, %s, now(), true, %s)
               on conflict (org_id, source_id) do update set formats = excluded.formats, audience = excluded.audience,
                 max_bytes = excluded.max_bytes, retention_note = excluded.retention_note,
                 approval_ref = excluded.approval_ref, approved_by = excluded.approved_by, approved_at = now(),
                 enabled = true, withdrawn_by = null, withdrawn_at = null, updated_by = excluded.updated_by,
                 updated_at = now()""",
            (org_id, source_id, sorted(set(formats)), sorted(set(audience)), max_bytes, retention_note,
             approval_ref, approved_by, approved_by))


def withdraw(conn: psycopg.Connection, org_id: uuid.UUID | str, source_id: uuid.UUID | str, *,
             withdrawn_by: uuid.UUID | str) -> None:
    """Stop extraction and every read of the root's captured text. Nothing captured is deleted."""
    with tenant_tx(conn, uuid.UUID(str(org_id))):
        if not feed._is_admin(conn, withdrawn_by):
            raise PermissionError("an active organisation admin withdraws the approval")
        if conn.execute(
            """update pulse.drive_extract_policy set enabled = false, withdrawn_by = %s, withdrawn_at = now(),
                      updated_by = %s, updated_at = now() where source_id = %s""",
                (withdrawn_by, withdrawn_by, source_id)).rowcount != 1:
            raise LookupError("no content approval for this root")


def keep_readable(conn: psycopg.Connection, org_id: uuid.UUID | str, source_id: uuid.UUID | str, file_id: str, *,
                  reviewed_by: uuid.UUID | str, note: str) -> uuid.UUID:
    """An admin's reviewed decision that text captured from a file that disappeared from Drive stays readable (to the
    same audience). Drive reports deletion and unsharing alike, so the reviewer confirms which it was."""
    with tenant_tx(conn, uuid.UUID(str(org_id))):
        if not feed._is_admin(conn, reviewed_by):
            raise PermissionError("an active organisation admin reviews the file")
        state = conn.execute("""select availability, last_change_at from pulse.drive_source_file
                                 where source_id = %s and file_id = %s""", (source_id, file_id)).fetchone()
        if state is None or state["availability"] != "removed":
            raise ValueError("only a file that disappeared from Drive is reviewed this way")
        return conn.execute(
            """insert into pulse.drive_extract_review (org_id, source_id, file_id, decision, for_change_at,
                                                       reviewed_by, note)
               values (%s, %s, %s, 'keep_readable', %s, %s, %s) returning id""",
            (org_id, source_id, file_id, state["last_change_at"], reviewed_by, note)).fetchone()["id"]


# ------------------------------------------------------------------------------------------------- integrity, health
def read_capture(conn: psycopg.Connection, org_id: uuid.UUID | str, extract_id: uuid.UUID | str) -> tuple[str, dict]:
    """The exact text and facts of one capture (operator and restore checks; people read through pulse.drive_text).
    Raises PayloadCorrupt when a stored payload does not decode to its recorded length and hash."""
    import json

    with tenant_tx(conn, uuid.UUID(str(org_id))):
        row = conn.execute(
            """select t.codec tc, t.data td, t.sha256 ts, t.raw_length tl, f.codec fc, f.data fd, f.sha256 fs,
                      f.raw_length fl
                 from pulse.drive_extract x
                 join pulse_priv.drive_payload t on t.sha256 = x.text_sha256 and t.schema = x.text_schema
                 join pulse_priv.drive_payload f on f.sha256 = x.facts_sha256 and f.schema = x.facts_schema
                where x.id = %s""", (extract_id,)).fetchone()
    if row is None:
        raise LookupError("no captured text for this id")
    text = pl.decode(row["tc"], row["td"], row["ts"], row["tl"]).decode("utf-8")
    facts = json.loads(pl.decode(row["fc"], row["fd"], row["fs"], row["fl"]))
    return text, facts


def verify(conn: psycopg.Connection, org_id: uuid.UUID | str) -> dict[str, Any]:
    """Decode every stored payload of a tenant and compare it with its recorded length and hash."""
    corrupt, total = [], 0
    with tenant_tx(conn, uuid.UUID(str(org_id))):
        rows = conn.execute("select sha256, schema, codec, raw_length, data from pulse_priv.drive_payload "
                            "order by sha256, schema").fetchall()
    for row in rows:
        total += 1
        try:
            pl.decode(row["codec"], row["data"], row["sha256"], row["raw_length"])
        except pl.PayloadCorrupt:
            corrupt.append(f"{row['schema']}:{row['sha256']}")
    return {"payloads": total, "corrupt": len(corrupt), "corrupt_payloads": corrupt[:50]}


STATUS_SQL = """
select s.id, s.label, s.enabled and s.approved_at is not null as tracked, p.enabled, p.withdrawn_at is not null
       as withdrawn, p.formats, p.audience, p.max_bytes, p.last_run_at, p.last_error_code,
       coalesce((select jsonb_object_agg(l.status, l.n) from (
         select y.status, count(*)::int n from (
           select distinct on (x.file_id) x.status from pulse.drive_extract x where x.source_id = s.id
            order by x.file_id, x.extracted_at desc, x.id desc) y group by y.status) l), '{}'::jsonb) as outcomes,
       (select count(distinct x.file_id) from pulse.drive_extract x where x.source_id = s.id
           and x.status = 'extracted' and pulse.drive_text_hold(s.id, x.file_id) is not null)::int as held
  from pulse.drive_extract_policy p join pulse.drive_source s on s.id = p.source_id
 order by s.label
"""


def status(conn: psycopg.Connection, org_id: uuid.UUID | str) -> list[dict[str, Any]]:
    """The operator view: approvals, outcome counts and held files. No file name, text, account or token."""
    with tenant_tx(conn, uuid.UUID(str(org_id))):
        rows = conn.execute(STATUS_SQL).fetchall()
    return [{k: (v.isoformat() if isinstance(v, datetime) else str(v) if isinstance(v, uuid.UUID) else v)
             for k, v in row.items()} for row in rows]
