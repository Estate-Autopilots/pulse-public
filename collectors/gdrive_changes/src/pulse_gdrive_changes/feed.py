"""Direct Drive changes for approved roots (R44, spec 03 §S1, plan P24).

One page of Google's changes feed is one transaction: each change's journal key, its registered `drive.file.*` event,
the file's accepted state and the next page token commit together, so a crash before the commit refetches the same
page and a replay inserts nothing twice. The feed reports current changes, not every intermediate edit; a deleted,
unshared or moved-away file becomes a tombstone on its state row while the accepted events stay.

Polling is bounded (pages per run, page size, poll interval). A push channel only wakes the poller early; a missed
notification is caught by the next poll. A refused cursor stops that root until someone reviews a recovery, which
records the window that may have been missed instead of resetting anything.
"""

from __future__ import annotations

import hashlib
import json
import random
import secrets
import uuid
from collections.abc import Callable, Mapping
from dataclasses import asdict, dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

import psycopg
from psycopg.types.json import Jsonb

from pulse_gdrive_snapshot.backfill import is_sensitive_path
from pulse_sdk import registry as reg
from pulse_sdk.db import tenant_tx
from pulse_sdk.envelope import make_event, to_row
from pulse_sdk.store import insert_event, notify
from pulse_sdk.ulid import deterministic_ulid
from pulse_sdk.validate import EventValidator

from .drive import AccessLost, CursorInvalid, DriveApi, DriveError, RateLimited, Unavailable

COLLECTOR = "gdrive_changes"
SOURCE_PREFIX = "/collectors/gdrive_changes/1"
FOLDER_MIME = "application/vnd.google-apps.folder"
MAX_DEPTH = 32
DEFAULT_PAGE_SIZE = 500
MAX_PAGE_SIZE = 1000
DEFAULT_MAX_PAGES = 20
DEFAULT_POLL_SECONDS = 300
BACKOFF_BASE_SECONDS = 60
BACKOFF_MAX_SECONDS = 3600
ACCESS_RECHECK_SECONDS = 3600
CHANNEL_TTL = timedelta(days=3)               # Drive allows at most one week for the changes resource
CHANNEL_RENEW_BEFORE = timedelta(hours=6)
CHANNEL_RETRY = timedelta(hours=1)            # after a refused watch, polling carries on and the watch waits this long

EVENT_TYPES = {"created": "drive.file.created", "updated": "drive.file.updated", "restored": "drive.file.updated",
               "moved": "drive.file.moved", "renamed": "drive.file.renamed", "trashed": "drive.file.trashed"}
SOURCE_COLUMNS = ("id, org_id, kind, drive_id, root_id, subject, credential_ref, status, failures, enabled, "
                  "approved_at, last_checkpoint_at, channel_id, channel_resource, channel_expires_at, channel_error, "
                  "install_id")
# R52: a root bound to a company connector carries its install's state and credential reference (never the secret).
SOURCE_SQL = ("select " + ", ".join(f"s.{c.strip()}" for c in SOURCE_COLUMNS.split(",")) +
              ", i.status as install_status, i.secret_ref, i.subject as install_subject, i.credential_fingerprint"
              " from pulse.drive_source s left join pulse.connector_install i on i.id = s.install_id where s.id = %s")
Fault = Callable[[str, int], None]


@dataclass
class PollResult:
    source: str
    status: str
    pages: int = 0
    changes: int = 0
    events: int = 0
    duplicates: int = 0
    dropped: int = 0
    tombstones: int = 0
    dead_letters: int = 0
    error_code: str | None = None

    def summary(self) -> dict[str, Any]:
        """Counts and codes only: no cursor, token, account or file name."""
        return asdict(self)


def source_uri(source_id: uuid.UUID | str) -> str:
    return f"{SOURCE_PREFIX}/{source_id}"


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _time(value: Any) -> datetime:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=UTC)
    return datetime.fromisoformat(str(value).replace("Z", "+00:00")).astimezone(UTC)


def _iso(value: datetime | None) -> str | None:
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z") if value else None


def _account(person: Any) -> str | None:
    email = (person or {}).get("emailAddress") if isinstance(person, Mapping) else None
    return f"account:google:{str(email).strip().lower()}" if email else None


def file_meta(file: Mapping[str, Any]) -> dict[str, Any]:
    """The metadata Pulse keeps from a Drive file resource (no content, no permissions, no description)."""
    size = file.get("size")
    return {
        "name": str(file.get("name") or "")[:500],
        "mime": str(file.get("mimeType") or "application/octet-stream")[:200],
        "parents": [str(p) for p in (file.get("parents") or ())][:10],
        "size": int(size) if size not in (None, "") else None,
        "md5": file.get("md5Checksum"),
        "sha256": file.get("sha256Checksum"),
        "modified_at": _iso(_time(file["modifiedTime"])) if file.get("modifiedTime") else None,
        "trashed": bool(file.get("trashed")),
        "owner": _account((file.get("owners") or [None])[0]),
        "last_modifying_user": _account(file.get("lastModifyingUser")),
    }


def meta_hash(meta: Mapping[str, Any]) -> str:
    tracked = {k: meta.get(k) for k in ("name", "mime", "parents", "size", "md5", "sha256", "modified_at", "trashed")}
    return _sha(json.dumps(tracked, sort_keys=True, separators=(",", ":"), ensure_ascii=False))


def change_key(source_id: uuid.UUID | str, file_id: str, at: datetime, removed: bool, digest: str | None) -> str:
    """The idempotency key of one normalized change; a replayed page produces the same keys."""
    return _sha(f"{source_id}|{file_id}|{_iso(at)}|{int(removed)}|{digest or '-'}")


def classify(prior: Mapping[str, Any] | None, meta: Mapping[str, Any]) -> str | None:
    """What a change did, against the last accepted state. None: nothing Pulse tracks changed."""
    if prior is None:
        return "created"
    if prior["availability"] in ("removed", "out_of_scope"):
        return "restored"
    if meta["trashed"] and not prior["trashed"]:
        return "trashed"
    if prior["trashed"] and not meta["trashed"]:
        return "restored"
    if list(prior["parents"] or []) != list(meta["parents"]):
        return "moved"
    if prior["name"] != meta["name"]:
        return "renamed"
    if prior["meta_hash"] != meta_hash(meta):
        return "updated"
    return None


def drive_change_event(org_id: uuid.UUID | str, source_id: uuid.UUID | str, file_id: str, kind: str,
                       meta: Mapping[str, Any], at: datetime, key: str) -> dict[str, Any]:
    """A registered drive.* event for one change, with a deterministic id (same change, same id)."""
    event_type = "drive.folder.created" if kind == "created" and meta["mime"] == FOLDER_MIME else EVENT_TYPES[kind]
    data: dict[str, Any] = {"name": meta["name"], "mime": meta["mime"],
                            "parents": [f"gdrive:{parent}" for parent in meta["parents"]]}
    for field in ("size", "md5", "sha256", "owner", "last_modifying_user"):
        if meta.get(field) is not None:
            data[field] = meta[field]
    source = source_uri(source_id)
    return make_event(
        org_id=org_id, id=deterministic_ulid(at, source, key, event_type), source=source, type=event_type, time=at,
        subject=f"file:gdrive:{file_id}", purpose="delivery", sensitivity=1, visibility="team", data=data,
        datacontenttype="application/json", dataschema=f"schema:{event_type}/1", collectorver="1.0.0",
    )


def backoff_seconds(failures: int, retry_after: float | None = None) -> int:
    delay = min(BACKOFF_MAX_SECONDS, BACKOFF_BASE_SECONDS * 2 ** max(0, failures))
    delay = max(delay, int(retry_after or 0))
    return int(delay + random.uniform(0, delay * 0.1))


# ---------------------------------------------------------------------------------------------------------- state
def load_source(conn: psycopg.Connection, source_id: uuid.UUID | str) -> dict[str, Any] | None:
    return conn.execute(SOURCE_SQL, (source_id,)).fetchone()


def load_cursor(conn: psycopg.Connection, source_id: uuid.UUID | str) -> dict[str, Any] | None:
    row = conn.execute("select cursor from pulse.collector_cursor where collector = %s and scope_key = %s",
                       (COLLECTOR, str(source_id))).fetchone()
    return dict(row["cursor"]) if row else None


def save_cursor(conn: psycopg.Connection, org_id: uuid.UUID, source_id: uuid.UUID | str, token: str) -> None:
    conn.execute(
        """insert into pulse.collector_cursor (org_id, collector, scope_key, cursor) values (%s, %s, %s, %s)
           on conflict (org_id, collector, scope_key) do update set cursor = excluded.cursor, updated_at = now()""",
        (org_id, COLLECTOR, str(source_id), Jsonb({"page_token": token})),
    )


class Scope:
    """Whether a file sits under the root, and the folder names on the way (for the sensitive-path exclusion).
    Folders are looked up in the accepted state first, then once per run through the Drive API."""

    def __init__(self, conn: psycopg.Connection, api: DriveApi, source: Mapping[str, Any]):
        self.conn, self.api, self.source = conn, api, source
        self.cache: dict[str, dict[str, Any] | None] = {}

    def remember(self, file_id: str, meta: Mapping[str, Any]) -> None:
        if meta["mime"] == FOLDER_MIME:
            self.cache[file_id] = {"name": meta["name"], "parents": list(meta["parents"])}

    def _node(self, folder_id: str) -> dict[str, Any] | None:
        if folder_id not in self.cache:
            row = self.conn.execute(
                """select name, parents from pulse.drive_source_file
                    where source_id = %s and file_id = %s and availability in ('available', 'trashed')""",
                (self.source["id"], folder_id)).fetchone()
            if row is None:
                found = self.api.get_file(folder_id)
                row = ({"name": str(found.get("name") or ""), "parents": list(found.get("parents") or [])}
                       if found else None)
            self.cache[folder_id] = dict(row) if row else None
        return self.cache[folder_id]

    def locate(self, file_id: str, meta: Mapping[str, Any]) -> tuple[bool, list[str]]:
        root = self.source["root_id"] if self.source["kind"] == "folder" else self.source["drive_id"]
        if file_id == root:
            return True, []
        names, parents = [meta["name"]], list(meta["parents"])
        for _ in range(MAX_DEPTH):
            if not parents:
                return False, names
            if parents[0] == root:
                return True, names
            node = self._node(parents[0])
            if node is None:
                return False, names
            names.append(node["name"])
            parents = node["parents"]
        return False, names


@dataclass
class _Page:
    conn: psycopg.Connection
    scope: Scope
    source: Mapping[str, Any]
    registry: reg.Registry
    validator: EventValidator
    now: datetime
    result: PollResult
    access_lost: bool = False

    def _journal(self, key: str, file_id: str, at: datetime, kind: str, event_id: str | None = None,
                 reason: str | None = None) -> None:
        self.conn.execute(
            """insert into pulse.drive_change
                 (org_id, source_id, change_key, file_id, change_time, kind, event_id, reason)
               values (%s, %s, %s, %s, %s, %s, %s, %s)""",
            (self.source["org_id"], self.source["id"], key, file_id, at, kind, event_id, reason))

    def _seen(self, key: str) -> bool:
        return self.conn.execute("select 1 from pulse.drive_change where source_id = %s and change_key = %s",
                                 (self.source["id"], key)).fetchone() is not None

    def _tombstone(self, prior: Mapping[str, Any], file_id: str, at: datetime, availability: str) -> None:
        if prior["availability"] == availability:
            return
        key = change_key(self.source["id"], file_id, at, True, availability)
        if self._seen(key):
            self.result.duplicates += 1
            return
        # Only availability moves: the last accepted name, folder and checksum stay, and so does every event.
        self.conn.execute(
            """update pulse.drive_source_file set availability = %s, last_change_at = greatest(last_change_at, %s)
                where source_id = %s and file_id = %s""", (availability, at, self.source["id"], file_id))
        self._journal(key, file_id, at, "removed" if availability == "removed" else "out_of_scope")
        self.result.tombstones += 1

    def apply(self, change: Mapping[str, Any]) -> None:
        self.result.changes += 1
        if change.get("changeType") == "drive":
            if change.get("removed") and change.get("driveId") == self.source["drive_id"]:
                self.access_lost = True
            return
        file_id = str(change.get("fileId") or "")
        if not file_id or not change.get("time"):
            self.result.dropped += 1
            return
        at = _time(change["time"])
        prior = self.conn.execute(
            """select name, parents, trashed, meta_hash, availability, last_change_at from pulse.drive_source_file
                where source_id = %s and file_id = %s""", (self.source["id"], file_id)).fetchone()
        if prior is not None and at < prior["last_change_at"]:
            self.result.duplicates += 1          # an older change replayed after a newer one was accepted
            return
        file = change.get("file")
        if change.get("removed") or not isinstance(file, Mapping):
            if prior is not None:
                self._tombstone(prior, file_id, at, "removed")
            else:
                self.result.dropped += 1
            return
        if self.source["kind"] == "shared_drive" and file.get("driveId") not in (None, self.source["drive_id"]):
            self.result.dropped += 1
            return
        meta = file_meta(file)
        inside, names = self.scope.locate(file_id, meta)
        if not inside or (names and is_sensitive_path("/".join(reversed(names)))):
            if prior is not None:
                self._tombstone(prior, file_id, at, "out_of_scope")
            else:
                self.result.dropped += 1
            return
        self.scope.remember(file_id, meta)
        digest = meta_hash(meta)
        key = change_key(self.source["id"], file_id, at, False, digest)
        if self._seen(key):
            self.result.duplicates += 1
            return
        kind = classify(prior, meta)
        if kind is None:
            return
        event = drive_change_event(self.source["org_id"], self.source["id"], file_id, kind, meta, at, key)
        if self.validator.errors(event, now=self.now):
            self._journal(key, file_id, at, "dead_letter", reason="invalid_event")
            self.result.dead_letters += 1
            return
        stored = insert_event(self.conn, to_row(event), self.registry)
        if stored.status == "rejected":
            self._journal(key, file_id, at, "dead_letter", reason="rejected_event")
            self.result.dead_letters += 1
            return
        self.result.events += stored.status == "accepted"
        self.result.duplicates += stored.status == "duplicate"
        self.conn.execute(
            """insert into pulse.drive_source_file (org_id, source_id, file_id, name, mime, parents, size, md5,
                                                    modified_at, trashed, meta_hash, availability, last_change_at)
               values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
               on conflict (org_id, source_id, file_id) do update set
                 name = excluded.name, mime = excluded.mime, parents = excluded.parents, size = excluded.size,
                 md5 = excluded.md5, modified_at = excluded.modified_at, trashed = excluded.trashed,
                 meta_hash = excluded.meta_hash, availability = excluded.availability,
                 last_change_at = excluded.last_change_at""",
            (self.source["org_id"], self.source["id"], file_id, meta["name"], meta["mime"], meta["parents"],
             meta["size"], meta["md5"], meta["modified_at"], meta["trashed"], digest,
             "trashed" if meta["trashed"] else "available", at))
        self._journal(key, file_id, at, kind, event_id=event["id"])


# ----------------------------------------------------------------------------------------------------------- poll
def _record_failure(conn: psycopg.Connection, org: uuid.UUID, source: Mapping[str, Any], error: DriveError | None,
                    started: datetime) -> PollResult:
    code = error.code if error else "internal_error"
    if isinstance(error, CursorInvalid):
        status, delay = "cursor_invalid", None             # paused until a reviewed recovery
    elif isinstance(error, RateLimited):
        status, delay = "rate_limited", backoff_seconds(source["failures"], error.retry_after)
    elif isinstance(error, AccessLost):            # also an unusable, unbound or revoked connector credential (R52)
        status, delay = "access_lost", ACCESS_RECHECK_SECONDS
    else:
        status, delay = "error", backoff_seconds(source["failures"])
    until = started + timedelta(seconds=delay) if delay else None
    with tenant_tx(conn, org):
        conn.execute(
            """update pulse.drive_source set status = %s, error_code = %s, error_at = %s, failures = failures + 1,
                      last_poll_at = %s, backoff_until = %s, next_poll_at = %s where id = %s""",
            (status, code, started, started, until, until, source["id"]))
    return PollResult(str(source["id"]), status, error_code=code)


def poll_source(conn: psycopg.Connection, api: DriveApi, org_id: uuid.UUID | str, source_id: uuid.UUID | str, *,
                now: Callable[[], datetime] = lambda: datetime.now(UTC), page_size: int = DEFAULT_PAGE_SIZE,
                max_pages: int = DEFAULT_MAX_PAGES, poll_seconds: int = DEFAULT_POLL_SECONDS,
                fault: Fault | None = None) -> PollResult:
    """Read one approved root's changes from its committed cursor, at most `max_pages` pages of `page_size`."""
    if not 1 <= page_size <= MAX_PAGE_SIZE:
        raise ValueError(f"page size must be between 1 and {MAX_PAGE_SIZE}")
    org = uuid.UUID(str(org_id))
    with tenant_tx(conn, org):
        source = load_source(conn, source_id)
        cursor = load_cursor(conn, source_id) if source else None
    if source is None or not source["enabled"] or source["approved_at"] is None:
        return PollResult(str(source_id), "not_approved")
    if source["status"] == "cursor_invalid":
        return PollResult(str(source_id), "cursor_invalid", error_code="cursor_invalid")
    registry = reg.default()
    validator = EventValidator(registry)
    result = PollResult(str(source_id), "ok")
    lock = f"{org}:{COLLECTOR}:{source_id}"
    if not conn.execute("select pg_try_advisory_lock(hashtextextended(%s, 0)) as ok", (lock,)).fetchone()["ok"]:
        return PollResult(str(source_id), "busy")
    try:
        started = now()
        try:
            if cursor is None:
                # A new root starts at Google's current position: no replay of history (backfill is reviewed work).
                token = api.start_page_token(source["drive_id"])
                with tenant_tx(conn, org):
                    save_cursor(conn, org, source_id, token)
                    conn.execute(
                        """update pulse.drive_source set status = 'ok', last_poll_at = %s, last_checkpoint_at = %s,
                                  caught_up_at = %s, next_poll_at = %s, failures = 0, error_code = null,
                                  error_at = null, backoff_until = null where id = %s""",
                        (started, started, started, started + timedelta(seconds=poll_seconds), source_id))
                return result
            token = str(cursor["page_token"])
            scope = Scope(conn, api, source)       # folder lookups are Drive facts: kept across this run's pages
            for page_no in range(1, max_pages + 1):
                started = now()
                page = api.list_changes(token, source["drive_id"], page_size)
                following = page.next_page_token or page.new_start_page_token
                if not following:
                    raise Unavailable()
                caught_up = page.next_page_token is None
                with tenant_tx(conn, org):
                    applied = _Page(conn, scope, source, registry, validator, started, result)
                    events_before = result.events
                    for change in page.changes:
                        applied.apply(change)
                    if fault:
                        fault("before_commit", page_no)
                    save_cursor(conn, org, source_id, following)
                    status = "access_lost" if applied.access_lost else "ok" if caught_up else "catching_up"
                    conn.execute(
                        """update pulse.drive_source set status = %s, error_code = %s, error_at = %s,
                                  last_poll_at = %s, last_checkpoint_at = %s,
                                  caught_up_at = case when %s then %s else caught_up_at end,
                                  next_poll_at = %s, failures = 0, backoff_until = null where id = %s""",
                        (status, "access_lost" if applied.access_lost else None,
                         started if applied.access_lost else None, started, started, caught_up, started,
                         started + timedelta(seconds=poll_seconds if caught_up else 0), source_id))
                    if result.events > events_before:
                        notify(conn, org)
                result.pages += 1
                result.status = status
                if fault:
                    fault("after_commit", page_no)
                token = following
                if caught_up or applied.access_lost:
                    break
            return result
        except DriveError as exc:
            failed = _record_failure(conn, org, source, exc, started)
            failed.pages, failed.events, failed.changes = result.pages, result.events, result.changes
            return failed
    finally:
        conn.execute("select pg_advisory_unlock(hashtextextended(%s, 0))", (lock,))


def ensure_channel(conn: psycopg.Connection, api: DriveApi, org_id: uuid.UUID | str, source_id: uuid.UUID | str, *,
                   address: str | None, now: Callable[[], datetime] = lambda: datetime.now(UTC),
                   ttl: timedelta = CHANNEL_TTL, renew_before: timedelta = CHANNEL_RENEW_BEFORE) -> str:
    """Keep one live push channel per healthy root: a new one before the old expires, then stop the old one.
    Only the channel token's hash is stored; a failure leaves polling unaffected."""
    if not address or not address.startswith("https://"):
        return "off"
    org = uuid.UUID(str(org_id))
    at = now()
    with tenant_tx(conn, org):
        source = load_source(conn, source_id)
        cursor = load_cursor(conn, source_id) if source else None
    if source is None or not source["enabled"] or cursor is None or source["status"] not in ("ok", "catching_up"):
        return "skipped"
    if (source["channel_id"] and source["channel_error"] is None and source["channel_expires_at"]
            and source["channel_expires_at"] - at > renew_before):
        return "kept"
    token, channel_id = secrets.token_urlsafe(32), str(uuid.uuid4())
    expires = at + ttl
    try:
        channel = api.watch(str(cursor["page_token"]), source["drive_id"], channel_id, address, token,
                            int(expires.timestamp() * 1000))
    except DriveError:
        with tenant_tx(conn, org):
            conn.execute("update pulse.drive_source set channel_error = 'watch_failed' where id = %s", (source_id,))
        return "failed"
    if channel.expires_ms:
        expires = datetime.fromtimestamp(channel.expires_ms / 1000, UTC)
    with tenant_tx(conn, org):
        conn.execute(
            """update pulse.drive_source set channel_id = %s, channel_resource = %s, channel_token_hash = %s,
                      channel_expires_at = %s, channel_error = null where id = %s""",
            (channel.id, channel.resource_id, _sha(token), expires, source_id))
    if source["channel_id"] and source["channel_resource"]:
        try:
            api.stop(str(source["channel_id"]), str(source["channel_resource"]))
        except DriveError:
            pass                    # an unstopped old channel expires by itself; its token no longer matches
    return "renewed"


DUE_SQL = """
select id from pulse.drive_source
 where enabled and approved_at is not null and status <> 'cursor_invalid'
   and (backoff_until is null or backoff_until <= %(now)s)
   and (next_poll_at is null or next_poll_at <= %(now)s or wake_at > coalesce(last_poll_at, '-infinity'))
 order by coalesce(next_poll_at, '-infinity') limit 50
"""
RENEW_SQL = """
select id from pulse.drive_source
 where enabled and approved_at is not null and status in ('ok', 'catching_up')
   and (channel_id is null or channel_error is not null or channel_expires_at < %(soon)s)
 limit 50
"""


def run_once(conn: psycopg.Connection, org_id: uuid.UUID | str, api_for: Callable[[Mapping[str, Any]], DriveApi], *,
             address: str | None = None, now: Callable[[], datetime] = lambda: datetime.now(UTC),
             page_size: int = DEFAULT_PAGE_SIZE, max_pages: int = DEFAULT_MAX_PAGES,
             poll_seconds: int = DEFAULT_POLL_SECONDS,
             channel_hold: dict[str, datetime] | None = None) -> list[PollResult]:
    """Poll every due root of one tenant (scheduled, woken by a channel, or past its back-off), then renew channels.
    `channel_hold` (kept by the loop) delays another watch for a root whose last watch Google refused."""
    org = uuid.UUID(str(org_id))
    at = now()
    with tenant_tx(conn, org):
        due = [row["id"] for row in conn.execute(DUE_SQL, {"now": at}).fetchall()]
    results = []
    for source_id in due:
        with tenant_tx(conn, org):
            source = load_source(conn, source_id)
        try:
            results.append(poll_source(conn, api_for(source), org, source_id, now=now, page_size=page_size,
                                       max_pages=max_pages, poll_seconds=poll_seconds))
        except DriveError as exc:                 # the credential could not be opened
            results.append(_record_failure(conn, org, source, exc, at))
        except Exception:                         # one root's failure never stops the others; its page rolled back
            results.append(_record_failure(conn, org, source, None, at))
    if address:
        with tenant_tx(conn, org):
            renew = [row["id"] for row in conn.execute(RENEW_SQL, {"soon": at + CHANNEL_RENEW_BEFORE}).fetchall()]
        hold = {} if channel_hold is None else channel_hold
        for source_id in renew:
            if hold.get(str(source_id), at) > at:
                continue
            with tenant_tx(conn, org):
                source = load_source(conn, source_id)
            try:
                if ensure_channel(conn, api_for(source), org, source_id, address=address, now=now) == "failed":
                    hold[str(source_id)] = at + CHANNEL_RETRY
            except DriveError:
                hold[str(source_id)] = at + CHANNEL_RETRY
    return results


# ------------------------------------------------------------------------------------------------ reviewed actions
def _is_admin(conn: psycopg.Connection, person: uuid.UUID | str) -> bool:
    return conn.execute(
        """select 1 from pulse.role_assignment r join pulse.person p on p.id = r.person_id and p.status = 'active'
            where r.person_id = %s and r.role_key = 'admin'
              and current_date between r.valid_from and coalesce(r.valid_to, 'infinity')""",
        (person,)).fetchone() is not None


def add_source(conn: psycopg.Connection, org_id: uuid.UUID | str, *, kind: str, label: str, credential_ref: str,
               drive_id: str | None = None, root_id: str | None = None, subject: str | None = None) -> uuid.UUID:
    """Register a root. It stays off until an admin records the owner's approval (approve_source)."""
    with tenant_tx(conn, uuid.UUID(str(org_id))):
        return conn.execute(
            """insert into pulse.drive_source (org_id, kind, drive_id, root_id, label, subject, credential_ref)
               values (%s, %s, %s, %s, %s, %s, %s) returning id""",
            (org_id, kind, drive_id, root_id, label, subject, credential_ref)).fetchone()["id"]


def approve_source(conn: psycopg.Connection, org_id: uuid.UUID | str, source_id: uuid.UUID | str, *,
                   approved_by: uuid.UUID | str, approval_ref: str) -> None:
    with tenant_tx(conn, uuid.UUID(str(org_id))):
        if not _is_admin(conn, approved_by):
            raise PermissionError("an active organisation admin records the approval")
        if conn.execute(
            """update pulse.drive_source set approved_by = %s, approved_at = now(), approval_ref = %s, enabled = true,
                      next_poll_at = now() where id = %s""", (approved_by, approval_ref, source_id)).rowcount != 1:
            raise LookupError("no such root in this organisation")


def disable_source(conn: psycopg.Connection, org_id: uuid.UUID | str, source_id: uuid.UUID | str) -> None:
    """Stop reading a root. Its cursor, file states and events stay."""
    with tenant_tx(conn, uuid.UUID(str(org_id))):
        conn.execute("update pulse.drive_source set enabled = false where id = %s", (source_id,))


def recover(conn: psycopg.Connection, api: DriveApi, org_id: uuid.UUID | str, source_id: uuid.UUID | str, *,
            reviewed_by: uuid.UUID | str, note: str, now: Callable[[], datetime] = lambda: datetime.now(UTC)) -> dict:
    """After Google refused the stored cursor: start again from Google's current position and record the window that
    may have been missed (open until a reviewed rescan). File states, events and the journal are not touched."""
    org = uuid.UUID(str(org_id))
    with tenant_tx(conn, org):
        source = load_source(conn, source_id)
        if source is None:
            raise LookupError("no such root in this organisation")
        if source["status"] != "cursor_invalid":
            raise ValueError("only a root whose cursor Google refused is recovered this way")
        if not _is_admin(conn, reviewed_by):
            raise PermissionError("an active organisation admin reviews the recovery")
    token = api.start_page_token(source["drive_id"])
    at = now()
    with tenant_tx(conn, org):
        old = load_cursor(conn, source_id) or {}
        gap = conn.execute(
            """insert into pulse.drive_change_gap (org_id, source_id, reason, from_at, to_at, old_cursor_hash,
                                                   reviewed_by, note)
               values (%s, %s, 'cursor_invalid', %s, %s, %s, %s, %s) returning id""",
            (org, source_id, source["last_checkpoint_at"], at,
             _sha(str(old["page_token"])) if old.get("page_token") else None, reviewed_by, note)).fetchone()["id"]
        save_cursor(conn, org, source_id, token)
        conn.execute(
            """update pulse.drive_source set status = 'ok', error_code = null, error_at = null, failures = 0,
                      backoff_until = null, last_checkpoint_at = %s, caught_up_at = %s, next_poll_at = %s
                where id = %s""", (at, at, at, source_id))
    return {"gap": str(gap), "from": _iso(source["last_checkpoint_at"]), "to": _iso(at)}


STATUS_SQL = """
select s.id, s.kind, s.label, s.enabled, s.approved_at is not null as approved, s.status, s.error_code, s.failures,
       s.last_checkpoint_at, s.caught_up_at, s.backoff_until,
       case when s.channel_error is not null then 'failed' when s.channel_expires_at > now() then 'active'
            when s.channel_id is not null then 'expired' else 'none' end as channel,
       (select count(*) from pulse.drive_source_file f where f.source_id = s.id)::int as files,
       (select count(*) from pulse.drive_source_file f where f.source_id = s.id and f.availability <> 'available')::int
         as unavailable,
       (select count(*) from pulse.drive_change c where c.source_id = s.id and c.kind = 'dead_letter')::int
         as dead_letters,
       (select count(*) from pulse.drive_change_gap g where g.source_id = s.id and g.rescan = 'open')::int as open_gaps
  from pulse.drive_source s order by s.label
"""


def status(conn: psycopg.Connection, org_id: uuid.UUID | str) -> list[dict[str, Any]]:
    """The operator view (same fields as pulse.drive_changes_status): no cursor, token, account or file name."""
    with tenant_tx(conn, uuid.UUID(str(org_id))):
        rows = conn.execute(STATUS_SQL).fetchall()
    return [{k: (_iso(v) if isinstance(v, datetime) else str(v) if isinstance(v, uuid.UUID) else v)
             for k, v in row.items()} for row in rows]
