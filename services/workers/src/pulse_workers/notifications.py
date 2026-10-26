"""Personal Telegram decision outbox. Sends generic decisions only to admin-verified private chats.

Source /etc/estate-autopilots/secrets/telegram.env into the worker environment when Telegram is configured, then run
python -m pulse_workers.notifications. Telegram is optional: without TELEGRAM_BOT_TOKEN the minute tick runs as usual
and the Telegram channel reports "disabled" (systemd units load the file with EnvironmentFile=-…, so a missing file
never stops the tick). Mail, finance, HR reasons and chat IDs never enter diagnostics.
No connection means no send; the shared operations chat is never a fallback.
"""

import base64
import json
import os
import subprocess
import urllib.error
import urllib.request
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



def send_mail(to, title, href, brand=None):
    sender = os.environ.get("PULSE_MAIL_FROM", "hr@estateautopilots.com").strip() or "hr@estateautopilots.com"
    body = (
        title
        + "\nOpen Pulse: "
        + os.environ.get("PULSE_PUBLIC_URL", "https://pulse-dev.estateautopilots.com").rstrip("/")
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
    try:
        host = (urlsplit(os.environ.get("PULSE_PUBLIC_URL", "")).hostname or "").lower()
    except ValueError:
        host = ""
    production_host = (os.environ.get("PULSE_MAIL_PRODUCTION_HOST", "pulse.estateautopilots.com").strip()
                       or "pulse.estateautopilots.com").lower()
    staging_allow = os.environ.get(
        "PULSE_MAIL_STAGING_ALLOW", "hr@estateautopilots.com,admin@estateautopilots.com"
    )
    allow = {address.strip().lower() for address in staging_allow.split(",") if address.strip()}
    if host != production_host and str(to).strip().lower() not in allow:
        return "disabled"
    script = _mail_bridge_path()
    if os.environ.get("PULSE_MAIL_TRANSPORT", "google").strip().lower() == "smtp":
        default_python = "python3"
    else:
        default_python = str(Path.home() / "ea-intel/.venv/bin/python")
    python = os.environ.get("PULSE_GOOGLE_PYTHON", default_python)
    result = subprocess.run(
        [python, str(script), "send"],
        input=json.dumps({"subject": sender, "from": sender, "to": to, "title": title, "body": body,
                          **({"brand": brand} if brand else {})}),
        text=True,
        capture_output=True,
        timeout=25,
    )
    return "sent" if result.returncode == 0 else "failed"


def _outcome(status):
    if 200 <= status < 300:
        return "accepted"
    if status in (404, 410):
        return "expired"
    if status in (429, 503):
        return "retry"
    return "uncertain" if status == 0 or status >= 500 else "failed"


def _drain_channel(c, org, channel):
    if c.info.transaction_status != TransactionStatus.IDLE:
        raise RuntimeError("Notification transport requires an idle database connection")
    result = {"sent": 0, "failed": 0, "disabled": 0, "sink": 0, "uncertain": 0}
    sink = os.environ.get("PULSE_CI") == "1" or os.environ.get("PULSE_NOTIFICATION_MODE") == "sink"
    if channel == "email" and os.environ.get("PULSE_AUTH_MAIL_MODE") == "sink":
        sink = True
    if channel == "telegram" and not sink and not os.environ.get("TELEGRAM_BOT_TOKEN"):
        result["disabled"] = 1
        return result
    # UX-TENANT (ADR-0032): this install's Telegram bot and mailbox speak for the install's own company only. Another
    # company on the platform gets them once it connects its own (R52); until then its jobs wait, as with no token.
    if not sink:
        with tenant_tx(c, org):
            own = c.execute("select pulse.install_org() = pulse.current_org() as own").fetchone()["own"]
            if not own and channel == "email":
                c.execute("update pulse.hr_mail_outbox set status='disabled' where status='queued'")
        if not own:
            result["disabled"] = 1
            return result
    if channel == "email" and not sink and os.environ.get("PULSE_GMAIL_SEND_ENABLED") != "1":
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
                            + os.environ.get("PULSE_PUBLIC_URL", "https://pulse.estateautopilots.com").rstrip("/")
                            + payload["href"],
                        })
                        outcome = "accepted"
                    except urllib.error.HTTPError as error:
                        outcome = _outcome(error.code)
                    except (RuntimeError, urllib.error.URLError, ValueError):
                        outcome = "uncertain"
        else:
            try:
                mail_status = send_mail(payload["destination"].get("email"), payload["title"], payload["href"], brand)
                if mail_status in ("sent", "sink"):
                    outcome = "accepted"
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
