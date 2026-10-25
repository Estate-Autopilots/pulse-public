"""Shared mail and delegated Google bridge. No credentials or message content in diagnostics."""

import base64
import html
import io
import json
import os
import re
import sys
from email.message import EmailMessage
from smtplib import SMTP, SMTP_SSL
from ssl import create_default_context
from urllib.parse import urlsplit


def branded_html(title, body, name):
    """The plain-text message as simple HTML under the organisation's logo (LAYOUT-SWEEP), linked as cid:org-logo."""
    def para(text):
        safe = html.escape(text)
        safe = re.sub(r"(https?://[^\s<]+)", r'<a href="\1" style="color:#4f37d0">\1</a>', safe)
        return f'<p style="margin:0 0 12px;line-height:1.55">{safe.replace(chr(10), "<br>")}</p>'
    paras = "".join(para(p) for p in re.split(r"\n\s*\n", body.strip()) if p.strip())
    who = html.escape(name)
    return (
        '<div style="font-family:Inter,Segoe UI,Arial,sans-serif;font-size:15px;color:#17123a;max-width:560px;margin:0 auto;padding:24px 20px">'
        f'<img src="cid:org-logo" alt="{who}" height="40" style="display:block;height:40px;width:auto;margin:0 0 22px;border:0">'
        f'<h1 style="font-size:18px;line-height:1.35;margin:0 0 14px">{html.escape(title)}</h1>{paras}'
        f'<p style="margin:22px 0 0;color:#6b6880;font-size:12px">Sent by Pulse for {who}</p></div>'
    )


def mail_settings():
    """Return non-secret sender and recipient policy from environment defaults."""
    configured_sender = os.environ.get("PULSE_MAIL_FROM", "").strip() or None
    production_host = (os.environ.get("PULSE_MAIL_PRODUCTION_HOST", "pulse.estateautopilots.com").strip()
                      or "pulse.estateautopilots.com").lower()
    staging_allow = os.environ.get(
        "PULSE_MAIL_STAGING_ALLOW", "hr@estateautopilots.com,admin@estateautopilots.com"
    )
    allow = {address.strip().lower() for address in staging_allow.split(",") if address.strip()}
    try:
        host = (urlsplit(os.environ.get("PULSE_PUBLIC_URL", "")).hostname or "").lower()
    except ValueError:
        host = ""
    return configured_sender, production_host, allow, host


def google_subject_for_send(args, configured_sender):
    """Use a caller's explicit mailbox when supplied; installation sender is the default only."""
    return str(args.get("from") or args.get("subject") or configured_sender or "hr@estateautopilots.com").strip()


def google_subject_allowed(subject, domain):
    domain = str(domain).strip().lower()
    return bool(domain) and re.fullmatch(r"[^\s@]+@" + re.escape(domain), str(subject).strip(), flags=re.IGNORECASE) is not None


def send_smtp(a):
    """Send plain text through the root-provided SMTP file; never include credentials in diagnostics."""
    config_path = os.environ.get("PULSE_SMTP_FILE", "").strip()
    if not config_path:
        raise ValueError("mail unavailable")
    with open(config_path, encoding="utf-8") as config_file:
        config = json.load(config_file)
    host = str(config.get("host", "")).strip()
    port = int(config.get("port", 0))
    user = str(config.get("user", ""))
    password = str(config.get("password", ""))
    if not host or not user or not password or port not in (465, 587):
        raise ValueError("mail unavailable")

    configured_sender = os.environ.get("PULSE_MAIL_FROM", "").strip() or "hr@estateautopilots.com"
    sender = str(a.get("from") or a.get("subject") or configured_sender).strip()
    if not re.fullmatch(r"[^\s@]+@[^\s@]+", sender):
        raise ValueError("mail unavailable")
    if sender.casefold() != configured_sender.casefold():
        raise ValueError("mail unavailable")
    message_body = str(a["body"])
    brand = a.get("brand") or {}
    brand_name = str(brand.get("name") or "").strip()
    if brand_name and brand_name.casefold() not in message_body.casefold():
        message_body += "\n\n" + brand_name
    msg = EmailMessage()
    msg["From"], msg["To"], msg["Subject"] = sender, str(a["to"]), str(a["title"])
    msg.set_content(message_body)
    if a.get("attachment"):
        attachment = a["attachment"]
        data = base64.b64decode(attachment["bytes"], validate=True)
        if len(data) > 10 * 1024 * 1024 or attachment["mime"] != "application/zip":
            raise ValueError("attachment")
        msg.add_attachment(data, maintype="application", subtype="zip", filename=attachment["name"])
    context = create_default_context()
    if port == 465:
        with SMTP_SSL(host, port, timeout=25, context=context) as client:
            client.login(user, password)
            client.send_message(msg)
    else:
        with SMTP(host, port, timeout=25) as client:
            client.ehlo()
            client.starttls(context=context)
            client.ehlo()
            client.login(user, password)
            client.send_message(msg)
    return {"id": "smtp-sent", "sent": True}


def main():
    action = sys.argv[1]
    a = json.load(sys.stdin)
    transport = os.environ.get("PULSE_MAIL_TRANSPORT", "google").strip().lower() or "google"
    if action == "send":
        if os.environ.get("PULSE_GMAIL_SEND_ENABLED") != "1":
            raise ValueError("mail unavailable")
        configured_sender, production_host, allow, host = mail_settings()
        recipient = str(a.get("to", "")).strip().lower()
        if not recipient or (host != production_host and recipient not in allow):
            raise ValueError("mail unavailable")
        sender = google_subject_for_send(a, configured_sender)
        if not re.fullmatch(r"[^\s@]+@[^\s@]+", sender):
            raise ValueError("mail unavailable")
        if transport == "smtp":
            return send_smtp({**a, "from": sender})
        if transport != "google":
            raise ValueError("mail unavailable")
        a["subject"] = sender
    subject = a.get("subject", "")
    domain = os.environ.get("PULSE_GOOGLE_DOMAIN", "estateautopilots.com").strip().lower()
    if not google_subject_allowed(subject, domain):
        raise ValueError("mail unavailable")
    scope = {"inbox": "gmail.readonly", "send": "gmail.send", "upload": "drive.file"}[
        action
    ]
    if action == "send" and os.environ.get("PULSE_GMAIL_SEND_ENABLED") != "1":
        raise ValueError("send disabled")
    if action == "upload" and os.environ.get("PULSE_DRIVE_UPLOAD_ENABLED") != "1":
        raise ValueError("upload disabled")
    import google_auth_httplib2
    import httplib2
    from google.oauth2 import service_account
    from googleapiclient.discovery import build
    from googleapiclient.http import MediaIoBaseUpload

    creds = service_account.Credentials.from_service_account_file(
        os.environ.get(
            "PULSE_GOOGLE_KEY", "/etc/estate-autopilots/google/indexer-sa.json"
        ),
        scopes=["https://www.googleapis.com/auth/" + scope],
        subject=subject,
    )
    http = google_auth_httplib2.AuthorizedHttp(creds, http=httplib2.Http(timeout=25))
    svc = build(
        "drive" if action == "upload" else "gmail",
        "v3" if action == "upload" else "v1",
        http=http,
        cache_discovery=False,
    )
    if action == "inbox":
        messages = svc.users().messages()

        def decode(raw):
            return base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4))

        def walk(part, out):
            """Collect the first text/plain and text/html bodies and every attachment (inline images by Content-ID)."""
            mime = part.get("mimeType", "")
            body = part.get("body", {})
            headers = {x["name"].lower(): x["value"] for x in part.get("headers", [])}
            if part.get("filename") and body.get("attachmentId"):
                out["attachments"].append({"id": body["attachmentId"], "name": part["filename"][:200], "mime": mime[:100],
                                           "size": body.get("size", 0), "cid": headers.get("content-id", "").strip("<>")[:200] or None})
            elif mime == "text/plain" and "text" not in out and body.get("data"):
                out["text"] = decode(body["data"]).decode("utf-8", errors="replace")[:100000]
            elif mime == "text/html" and "html" not in out and body.get("data"):
                out["html"] = decode(body["data"]).decode("utf-8", errors="replace")[:400000]
            for child in part.get("parts", []):
                walk(child, out)
            return out

        def normalise(row):
            payload = row.get("payload", {})
            headers = {x["name"].lower(): x["value"] for x in payload.get("headers", [])}
            out = walk(payload, {"attachments": []})
            return {"id": row["id"], "threadId": row.get("threadId"), "from": headers.get("from", ""),
                    "to": headers.get("to", ""), "cc": headers.get("cc", ""), "subject": headers.get("subject", ""),
                    "date": headers.get("date", ""), "internalDate": row.get("internalDate"), "labelIds": row.get("labelIds", []),
                    "snippet": row.get("snippet", ""), "body": out.get("text") or row.get("snippet", ""), "html": out.get("html"),
                    "attachments": out["attachments"], "unread": "UNREAD" in row.get("labelIds", [])}

        if a.get("attachment"):
            data = messages.attachments().get(userId="me", messageId=a["message"], id=a["attachment"]).execute().get("data", "")
            raw = decode(data)
            if len(raw) > 15 * 1024 * 1024:
                raise ValueError("size")
            return {"bytes": base64.b64encode(raw).decode()}
        if a.get("labels"):
            return {"labels": [{"id": x["id"], "name": x["name"], "type": x.get("type", "user")}
                               for x in svc.users().labels().list(userId="me").execute().get("labels", [])]}
        if a.get("thread"):
            thread = svc.users().threads().get(userId="me", id=a["thread"], format="full").execute()
            return {"thread": [normalise(row) for row in thread.get("messages", [])], "rows": []}
        if a.get("message"):
            row = messages.get(userId="me", id=a["message"], format="full").execute()
            return {"message": normalise(row), "rows": []}
        listing = messages.list(
            userId="me",
            maxResults=int(a.get("limit") or 25),
            **({"labelIds": a["labelIds"]} if a.get("labelIds") else {}),
            **({"q": a["query"]} if a.get("query") else {}),
            **({"pageToken": a["cursor"]} if a.get("cursor") else {}),
        ).execute()
        # One batched round trip for the page's headers instead of one request per message.
        found = {}

        def keep(request_id, response, exception):
            if exception is None:
                found[request_id] = response

        batch = svc.new_batch_http_request(callback=keep)
        items = listing.get("messages", [])
        for item in items:
            batch.add(messages.get(userId="me", id=item["id"], format="metadata",
                                   metadataHeaders=["From", "To", "Subject", "Date", "Content-Type"]), request_id=item["id"])
        if items:
            batch.execute()
        rows = []
        for item in items:
            row = found.get(item["id"])
            if not row:
                continue
            headers = {x["name"].lower(): x["value"] for x in row.get("payload", {}).get("headers", [])}
            rows.append({"id": row["id"], "threadId": row.get("threadId"), "unread": "UNREAD" in row.get("labelIds", []),
                         "labelIds": row.get("labelIds", []), "snippet": row.get("snippet", ""), "internalDate": row.get("internalDate"),
                         "from": headers.get("from", ""), "to": headers.get("to", ""), "subject": headers.get("subject", ""),
                         "date": headers.get("date", ""), "hasAttachment": headers.get("content-type", "").lower().startswith("multipart/mixed")})
        return {"rows": rows, "nextCursor": listing.get("nextPageToken"), "estimate": listing.get("resultSizeEstimate")}
    if action == "send":
        msg = EmailMessage()
        msg["From"], msg["To"], msg["Subject"] = subject, a["to"], a["title"]
        msg.set_content(a["body"])
        brand = a.get("brand") or {}
        if brand.get("png"):
            logo = base64.b64decode(brand["png"], validate=True)
            if len(logo) > 512 * 1024 or not logo.startswith(b"\x89PNG\r\n\x1a\n"):
                raise ValueError("brand")
            msg.add_alternative(branded_html(a["title"], a["body"], brand.get("name") or ""), subtype="html")
            msg.get_payload()[1].add_related(logo, maintype="image", subtype="png", cid="<org-logo>")
        if a.get("attachment"):
            attachment = a["attachment"]
            data = base64.b64decode(attachment["bytes"], validate=True)
            if len(data) > 10 * 1024 * 1024 or attachment["mime"] != "application/zip":
                raise ValueError("attachment")
            msg.add_attachment(data, maintype="application", subtype="zip", filename=attachment["name"])
        result = (
            svc.users()
            .messages()
            .send(
                userId="me",
                body={"raw": base64.urlsafe_b64encode(msg.as_bytes()).decode()},
            )
            .execute()
        )
        return {"id": result["id"], "ok": True}
    data = base64.b64decode(a["bytes"], validate=True)
    if len(data) > 5 * 1024 * 1024:
        raise ValueError("size")
    row = (
        svc.files()
        .create(
            body={
                "name": a["name"],
                "parents": [a["folder"]],
                "appProperties": {"pulseUploader": subject},
            },
            media_body=MediaIoBaseUpload(io.BytesIO(data), mimetype=a["mime"]),
            supportsAllDrives=True,
            fields="id,webViewLink",
        )
        .execute()
    )
    return row


if __name__ == "__main__":
    try:
        print(json.dumps(main()))
    except Exception:  # noqa: BLE001 — diagnostics must never expose credentials or private payloads
        print(
            json.dumps(
                {
                    "error": "Mail or Google could not complete this request. Check the configured account and transport."
                }
            )
        )
        sys.exit(1)
