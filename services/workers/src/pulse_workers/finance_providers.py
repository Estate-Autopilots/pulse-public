"""RF1 provider contracts. Constructing a provider is an explicit future owner activation.

Drive uses full `drive` scope, scoped in code to the Finance folder for EVERY write.
Sheets are imported CSV mirrors through Drive, so no untested Sheets delegation is required.
Zoho Books remains the general ledger if the owner confirms it; this module's client is a fixture.
"""

import base64
import io
import re
from datetime import UTC, datetime
from email.utils import parseaddr, parsedate_to_datetime
from zoneinfo import ZoneInfo

from .finance_desk import FinanceDrive, digest


class GoogleFinanceMail:
    """Only metadata query hits are read; only locally selected finance mail gets content.

    The owner constructs two delegated Gmail clients: finance-bot and marketing. The
    normal command in finance_desk remains fixtures, so this adapter is never autoactivated.
    """

    def __init__(self, clients, config):
        if not config.get("financeBotExists") or config.get("billingMailbox") != "finance-bot@estateautopilots.com":
            raise ValueError("Owner-created finance-bot required")
        if set(clients) != {config["billingMailbox"], "marketing@estateautopilots.com"}:
            raise ValueError("Only configured billing intake and finance-filtered marketing are allowed")
        if not config["senders"] or any(
            not re.fullmatch(r"[A-Za-z0-9_.+-]+@[A-Za-z0-9.-]+", s) for s in config["senders"]
        ):
            raise ValueError("Exact verified finance sender allowlist required")
        self.clients, self.config, self.allowed = clients, config, {}

    def headers(self):
        from .finance_desk import finance_mail

        senders = "{" + " ".join("from:" + s for s in self.config["senders"]) + "}"
        subjects = (
            "{subject:invoice subject:invoices subject:receipt subject:receipts "
            "subject:bill subject:bills subject:statement subject:statements subject:GST "
            'subject:GSTR subject:ITR subject:TDS subject:ARN subject:"Form 8" '
            'subject:"Form 11" subject:Form8 subject:Form11 '
            "subject:payroll subject:salary subject:subscription subject:renewal}"
        )
        query = senders + " " + subjects + " -subject:OTP -subject:verification"
        for mailbox, client in self.clients.items():
            page = None
            while True:
                listing = (
                    client.users()
                    .messages()
                    .list(userId="me", q=query, maxResults=100, **({"pageToken": page} if page else {}))
                    .execute()
                )
                for item in listing.get("messages", []):
                    row = (
                        client.users()
                        .messages()
                        .get(userId="me", id=item["id"], format="metadata", metadataHeaders=["From", "Subject", "Date"])
                        .execute()
                    )
                    metadata = {h["name"].lower(): h["value"] for h in row.get("payload", {}).get("headers", [])}
                    header = {
                        "id": mailbox + ":" + item["id"],
                        "mailbox": mailbox,
                        "sender": parseaddr(metadata.get("from", ""))[1].lower(),
                        "subject": metadata.get("subject", ""),
                    }
                    if not finance_mail(header, self.config):
                        continue
                    try:
                        when = parsedate_to_datetime(metadata.get("date", ""))
                        if when.tzinfo is None:
                            when = when.replace(tzinfo=UTC)
                        header["date"] = when.astimezone(ZoneInfo("Asia/Kolkata")).date().isoformat()
                    except (ValueError, TypeError):
                        header["date"] = (
                            datetime.fromtimestamp(int(row.get("internalDate", "0")) / 1000, UTC)
                            .astimezone(ZoneInfo("Asia/Kolkata"))
                            .date()
                            .isoformat()
                        )
                    self.allowed[header["id"]] = (mailbox, item["id"], header)
                    yield header
                page = listing.get("nextPageToken")
                if not page:
                    break

    def content(self, key):
        if key not in self.allowed:
            raise ValueError("Unselected marketing mail must never be read")
        mailbox, message_id, header = self.allowed[key]
        messages = self.clients[mailbox].users().messages()
        row = messages.get(userId="me", id=message_id, format="full").execute()
        attachments = []

        def parts(part):
            if part.get("mimeType") == "application/pdf":
                body = part.get("body", {})
                if body.get("size", 0) > 10 * 1024 * 1024:
                    raise ValueError("Finance PDF exceeds intake limit")
                data = body.get("data")
                if data is None and body.get("attachmentId"):
                    data = (
                        messages.attachments()
                        .get(userId="me", messageId=message_id, id=body["attachmentId"])
                        .execute()
                        .get("data", "")
                    )
                if data:
                    attachments.append(
                        {
                            "id": part.get("partId") or body.get("attachmentId") or "root",
                            "mime": "application/pdf",
                            "bytes": base64.urlsafe_b64decode(data + "=" * (-len(data) % 4)),
                        }
                    )
            for child in part.get("parts", []):
                parts(child)

        parts(row.get("payload", {}))
        # No text bodies, snippets, OTPs or unrelated attachments are retained.
        return {"date": header["date"], "attachments": attachments}


def finance_mail_credentials(key_path, mailbox):
    from google.oauth2 import service_account

    if mailbox not in ("finance-bot@estateautopilots.com", "marketing@estateautopilots.com"):
        raise ValueError("Finance mailbox identity required")
    return service_account.Credentials.from_service_account_file(
        key_path, scopes=["https://www.googleapis.com/auth/gmail.readonly"], subject=mailbox
    )


class GoogleFinancePort:
    def __init__(self, service, root_id):
        self.service, self.root = service, root_id

    def metadata(self, key):
        return (
            self.service.files().get(fileId=key, fields="id,parents,mimeType,trashed", supportsAllDrives=True).execute()
        )

    def parents(self, key):
        row = self.metadata(key)
        if row.get("trashed"):
            return []
        return row.get("parents", [])

    def is_folder(self, key):
        row = self.metadata(key)
        return not row.get("trashed") and row.get("mimeType") == "application/vnd.google-apps.folder"

    def _allow(self, parent, name):
        FinanceDrive(self, self.root).confined(parent)
        if not name or name in (".", "..") or re.search(r"[/\\\r\n]", name):
            raise ValueError("Unsafe Finance filename")

    def find(self, parent, key):
        # Search only the checked parent. Every caller-owned string is either hashed or escaped.
        FinanceDrive(self, self.root).confined(parent)
        safe_parent = parent.replace("\\", "\\\\").replace("'", "\\'")
        query = (
            f"'{safe_parent}' in parents and trashed = false "
            "and appProperties has { key='pulseFinanceKey' and "
            f"value='{digest(key)}' }}"
        )
        rows = (
            self.service.files()
            .list(
                q=query,
                fields="files(id,parents,mimeType)",
                supportsAllDrives=True,
                includeItemsFromAllDrives=True,
                pageSize=2,
            )
            .execute()
            .get("files", [])
        )
        if len(rows) > 1:
            raise ValueError("Duplicate Finance artifact; manual review required")
        return rows[0] if rows else None

    def folder(self, parent, name):
        self._allow(parent, name)
        existing = self.find(parent, "folder:" + name)
        if existing:
            if existing["mimeType"] != "application/vnd.google-apps.folder":
                raise ValueError("Finance folder identity conflict")
            return existing["id"]
        # Recheck authoritative ancestry immediately before the mutation.
        self._allow(parent, name)
        return (
            self.service.files()
            .create(
                body={
                    "name": name,
                    "parents": [parent],
                    "mimeType": "application/vnd.google-apps.folder",
                    "appProperties": {"pulseFinanceKey": digest("folder:" + name)},
                },
                fields="id",
                supportsAllDrives=True,
            )
            .execute()["id"]
        )

    def write(self, parent, name, content, mime, key):
        from googleapiclient.http import MediaIoBaseUpload

        self._allow(parent, name)
        existing = self.find(parent, key)
        if existing:
            if existing.get("parents") != [parent]:
                raise ValueError("Write outside Finance root rejected")
            if not key.startswith("sheet:"):
                return existing["id"]
            self._allow(parent, name)
            return (
                self.service.files()
                .update(
                    fileId=existing["id"],
                    media_body=MediaIoBaseUpload(io.BytesIO(content), mimetype=mime, resumable=True),
                    fields="id",
                    supportsAllDrives=True,
                )
                .execute()["id"]
            )
        self._allow(parent, name)
        return (
            self.service.files()
            .create(
                body={
                    "name": name,
                    "parents": [parent],
                    "mimeType": "application/vnd.google-apps.spreadsheet" if key.startswith("sheet:") else mime,
                    "appProperties": {"pulseFinanceKey": digest(key)},
                },
                media_body=MediaIoBaseUpload(io.BytesIO(content), mimetype=mime, resumable=True),
                fields="id",
                supportsAllDrives=True,
            )
            .execute()["id"]
        )


def finance_drive_credentials(key_path, *, impersonate=None):
    from google.oauth2 import service_account

    if impersonate not in (None, "finance-bot@estateautopilots.com"):
        raise ValueError("Finance Drive acts as service account or finance-bot only")
    return service_account.Credentials.from_service_account_file(
        key_path, scopes=["https://www.googleapis.com/auth/drive"], subject=impersonate
    )


class FixtureZohoBooks:
    """The owner supplies the real API client. Fixture contract mirrors POST /bills.

    Tax IDs/vendor IDs are mappings confirmed in Books, never guessed from a vendor name.
    Durable Pulse keys must be reconciled to Books bill IDs before retrying an uncertain POST.
    """

    def __init__(self):
        self.bills = {}

    def create_bill(self, key, invoice, vendor_id, tax_id):
        if invoice["status"] != "extracted" or not vendor_id or not tax_id:
            raise ValueError("Validated invoice and confirmed Zoho vendor/tax mappings required")
        payload = {
            "vendor_id": vendor_id,
            "bill_number": invoice["invoiceNo"],
            "date": invoice["date"],
            "reference_number": "pulse:" + key,
            "line_items": [
                {"description": invoice["vendor"], "quantity": 1, "rate": invoice["taxable"], "tax_id": tax_id}
            ],
        }
        if key in self.bills and self.bills[key]["payload"] != payload:
            raise ValueError("Zoho retry differs from recorded handoff")
        self.bills.setdefault(key, {"bill_id": "fixture-" + key[:16], "payload": payload, "status": "fixture_posted"})
        return self.bills[key]
