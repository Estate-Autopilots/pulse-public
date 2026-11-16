"""Shared mail and delegated Google bridge. No credentials or message content in diagnostics."""

import base64
import html
import io
import json
import os
import re
import sys
from email.message import EmailMessage
from email.utils import formataddr
from smtplib import SMTP, SMTP_SSL
from ssl import create_default_context
from urllib.parse import urlsplit


# MAIL-IDENTITY (owner, 4 Nov 2026): the same layout as services/api/src/mail-template.ts, in a company's look (its logo,
# else its name, on top; "Sent with Pulse" below). Gmail on phones and computers: tables and inline styles only, one
# 560px column that shrinks to the screen, 16px text, a 44px button, the logo by Content-ID with its alt text. The
# plain-text part is always the message itself (set_content), so this is only ever the HTML alternative.
MAIL_COLOURS = {"ink": "#0E2A2F", "red": "#D63F3A", "muted": "#4D6468", "page": "#EEF2F1", "rule": "#D3DCDB", "card": "#FFFFFF"}
MAIL_FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"
MONO_FONT = "'SFMono-Regular',Menlo,Consolas,'Courier New',monospace"
_URL_ONLY = re.compile(r"^(?:([^:\n]{2,60}):\s*)?(https?://\S+)$")
_CODE = re.compile(r"^(Your [^\n]{0,60}?code) is ([A-Z0-9-]{4,12})$", re.IGNORECASE)


def _linkify(text):
    safe = html.escape(text)
    style = f'color:{MAIL_COLOURS["red"]};text-decoration:underline;word-break:break-all'
    return re.sub(r"(https?://[^\s<]+[^\s<.,;:!?)'\"])", lambda m: f'<a href="{m.group(1)}" style="{style}">{m.group(1)}</a>', safe)


def _block(par):
    c = MAIL_COLOURS
    p = f"margin:0 0 16px;font-family:{MAIL_FONT};font-size:16px;line-height:24px;color:{c['ink']}"
    one = par.strip()
    code = _CODE.match(one)
    if code:
        box = (f"background:{c['page']};border:1px solid {c['rule']};border-radius:8px;padding:12px 20px;font-family:{MONO_FONT};"
               f"font-size:30px;line-height:36px;letter-spacing:6px;font-weight:700;color:{c['ink']}")
        return (f'<p style="{p};margin-bottom:8px">{html.escape(code.group(1))}:</p>'
                f'<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px"><tr>'
                f'<td style="{box}">{html.escape(code.group(2))}</td></tr></table>')
    link = _URL_ONLY.match(one)
    if link and "\n" not in one:
        label, url = (link.group(1) or "Open Pulse").strip(), link.group(2)
        a = (f"display:inline-block;padding:12px 24px;font-family:{MAIL_FONT};font-size:16px;line-height:20px;font-weight:600;"
             "color:#ffffff;text-decoration:none;border-radius:8px")
        return (f'<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 20px"><tr>'
                f'<td bgcolor="{c["red"]}" style="border-radius:8px"><a href="{html.escape(url)}" style="{a}">{html.escape(label)}</a></td></tr></table>'
                f'<p style="margin:-8px 0 20px;font-family:{MAIL_FONT};font-size:13px;line-height:20px;color:{c["muted"]}">'
                f'Or paste this link into your browser:<br>{_linkify(url)}</p>')
    return f'<p style="{p}">{_linkify(one).replace(chr(10), "<br>")}</p>'


def branded_html(title, body, name, logo=True):
    """The message as HTML in the company's look: its logo (cid:org-logo) when it has one, else its name."""
    c = MAIL_COLOURS
    who = html.escape(name or "Pulse")
    if logo:
        header = (f'<img src="cid:org-logo" alt="{who}" height="40" '
                  'style="display:block;height:40px;width:auto;max-width:220px;border:0;outline:none;text-decoration:none">')
    else:
        header = f'<span style="font-family:{MAIL_FONT};font-size:20px;line-height:28px;font-weight:700;color:{c["ink"]}">{who}</span>'
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", str(body).replace("\r\n", "\n").strip()) if p.strip()]
    preheader = html.escape(re.sub(r"\s+", " ", paragraphs[0] if paragraphs else str(title))[:110])
    heading = f"margin:0 0 16px;font-family:{MAIL_FONT};font-size:22px;line-height:30px;font-weight:700;color:{c['ink']}"
    card = f"background:{c['card']};border:1px solid {c['rule']};border-radius:12px;padding:28px 24px 12px"
    foot = f"margin:0;font-family:{MAIL_FONT};font-size:12px;line-height:18px;color:{c['muted']}"
    return (
        '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
        f'<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>{html.escape(str(title))}</title></head>'
        f'<body style="margin:0;padding:0;background:{c["page"]};-webkit-text-size-adjust:100%">'
        f'<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:{c["page"]}">{preheader}</div>'
        f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="{c["page"]}" style="background:{c["page"]}">'
        '<tr><td align="center" style="padding:24px 12px">'
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%">'
        f'<tr><td style="padding:0 4px 16px">{header}</td></tr>'
        f'<tr><td bgcolor="{c["card"]}" style="{card}"><h1 style="{heading}">{html.escape(str(title))}</h1>'
        + "".join(_block(p) for p in paragraphs)
        + f'</td></tr><tr><td style="padding:16px 4px 0"><p style="{foot}">{who} · Sent with Pulse by Vitals Technologies</p></td></tr>'
        '</table></td></tr></table></body></html>'
    )


def _png(data):
    raw = base64.b64decode(data, validate=True)
    if len(raw) > 512 * 1024 or not raw.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ValueError("brand")
    return raw


def add_html(msg, a):
    """The HTML alternative: the caller's own (the API renders it, with its inline images by Content-ID), else the
    company's look around the plain text when it sent its logo. Images are PNGs under 512 KB; anything else stops the send."""
    if isinstance(a.get("html"), str) and a["html"]:
        msg.add_alternative(a["html"][:400000], subtype="html")
        for image in (a.get("inline") or [])[:4]:
            cid = str(image.get("cid") or "")
            if not re.fullmatch(r"[a-z0-9-]{1,40}", cid):
                raise ValueError("inline")
            msg.get_payload()[1].add_related(_png(image.get("png") or ""), maintype="image", subtype="png", cid=f"<{cid}>")
        return
    brand = a.get("brand") or {}
    if brand.get("png"):
        logo = _png(brand["png"])
        msg.add_alternative(branded_html(a["title"], a["body"], brand.get("name") or ""), subtype="html")
        msg.get_payload()[1].add_related(logo, maintype="image", subtype="png", cid="<org-logo>")


def mail_headers(msg, sender, a):
    """From (with the company's name when given) and an optional Reply-To (PORTAL-2: client mail answers go to the
    client's contact at the company). Both are checked; anything odd is left out rather than sent."""
    name = re.sub(r"[\r\n\x00-\x1f\"<>]", "", str(a.get("fromName") or "")).strip()[:80]
    msg["From"] = formataddr((name, sender)) if name else sender
    reply = str(a.get("replyTo") or "").strip()
    if reply and re.fullmatch(r"[^\s@<>,;\"]+@[^\s@<>,;\"]+\.[^\s@<>,;\"]+", reply):
        msg["Reply-To"] = reply


ATTACHMENT_TYPES = {"application/zip": "zip", "application/pdf": "pdf"}


def add_file(msg, attachment):
    """One file with the message: a zip (exports) or, since BILLING-EMAIL, a document's PDF; at most 10 MB."""
    if not attachment:
        return
    data = base64.b64decode(attachment["bytes"], validate=True)
    subtype = ATTACHMENT_TYPES.get(attachment.get("mime"))
    if len(data) > 10 * 1024 * 1024 or not subtype:
        raise ValueError("attachment")
    name = re.sub(r"[^A-Za-z0-9._-]+", "-", str(attachment.get("name") or f"file.{subtype}"))[:120]
    msg.add_attachment(data, maintype="application", subtype=subtype, filename=name)


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
    mail_headers(msg, sender, a)
    msg["To"], msg["Subject"] = str(a["to"]), str(a["title"])
    msg.set_content(message_body)
    add_html(msg, a)
    add_file(msg, a.get("attachment"))
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
        mail_headers(msg, subject, a)
        msg["To"], msg["Subject"] = a["to"], a["title"]
        msg.set_content(a["body"])
        add_html(msg, a)
        add_file(msg, a.get("attachment"))
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
