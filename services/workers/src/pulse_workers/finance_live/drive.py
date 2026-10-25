# ruff: noqa: E501
"""Invoice filing into the EA Finance Shared Drive, as the service account itself.

Every folder and file creation first reads the parent's authoritative metadata and refuses any parent outside the one
configured Shared Drive. Created items are checked again. Nothing is ever updated, moved or deleted.
"""

from __future__ import annotations

import io
import re

from .common import digest

FOLDER = "application/vnd.google-apps.folder"
FINANCE_DRIVE = "0SYNTHf1d61f234b0f9"


class OutsideFinanceDrive(ValueError):
    pass


def safe_part(value, limit=60) -> str:
    text = re.sub(r"[^\w.-]+", "_", str(value or "Unknown"), flags=re.ASCII).strip("._")
    return text[:limit] or "Unknown"


def file_name(day: str, party: str, amount, number: str | None) -> str:
    figure = f"{float(amount):.2f}" if amount is not None else "amount-unknown"
    return "_".join([safe_part(day, 10), safe_part(party), figure, safe_part(number or "no-number", 40)]) + ".pdf"


class SharedDrive:
    def __init__(self, service, drive_id: str = FINANCE_DRIVE):
        if not drive_id:
            raise ValueError("Finance Shared Drive ID required")
        self.service, self.drive = service, drive_id
        self._folders: dict[tuple[str, str], str] = {}

    def _inside(self, item_id: str) -> None:
        meta = (
            self.service.files()
            .get(fileId=item_id, fields="id,driveId,mimeType,trashed", supportsAllDrives=True)
            .execute()
        )
        if meta.get("driveId") != self.drive or meta.get("trashed") or meta.get("mimeType") != FOLDER:
            raise OutsideFinanceDrive("Write outside the EA Finance Shared Drive rejected")

    def _find(self, parent: str, key: str):
        rows = (
            self.service.files()
            .list(
                corpora="drive",
                driveId=self.drive,
                includeItemsFromAllDrives=True,
                supportsAllDrives=True,
                q=f"'{parent}' in parents and trashed = false and appProperties has {{ key='pulseFinanceKey' and value='{digest(key)}' }}",
                fields="files(id,driveId,parents,mimeType,name)",
                pageSize=2,
            )
            .execute()
            .get("files", [])
        )
        if len(rows) > 1:
            raise ValueError("Duplicate Finance artifact; manual review required")
        if rows and rows[0].get("driveId") != self.drive:
            raise OutsideFinanceDrive("Finance artifact outside the Shared Drive")
        return rows[0] if rows else None

    def folder(self, parent: str, name: str) -> str:
        if not name or name in (".", "..") or re.search(r"[/\\\r\n]", name):
            raise ValueError("Unsafe Finance folder name")
        if (parent, name) in self._folders:
            return self._folders[(parent, name)]
        self._inside(parent)
        existing = self._find(parent, "folder:" + name)
        if existing:
            folder_id = existing["id"]
        else:
            made = (
                self.service.files()
                .create(
                    body={
                        "name": name,
                        "parents": [parent],
                        "mimeType": FOLDER,
                        "appProperties": {"pulseFinanceKey": digest("folder:" + name)},
                    },
                    fields="id,driveId",
                    supportsAllDrives=True,
                )
                .execute()
            )
            if made.get("driveId") != self.drive:
                raise OutsideFinanceDrive("Created folder is outside the Shared Drive")
            folder_id = made["id"]
        self._folders[(parent, name)] = folder_id
        return folder_id

    def path(self, parts: list[str]) -> str:
        parent = self.drive
        for name in parts:
            parent = self.folder(parent, name)
        return parent

    def put(self, parts: list[str], name: str, content: bytes, key: str) -> dict:
        """File one PDF once. Returns {'id','created'}. Existing artifacts are never overwritten."""
        from googleapiclient.http import MediaIoBaseUpload

        if not name.endswith(".pdf") or re.search(r"[/\\\r\n]", name) or not content.startswith(b"%PDF-"):
            raise ValueError("Only named PDF evidence is filed")
        parent = self.path(parts)
        existing = self._find(parent, key)
        if existing:
            return {"id": existing["id"], "created": False}
        self._inside(parent)
        made = (
            self.service.files()
            .create(
                body={
                    "name": name,
                    "parents": [parent],
                    "mimeType": "application/pdf",
                    "appProperties": {"pulseFinanceKey": digest(key)},
                },
                media_body=MediaIoBaseUpload(io.BytesIO(content), mimetype="application/pdf", resumable=False),
                fields="id,driveId",
                supportsAllDrives=True,
            )
            .execute()
        )
        if made.get("driveId") != self.drive:
            raise OutsideFinanceDrive("Created file is outside the Shared Drive")
        return {"id": made["id"], "created": True}


def drive_service(key_path: str):
    """The service account itself (no impersonation) with the `drive` scope; writes are confined in SharedDrive."""
    from google.oauth2 import service_account
    from googleapiclient.discovery import build

    credentials = service_account.Credentials.from_service_account_file(
        key_path, scopes=["https://www.googleapis.com/auth/drive"]
    )
    return build("drive", "v3", credentials=credentials, cache_discovery=False)


def readonly_drive(key_path: str, subject: str):
    from google.oauth2 import service_account
    from googleapiclient.discovery import build

    credentials = service_account.Credentials.from_service_account_file(
        key_path, scopes=["https://www.googleapis.com/auth/drive.readonly"], subject=subject
    )
    return build("drive", "v3", credentials=credentials, cache_discovery=False)


def readonly_gmail(key_path: str, subject: str):
    from google.oauth2 import service_account
    from googleapiclient.discovery import build

    credentials = service_account.Credentials.from_service_account_file(
        key_path, scopes=["https://www.googleapis.com/auth/gmail.readonly"], subject=subject
    )
    return build("gmail", "v1", credentials=credentials, cache_discovery=False)
