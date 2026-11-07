"""Reading a file's bytes from Drive, bounded. Errors are classified as in the R44 feed (pulse_gdrive_changes.drive).

Content needs the read-only Drive scope, which is broader than R44's metadata scope: it is used only for roots with a
recorded content approval (owner errands E08/E13), and only for files the approved formats name. Nothing here lists
or searches a Drive: file ids come from the R44 feed's accepted state.
"""

from __future__ import annotations

import io
from pathlib import Path
from typing import Any, Protocol

from pulse_gdrive_changes.drive import AccessLost, DriveError, Unavailable, _error_detail, classify

CONTENT_SCOPE = "https://www.googleapis.com/auth/drive.readonly"
CHUNK = 1024 * 1024


class TooLarge(DriveError):
    code = "oversized"


class Flagged(DriveError):
    """Drive itself refuses to hand out the file (it flagged it as malware or abuse)."""
    code = "flagged_by_drive"


def _refusal(exc: Any) -> DriveError:
    reason, message = _error_detail(exc)
    if reason == "exportSizeLimitExceeded":
        return TooLarge()
    if reason == "cannotDownloadAbusiveFile":
        return Flagged()
    return classify(int(exc.resp.status), reason, message)


class DriveContent(Protocol):
    def get_file(self, file_id: str) -> dict[str, Any] | None: ...
    def download(self, file_id: str, max_bytes: int) -> bytes: ...
    def export(self, file_id: str, mime: str, max_bytes: int) -> bytes: ...


class _Bounded(io.RawIOBase):
    """A write target that refuses to grow past `limit` bytes."""

    def __init__(self, limit: int):
        self.limit, self.buffer = limit, bytearray()

    def writable(self) -> bool:
        return True

    def write(self, data: Any) -> int:
        if len(self.buffer) + len(data) > self.limit:
            raise TooLarge()
        self.buffer.extend(data)
        return len(data)


class GoogleDriveContent:
    """Drive v3 with a service account (as R44's feed), with the read-only scope."""

    def __init__(self, credential: Path, subject: str | None, *, timeout: float = 60.0):
        import google_auth_httplib2
        import httplib2
        from google.oauth2 import service_account
        from googleapiclient.discovery import build

        creds = service_account.Credentials.from_service_account_file(str(credential), scopes=[CONTENT_SCOPE])
        if subject:
            creds = creds.with_subject(subject)
        http = google_auth_httplib2.AuthorizedHttp(creds, http=httplib2.Http(timeout=timeout))
        self.svc = build("drive", "v3", http=http, cache_discovery=False)

    def _fetch(self, request: Any, max_bytes: int) -> bytes:
        from googleapiclient.errors import HttpError
        from googleapiclient.http import MediaIoBaseDownload

        target = _Bounded(max_bytes)
        try:
            download = MediaIoBaseDownload(target, request, chunksize=CHUNK)
            done = False
            while not done:
                _, done = download.next_chunk(num_retries=0)
        except HttpError as exc:
            raise _refusal(exc) from None
        except (OSError, TimeoutError) as exc:
            raise Unavailable() from exc
        return bytes(target.buffer)

    def get_file(self, file_id: str) -> dict[str, Any] | None:
        from googleapiclient.errors import HttpError

        try:
            return dict(self.svc.files().get(fileId=file_id, supportsAllDrives=True,
                                             fields="id,name,mimeType,parents,driveId,trashed").execute(num_retries=0))
        except HttpError as exc:
            error = _refusal(exc)
            if isinstance(error, AccessLost):
                return None
            raise error from None
        except (OSError, TimeoutError) as exc:
            raise Unavailable() from exc

    def download(self, file_id: str, max_bytes: int) -> bytes:
        return self._fetch(self.svc.files().get_media(fileId=file_id, supportsAllDrives=True), max_bytes)

    def export(self, file_id: str, mime: str, max_bytes: int) -> bytes:
        return self._fetch(self.svc.files().export_media(fileId=file_id, mimeType=mime), max_bytes)
