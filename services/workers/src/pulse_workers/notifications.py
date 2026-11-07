"""Personal Telegram decision outbox. Sends generic decisions only to admin-verified private chats.

Source /etc/estate-autopilots/secrets/telegram.env into the worker environment when Telegram is configured, then run
python -m pulse_workers.notifications. Telegram is optional: without TELEGRAM_BOT_TOKEN the minute tick runs as usual
and the Telegram channel reports "disabled" (systemd units load the file with EnvironmentFile=-…, so a missing file
never stops the tick). Mail, finance, HR reasons and chat IDs never enter diagnostics.
No connection means no send; the shared operations chat is never a fallback.
"""

import base64
import importlib.util
import json
import os
import re
import subprocess
import urllib.error
import urllib.request
from email.utils import formataddr, parseaddr
from pathlib import Path
from urllib.parse import urlsplit

from psycopg.pq import TransactionStatus

from pulse_sdk.db import active_orgs, connect, tenant_tx
from pulse_sdk.paths import repo_root

test_sink = []


def _mail_bridge_path():
    return repo_root() / "tools" / "google-bridge.py"


def telegram(method, payload):
    if os.environ.get("PULSE_CI") == "1" or os.environ.get("PULSE_NOTIFICATION_MODE") == "sink":
        test_sink.append({"channel": "telegram", "method": method, "payload": payload})
        return {"type": "private"} if method == "getChat" else {"ok": True}
    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    if not token:
        raise RuntimeError("Telegram credential unavailable")
    req = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/{method}",
        data=json.dumps(payload).encode(),
        headers={"content-type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        result = json.loads(r.read())
    if not result.get("ok"):
        raise RuntimeError("Telegram unavailable")
    return result["result"]



def _platform_mail():
    """DE-EA: the install's sender, origin, production host and staging allow-list, derived like the API's
    platform-config.ts from PULSE_PUBLIC_URL / PULSE_PLATFORM_DOMAIN / PULSE_GOOGLE_DOMAIN, never one company's
    literal."""
    public = os.environ.get("PULSE_PUBLIC_URL", "").strip()
    try:
        url_host = (urlsplit(public).hostname or "").lower()
    except ValueError:
        url_host = ""
    domain = (os.environ.get("PULSE_PLATFORM_DOMAIN", "").strip().lower() or url_host) or None
    google = os.environ.get("PULSE_GOOGLE_DOMAIN", "").strip().lower()
    mail_domain = google or (".".join(domain.split(".")[1:]) if domain and domain.count(".") >= 2 else domain)
    sender = os.environ.get("PULSE_MAIL_FROM", "").strip().lower() or (f"hr@{mail_domain}" if mail_domain else "")
    client = (os.environ.get("PULSE_CLIENT_MAIL_FROM", "").strip().lower()
              or (f"admin@{mail_domain}" if mail_domain else ""))
    production = os.environ.get("PULSE_MAIL_PRODUCTION_HOST", "").strip().lower() or (
        domain if os.environ.get("PULSE_ENV") == "production" else "")
    raw_allow = os.environ.get("PULSE_MAIL_STAGING_ALLOW")
    allow = ({a.strip().lower() for a in raw_allow.split(",") if a.strip()} if raw_allow is not None
             else {a for a in (sender, client) if a})
    origin = public.rstrip("/") or (f"https://{domain}" if domain else "")
    return {"sender": sender, "origin": origin, "production": production, "allow": allow}


def mail_recipient_allowed(to):
    """MAIL-GUARD (5 Nov 2026), as the API's platform-config.ts mailRecipientAllowed: this worker mails anyone only
    when PULSE_PUBLIC_URL's host is the mail production host and PULSE_ENV does not name another environment
    (staging, dev, lab...: staging holds a copy of real company data). Any other worker mails only
    PULSE_MAIL_STAGING_ALLOW, with no exception for a mailbox's own address. (An unset PULSE_ENV is left as before
    here: the production timer's unit sets only PULSE_PUBLIC_URL; the API requires PULSE_ENV=production.)"""
    recipient = str(to or "").strip().lower()
    if not recipient:
        return False
    mail = _platform_mail()
    try:
        host = (urlsplit(os.environ.get("PULSE_PUBLIC_URL", "")).hostname or "").lower()
    except ValueError:
        host = ""
    name = os.environ.get("PULSE_ENV", "").strip().lower()
    live = name in ("", "production", "prod") and bool(mail["production"]) and host == mail["production"]
    return live or recipient in mail["allow"]


def _install_html(title, href, brand):
    """MAIL-IDENTITY: the install company's notice as HTML in its look (logo, else its name), for the bridge."""
    try:
        _, html_part, inline = notice_parts(
            title, _platform_mail()["origin"] + href, (brand or {}).get("name") or "", brand)
    except (OSError, ImportError, ValueError):
        return {"brand": brand} if brand else {}
    return {"html": html_part, "inline": inline, **({"fromName": brand["name"]} if brand and brand.get("name") else {})}


def send_mail(to, title, href, brand=None):
    mail = _platform_mail()
    sender = mail["sender"] or "pulse@mail.invalid"
    body = (
        title
        + "\nOpen Pulse: "
        + mail["origin"]
        + href
    )
    if (
        os.environ.get("PULSE_CI") == "1"
        or os.environ.get("PULSE_NOTIFICATION_MODE") == "sink"
        or os.environ.get("PULSE_AUTH_MAIL_MODE") == "sink"
    ):
        test_sink.append(
            {"channel": "email", "from": sender, "to": to, "title": title, "body": body}
        )
        return "sink"
    if os.environ.get("PULSE_GMAIL_SEND_ENABLED") != "1" or not to:
        return "disabled"
    if not mail["sender"]:
        return "disabled"
    if not mail_recipient_allowed(to):
        return "disabled"
    script = _mail_bridge_path()
    if os.environ.get("PULSE_MAIL_TRANSPORT", "google").strip().lower() == "smtp":
        default_python = "python3"
    else:
        default_python = str(Path.home() / "ea-intel/.venv/bin/python")
    python = os.environ.get("PULSE_GOOGLE_PYTHON", default_python)
    result = subprocess.run(
        [python, str(script), "send"],
        input=json.dumps({"subject": sender, "from": sender, "to": to, "title": title,
                          "body": body, **_install_html(title, href, brand)}),
        text=True,
        capture_output=True,
        timeout=25,
    )
    return "sent" if result.returncode == 0 else "failed"


# MAILBOX (owner, 28 Oct 2026): another company on the platform sends its HR mail from its own Google Workspace mailbox,
# connected by its admin in Settings -> Mail (services/api/src/mailbox.ts, migration 1370). The refresh token arrives
# sealed (document keyring, bound to the company); it is opened here only to get a one-hour access token, and neither
# leaves this process. The OAuth client is the company's own (its folder of the secret store, google-mail.json) or the
# platform's (PULSE_MAIL_GOOGLE_CLIENT_ID + PULSE_MAIL_GOOGLE_CLIENT_SECRET or _FILE).
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send"
_mail_tokens = {}


class MailboxUnavailable(Exception):
    """A secret-free reason the company's mailbox cannot send now (shown to its admin in Settings -> Mail)."""


def _google_post(url, body, headers):
    """One HTTPS POST to Google: (status, JSON answer). Tests replace this; nothing else here touches the network."""
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as error:
        try:
            answer = json.loads(error.read() or b"{}")
        except ValueError:
            answer = {}
        return error.code, answer


def _mail_client(org, kind):
    if kind == "company":
        from pulse_sdk import connector
        try:
            value = json.loads(connector.company_secret(org, "google-mail").read_text(encoding="utf-8"))
        except (OSError, ValueError, UnicodeError, connector.SecretUnavailable):
            return None
        ok = isinstance(value, dict) and set(value) == {"client_id", "client_secret"}
        return (value["client_id"], value["client_secret"]) if ok else None
    client = os.environ.get("PULSE_MAIL_GOOGLE_CLIENT_ID", "").strip()
    secret = os.environ.get("PULSE_MAIL_GOOGLE_CLIENT_SECRET", "").strip()
    if not secret and os.environ.get("PULSE_MAIL_GOOGLE_CLIENT_SECRET_FILE"):
        try:
            secret = Path(os.environ["PULSE_MAIL_GOOGLE_CLIENT_SECRET_FILE"]).read_text(encoding="utf-8").strip()
        except OSError:
            secret = ""
    return (client, secret) if client and secret else None


def _mail_access_token(org, row):
    import hashlib
    import time
    from urllib.parse import urlencode

    from pulse_sdk import document_keys

    key = hashlib.sha256(bytes(row["token_sealed"])).hexdigest()
    hit = _mail_tokens.get(str(org))
    if hit and hit[0] == key and hit[2] > time.time() + 60:
        return hit[1]
    client = _mail_client(org, row["client"])
    if not client:
        raise MailboxUnavailable(
            "The Google sign-in this mailbox was connected with is not set up on this server: connect it again.")
    try:
        ring = document_keys.load_keyring()
        refresh = document_keys.open(ring, row["key_id"], bytes(row["token_wrapped"]), bytes(row["token_sealed"]),
                                     f"{org}/mailbox/google").decode("utf-8")
    except (document_keys.DocumentKeyError, UnicodeError):
        raise MailboxUnavailable("This server cannot open the mailbox's sealed sign-in (encryption key).") from None
    try:
        status, answer = _google_post(GOOGLE_TOKEN_URL, urlencode({
            "client_id": client[0], "client_secret": client[1], "refresh_token": refresh, "grant_type": "refresh_token",
        }).encode(), {"content-type": "application/x-www-form-urlencoded"})
    except (OSError, ValueError):
        raise MailboxUnavailable("Google did not answer. Pulse tries again in a minute.") from None
    if status != 200 or not isinstance(answer.get("access_token"), str):
        if answer.get("error") == "invalid_grant" or status == 401:
            raise MailboxUnavailable("Google no longer accepts Pulse for this mailbox: connect it again.")
        raise MailboxUnavailable(f"Google refused ({status}).")
    _mail_tokens[str(org)] = (key, answer["access_token"], time.time() + max(60, int(answer.get("expires_in") or 3600)))
    return answer["access_token"]


def _company_mailbox(c, org):
    """The company's own mailbox ready to send ({address, token, name, origin}), {"error": reason}, or None."""
    with tenant_tx(c, org):
        row = c.execute("select * from pulse.org_mailbox_sealed()").fetchone()
        if not row:
            return None
        about = c.execute(
            "select o.name,(select d.host from pulse.org_domain d where d.org_id=o.id"
            " order by d.is_primary desc,d.created_at limit 1) host from pulse.org o where o.id=pulse.current_org()"
        ).fetchone()
    try:
        token = _mail_access_token(org, row)
    except MailboxUnavailable as reason:
        return {"error": str(reason)}
    origin = f"https://{about['host']}" if about and about["host"] else _platform_mail()["origin"]
    return {"address": row["address"], "token": token, "name": about["name"] if about else None, "origin": origin}


def send_company_mail(mailbox, to, title, href, brand=None):
    """Send one notice from the company's mailbox: "sent", "disabled" (this host may not mail them), "retry"
    (nothing was sent), "failed" or "uncertain"."""
    import email.headerregistry
    import email.message
    import email.policy

    recipient = str(to or "").strip().lower()
    if not recipient:
        return "disabled"
    if not mail_recipient_allowed(recipient):
        return "disabled"
    msg = email.message.EmailMessage(policy=email.policy.SMTP)
    msg["From"] = email.headerregistry.Address(display_name=(mailbox["name"] or "")[:80], addr_spec=mailbox["address"])
    msg["To"] = recipient
    msg["Subject"] = title
    text, html_part, inline = notice_parts(title, mailbox["origin"].rstrip("/") + href, mailbox["name"] or "", brand)
    msg.set_content(text)
    msg.add_alternative(html_part, subtype="html")
    for image in inline:
        msg.get_payload()[1].add_related(base64.b64decode(image["png"]), maintype="image", subtype="png",
                                         cid="<" + image["cid"] + ">")
    raw = base64.urlsafe_b64encode(msg.as_bytes()).decode().rstrip("=")
    try:
        status, _ = _google_post(GMAIL_SEND_URL, json.dumps({"raw": raw}).encode(),
                                 {"authorization": "Bearer " + mailbox["token"], "content-type": "application/json"})
    except (OSError, ValueError):
        return "uncertain"
    if status == 401:
        _mail_tokens.clear()
        return "retry"  # the access token was refused before anything was sent
    return {"accepted": "sent"}.get(_outcome(status), _outcome(status))


def _outcome(status):
    if 200 <= status < 300:
        return "accepted"
    if status in (404, 410):
        return "expired"
    if status in (429, 503):
        return "retry"
    return "uncertain" if status == 0 or status >= 500 else "failed"


# MAIL-IDENTITY (owner, 4 Nov 2026): HR, leave, payslip and approval notices are organisation mail. They carry the
# company's name and logo (the layout of tools/google-bridge.py, the same as the API's mail-template.ts) and a
# plain-text
# part, and go from the company's own sender:
#   the install's company (Estate Autopilots on this server)  -> its configured sender, PULSE_MAIL_FROM (the bridge)
#   another company with a connected mailbox (Settings -> Mail) -> that mailbox (send_company_mail)
#   another company without one, Resend set up (RESEND_API_KEY) -> the platform's address as "<Company> via Pulse",
#                                                                  Reply-To the company (pulse.org_mail_identity, 1530)
#   none of those                                               -> the mail waits for the mailbox, as before
DEFAULT_PLATFORM_SENDER = ("Pulse by Vitals", "no-reply@org-9912dc.example")
RESEND_URL = "https://api.resend.com/emails"
_EMAIL = re.compile(r"^[^\s@<>\",;]+@[^\s@<>\",;]+\.[^\s@<>\",;]+$")
_bridge_module = None


def _bridge():
    """tools/google-bridge.py as a module (its layout); it imports Google's libraries only when it sends."""
    global _bridge_module
    if _bridge_module is None:
        spec = importlib.util.spec_from_file_location("pulse_google_bridge", _mail_bridge_path())
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        _bridge_module = module
    return _bridge_module


def platform_sender(env=None):
    """PULSE_PLATFORM_MAIL_FROM (or the older RESEND_FROM) as (name, address),
    else "Pulse by Vitals" <no-reply@org-9912dc.example>."""
    env = os.environ if env is None else env
    for raw in (env.get("PULSE_PLATFORM_MAIL_FROM", ""), env.get("RESEND_FROM", "")):
        name, address = parseaddr(str(raw).replace("\r", " ").replace("\n", " ").strip())
        address = address.strip().lower()
        if _EMAIL.match(address):
            return (re.sub(r"[\"<>\\]", "", name).strip()[:80] or DEFAULT_PLATFORM_SENDER[0], address)
    return DEFAULT_PLATFORM_SENDER


def org_mail_route(own, mailbox, env=None):
    """Which sender a company's notices go from: "install", "mailbox", "resend" or "wait" (see above)."""
    env = os.environ if env is None else env
    if own:
        return "install"
    if mailbox:
        return "mailbox"
    return "resend" if env.get("RESEND_API_KEY", "").strip() else "wait"


def _org_identity(c, org):
    """The company's name, Reply-To and web address for mail from the platform's address (or None)."""
    with tenant_tx(c, org):
        row = c.execute("select pulse.org_mail_identity() m").fetchone()
        about = c.execute(
            "select (select d.host from pulse.org_domain d where d.org_id=o.id"
            " order by d.is_primary desc,d.created_at limit 1) host"
            " from pulse.org o where o.id=pulse.current_org()"
        ).fetchone()
    identity = (row or {}).get("m")
    if not identity:
        return None
    origin = f"https://{about['host']}" if about and about["host"] else _platform_mail()["origin"]
    return {"name": identity.get("name") or "Your company", "replyTo": identity.get("replyTo"), "origin": origin}


def notice_parts(title, url, name, brand):
    """The plain text and HTML of one notice: its title, a button to open it, the company's sign-off."""
    text = title + "\nOpen Pulse: " + url + ("\n\n" + name + " HR" if name else "")
    html_part = _bridge().branded_html(title, "Open Pulse: " + url, name or "Pulse",
                                       logo=bool(brand and brand.get("png")))
    inline = [{"cid": "org-logo", "png": brand["png"]}] if brand and brand.get("png") else []
    return text, html_part, inline


def resend_request(identity, to, title, href, brand, env=None):
    """The request Resend gets for one notice (kept apart so tests check it without sending)."""
    env = os.environ if env is None else env
    sender_name, sender = platform_sender(env)
    company = re.sub(r"[\r\n\"<>\\]", "", str(identity.get("name") or "")).strip()[:60] or "Your company"
    text, html_part, inline = notice_parts(title, identity["origin"].rstrip("/") + href, company, brand)
    reply = str(identity.get("replyTo") or "").strip().lower()
    payload = {"from": formataddr((f"{company} via Pulse", sender)), "to": [str(to).strip().lower()],
               "subject": str(title)[:300],
               "text": text, "html": html_part}
    if _EMAIL.match(reply):
        payload["reply_to"] = reply
    if inline:
        payload["attachments"] = [{"filename": "logo.png", "content": i["png"],
                                   "content_type": "image/png", "content_id": i["cid"]} for i in inline]
    headers = {"authorization": "Bearer " + env.get("RESEND_API_KEY", "").strip(), "content-type": "application/json"}
    return RESEND_URL, headers, payload, sender_name


def send_resend(identity, to, title, href, brand):
    """Send one notice from the platform's address for a company with no mailbox: "sent", "disabled" (this host may
    not mail them), "retry", "failed" or "uncertain". The key is never logged."""
    recipient = str(to or "").strip().lower()
    if not _EMAIL.match(recipient):
        return "disabled"
    if not mail_recipient_allowed(recipient):
        return "disabled"
    url, headers, payload, _ = resend_request(identity, recipient, title, href, brand)
    request = urllib.request.Request(url, data=json.dumps(payload).encode(), headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=20) as answer:
            status = answer.status
    except urllib.error.HTTPError as error:
        status = error.code
    except (OSError, ValueError):
        return "uncertain"
    return {"accepted": "sent"}.get(_outcome(status), _outcome(status))


def _drain_channel(c, org, channel):
    if c.info.transaction_status != TransactionStatus.IDLE:
        raise RuntimeError("Notification transport requires an idle database connection")
    result = {"sent": 0, "failed": 0, "disabled": 0, "sink": 0, "uncertain": 0}
    sink = os.environ.get("PULSE_CI") == "1" or os.environ.get("PULSE_NOTIFICATION_MODE") == "sink"
    if channel == "email" and os.environ.get("PULSE_AUTH_MAIL_MODE") == "sink":
        sink = True
    # ONBOARD-CHECKIN-TG: with the Vitals OS bot set up (vitals_bot.py), it sends the Telegram copies for every company,
    # one digest per person, so this one-message-per-notification sender steps aside (nobody gets both).
    if channel == "telegram" and not sink and _vitals_bot_token():
        result["vitals_bot"] = 1
        return result
    if channel == "telegram" and not sink and not os.environ.get("TELEGRAM_BOT_TOKEN"):
        result["disabled"] = 1
        return result
    # UX-TENANT (ADR-0032): this install's Telegram bot and mailbox speak for the install's own company only. Another
    # company on the platform sends mail from its own mailbox once its admin connects one (MAILBOX); until then its
    # mail waits ('waiting_mailbox') and goes out after it connects. Its Telegram jobs wait, as with no token.
    mailbox = None
    platform = None
    if not sink:
        with tenant_tx(c, org):
            own = c.execute("select pulse.install_org() = pulse.current_org() as own").fetchone()["own"]
        if not own and channel == "email":
            mailbox = _company_mailbox(c, org)
            # MAIL-IDENTITY: no mailbox connected, Resend set up: the platform's address as "<Company> via Pulse".
            if org_mail_route(own, mailbox) == "resend":
                platform = _org_identity(c, org)
            if (not mailbox and not platform) or (mailbox and mailbox.get("error")):
                with tenant_tx(c, org):
                    c.execute("update pulse.hr_mail_outbox set status='waiting_mailbox' where status='queued'")
                    if mailbox:
                        c.execute("select pulse.org_mailbox_report(false,%s)", (mailbox["error"],))
                result["waiting"] = 1
                return result
        elif not own:
            result["disabled"] = 1
            return result
    if (channel == "email" and not sink and (platform or not mailbox)
            and os.environ.get("PULSE_GMAIL_SEND_ENABLED") != "1"):
        with tenant_tx(c, org):
            c.execute("update pulse.hr_mail_outbox set status='disabled' where status='queued'")
        result["disabled"] = 1
        return result
    with tenant_tx(c, org):
        jobs = c.execute("select * from pulse.notification_outbox_claim(%s)", (channel,)).fetchall()
        # The organisation's logo heads each e-mail (LAYOUT-SWEEP); none set, plain text only.
        row = c.execute(
            "select o.name,b.logo_png from pulse.org o join pulse.org_brand b on b.org_id=o.id"
            " where o.id=pulse.current_org() and b.logo_png is not null"
        ).fetchone() if channel == "email" and jobs else None
        brand = {"name": row["name"], "png": base64.b64encode(row["logo_png"]).decode()} if row else None
    for job in jobs:
        with tenant_tx(c, org):
            payload = c.execute(
                "select pulse.notification_outbox_dispatch(%s,%s) payload", (job["id"], job["lease_token"])
            ).fetchone()["payload"]
        if not payload:
            continue
        outcome = "uncertain"
        mail_status = None
        # Network calls happen after the durable dispatch commit, without an open transaction.
        if channel == "telegram":
            try:
                chat = telegram("getChat", {"chat_id": payload["destination"]["chatId"]})
            except (RuntimeError, urllib.error.URLError, ValueError):
                outcome = "retry"  # No side-effecting request has been attempted.
            else:
                if chat.get("type") != "private":
                    outcome = "failed"
                else:
                    try:
                        telegram("sendMessage", {
                            "chat_id": payload["destination"]["chatId"],
                            "text": payload["title"] + "\nOpen Pulse: "
                            + _platform_mail()["origin"]
                            + payload["href"],
                        })
                        outcome = "accepted"
                    except urllib.error.HTTPError as error:
                        outcome = _outcome(error.code)
                    except (RuntimeError, urllib.error.URLError, ValueError):
                        outcome = "uncertain"
        else:
            try:
                if mailbox:
                    mail_status = send_company_mail(mailbox, payload["destination"].get("email"), payload["title"],
                                                    payload["href"], brand)
                elif platform:
                    mail_status = send_resend(platform, payload["destination"].get("email"), payload["title"],
                                              payload["href"], brand)
                else:
                    mail_status = send_mail(payload["destination"].get("email"), payload["title"], payload["href"],
                                            brand)
                if mail_status in ("sent", "sink"):
                    outcome = "accepted"
                elif (mailbox or platform) and mail_status in ("retry", "failed", "uncertain"):
                    outcome = mail_status
                else:
                    outcome = "failed" if mail_status == "disabled" else "uncertain"
            except (OSError, subprocess.TimeoutExpired):
                outcome = "uncertain"
        with tenant_tx(c, org):
            c.execute("select pulse.notification_outbox_finish(%s,%s,%s)", (job["id"], job["lease_token"], outcome))
            if channel == "email" and mail_status in ("sink", "disabled"):
                c.execute(
                    "update pulse.hr_mail_outbox set status=%s where notification_id=%s",
                    (mail_status, job["notification_id"]),
                )
        if channel == "email" and mail_status in ("sink", "disabled"):
            result[mail_status] += 1
        elif outcome == "accepted":
            result["sent"] += 1
        elif outcome == "uncertain":
            result["uncertain"] += 1
        else:
            result["failed"] += 1
    if mailbox and result["sent"]:
        with tenant_tx(c, org):
            c.execute("select pulse.org_mailbox_report(true)")
    return result


def drain(c, org):
    result = _drain_channel(c, org, "telegram")
    return {"sent": result["sent"], "failed": result["failed"] + result["uncertain"]}


def drain_mail(c, org):
    return _drain_channel(c, org, "email")


def main():
    results = []
    with connect("worker") as c:
        for org in active_orgs(c):
            with tenant_tx(c, org):
                ready = c.execute("select to_regprocedure('pulse.hr_flow_remind()') is not null ready").fetchone()[
                    "ready"
                ]
                presence_ready = c.execute(
                    "select to_regprocedure('pulse.companion_presence_tick(uuid)') is not null ready"
                ).fetchone()["ready"]
                if presence_ready:
                    c.execute("select pulse.companion_presence_tick(null)")
                # POLISH-2: a session still open after the shift is asked about, and closed for review next morning.
                forgotten = "select to_regprocedure('pulse.attendance_forgotten_tick(timestamptz)') is not null ready"
                if c.execute(forgotten).fetchone()["ready"]:
                    c.execute("select pulse.attendance_forgotten_tick()")
                if ready:
                    c.execute("select pulse.hr_flow_remind()")
                c.execute("select pulse.notification_reminder_tick()")
                # PRESENCE-ONBOARD: gentle profile reminders, only once HR has turned them on.
                onboarding = "select to_regprocedure('pulse.onboarding_tick(timestamptz)') is not null ready"
                if c.execute(onboarding).fetchone()["ready"]:
                    c.execute("select pulse.onboarding_tick()")
                # RT1: tasks due within a day tell the person doing them, once per due date.
                if c.execute("select to_regprocedure('pulse.task_due_tick()') is not null ready").fetchone()["ready"]:
                    c.execute("select pulse.task_due_tick()")
                # COMP-A: offers expire, accepted offers start on their day, probation reviews are due (the manager and
                # HR hear once), scheduled role changes apply and pay statuses follow the dates.
                if c.execute("select to_regprocedure('pulse.comp_tick()') is not null ready").fetchone()["ready"]:
                    c.execute("select pulse.comp_tick()")
                finance_ready = c.execute(
                    "select to_regprocedure('pulse.finance_desk_snapshot(timestamp with time zone)') is not null ready"
                ).fetchone()["ready"]
                if finance_ready:
                    from .finance_tick import tick
                    tick(c, org)
            results.append({
                "telegram": _drain_channel(c, org, "telegram"),
                **({"email": drain_mail(c, org)} if ready else {}),
            })
    print(json.dumps(results))


if __name__ == "__main__":
    main()


def _vitals_bot_token():
    """AGENT-CHANNELS: the Vitals OS bot's token from the environment or its key file (vitals_bot.token)."""
    from pulse_workers.vitals_bot import token
    return token()
