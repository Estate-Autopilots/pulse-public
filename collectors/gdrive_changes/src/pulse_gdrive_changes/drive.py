"""The five Drive API calls the changes feed needs, behind a small protocol so tests use a synthetic Drive.

Errors are classified once here: a rate limit backs off, a refused cursor waits for a reviewed recovery, lost access
marks the root unavailable, anything else is retried. Messages never carry tokens, credentials or provider bodies.
"""

from __future__ import annotations

import json
import os
import stat
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

METADATA_SCOPE = "https://www.googleapis.com/auth/drive.metadata.readonly"
FILE_FIELDS = ("id,name,mimeType,parents,trashed,size,md5Checksum,sha256Checksum,modifiedTime,driveId,"
               "owners(emailAddress),lastModifyingUser(emailAddress)")
CHANGE_FIELDS = f"nextPageToken,newStartPageToken,changes(changeType,time,removed,fileId,driveId,file({FILE_FIELDS}))"
CREDENTIALS_DIR_ENV = "PULSE_DRIVE_CHANGES_CREDENTIALS_DIR"
_RATE_REASONS = {"rateLimitExceeded", "userRateLimitExceeded", "sharingRateLimitExceeded", "dailyLimitExceeded"}


class DriveError(Exception):
    code = "provider_error"


class RateLimited(DriveError):
    code = "rate_limited"

    def __init__(self, retry_after: float | None = None):
        super().__init__(self.code)
        self.retry_after = retry_after


class CursorInvalid(DriveError):
    code = "cursor_invalid"


class AccessLost(DriveError):
    code = "access_lost"


class CredentialUnavailable(AccessLost):
    code = "credential_unavailable"


class Unavailable(DriveError):
    code = "provider_unavailable"


@dataclass(frozen=True)
class ChangePage:
    changes: list[dict[str, Any]]
    next_page_token: str | None
    new_start_page_token: str | None


@dataclass(frozen=True)
class Channel:
    id: str
    resource_id: str
    expires_ms: int | None


class DriveApi(Protocol):
    def start_page_token(self, drive_id: str | None) -> str: ...
    def list_changes(self, page_token: str, drive_id: str | None, page_size: int) -> ChangePage: ...
    def get_file(self, file_id: str) -> dict[str, Any] | None: ...
    def watch(self, page_token: str, drive_id: str | None, channel_id: str, address: str, token: str,
              expires_ms: int) -> Channel: ...
    def stop(self, channel_id: str, resource_id: str) -> None: ...


def classify(status: int, reason: str = "", message: str = "", *, listing: bool = False,
             retry_after: float | None = None) -> DriveError:
    """Map a Drive HTTP error to what the worker does next. `listing` marks changes.list, where a 400/404/410 that is
    not about the shared drive means Google no longer accepts the stored page token."""
    lowered = message.lower()
    if status == 429 or (status == 403 and reason in _RATE_REASONS):
        return RateLimited(retry_after)
    if status in (401, 403):
        return AccessLost()
    if status == 404 and ("drive" in lowered and "token" not in lowered or reason == "teamDriveNotFound"):
        return AccessLost()
    if listing and status in (400, 404, 410):
        return CursorInvalid()
    if status == 404:
        return AccessLost()
    return Unavailable()


def credential_file(ref: str, base: str | None = None) -> Path:
    """The named credential file: inside the configured directory, owned privately. Never logged or stored."""
    folder = base or os.environ.get(CREDENTIALS_DIR_ENV)
    if not folder:
        raise CredentialUnavailable()
    path = Path(folder) / f"{ref}.json"
    try:
        mode = path.stat().st_mode
    except OSError as exc:
        raise CredentialUnavailable() from exc
    if mode & (stat.S_IRWXG | stat.S_IRWXO):
        raise CredentialUnavailable()   # a group- or world-readable key is refused rather than used
    return path


class GoogleDrive:
    """Drive v3 with a service account, read as `subject` (domain-wide delegation) or as the account itself (a
    member of the approved shared drive), with the metadata-only scope."""

    def __init__(self, credential: Path, subject: str | None, *, timeout: float = 30.0):
        import google_auth_httplib2
        import httplib2
        from google.oauth2 import service_account
        from googleapiclient.discovery import build

        creds = service_account.Credentials.from_service_account_file(str(credential), scopes=[METADATA_SCOPE])
        if subject:
            creds = creds.with_subject(subject)
        http = google_auth_httplib2.AuthorizedHttp(creds, http=httplib2.Http(timeout=timeout))
        self.svc = build("drive", "v3", http=http, cache_discovery=False)

    def _run(self, request: Any, *, listing: bool = False) -> Mapping[str, Any]:
        from googleapiclient.errors import HttpError

        try:
            return request.execute(num_retries=0)
        except HttpError as exc:
            reason, message = _error_detail(exc)
            retry = exc.resp.get("retry-after") if hasattr(exc.resp, "get") else None
            raise classify(int(exc.resp.status), reason, message, listing=listing,
                           retry_after=float(retry) if retry and str(retry).isdigit() else None) from None
        except (OSError, TimeoutError) as exc:
            raise Unavailable() from exc

    def start_page_token(self, drive_id: str | None) -> str:
        args: dict[str, Any] = {"supportsAllDrives": True}
        if drive_id:
            args["driveId"] = drive_id
        return str(self._run(self.svc.changes().getStartPageToken(**args))["startPageToken"])

    def list_changes(self, page_token: str, drive_id: str | None, page_size: int) -> ChangePage:
        args: dict[str, Any] = {"pageToken": page_token, "pageSize": page_size, "includeRemoved": True,
                                "includeItemsFromAllDrives": True, "supportsAllDrives": True, "spaces": "drive",
                                "fields": CHANGE_FIELDS}
        if drive_id:
            args["driveId"] = drive_id
        body = self._run(self.svc.changes().list(**args), listing=True)
        return ChangePage(list(body.get("changes") or []), body.get("nextPageToken"), body.get("newStartPageToken"))

    def get_file(self, file_id: str) -> dict[str, Any] | None:
        try:
            return dict(self._run(self.svc.files().get(fileId=file_id, supportsAllDrives=True,
                                                       fields="id,name,mimeType,parents,driveId,trashed")))
        except AccessLost:
            return None   # a parent the reader cannot see is outside every approved root

    def watch(self, page_token: str, drive_id: str | None, channel_id: str, address: str, token: str,
              expires_ms: int) -> Channel:
        args: dict[str, Any] = {"pageToken": page_token, "supportsAllDrives": True, "includeItemsFromAllDrives": True,
                                "includeRemoved": True, "spaces": "drive",
                                "body": {"id": channel_id, "type": "web_hook", "address": address, "token": token,
                                         "expiration": expires_ms}}
        if drive_id:
            args["driveId"] = drive_id
        body = self._run(self.svc.changes().watch(**args))
        expiry = body.get("expiration")
        return Channel(str(body["id"]), str(body["resourceId"]), int(expiry) if expiry else None)

    def stop(self, channel_id: str, resource_id: str) -> None:
        self._run(self.svc.channels().stop(body={"id": channel_id, "resourceId": resource_id}))


def _error_detail(exc: Any) -> tuple[str, str]:
    """Reason and message (with the failing parameter's name) from Google's error body; used to classify only."""
    try:
        error = json.loads(exc.content.decode("utf-8")).get("error", {})
        first = (error.get("errors") or [{}])[0]
        return str(first.get("reason") or ""), f"{error.get('message') or ''} {first.get('location') or ''}"
    except (ValueError, AttributeError, UnicodeDecodeError):
        return "", ""
