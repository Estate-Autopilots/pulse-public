"""AGENT-CHANNELS (6 Nov 2026): the WhatsApp side of an AI employee's channels, on Meta's official WhatsApp Cloud API only
(no WhatsApp Web automation, ever).

    python -m pulse_workers.agent_channels run    # a service: send the channel outbox every few seconds
    python -m pulse_workers.agent_channels once   # one pass

Incoming messages arrive at the API's signed webhook (/api/v0/channels/whatsapp/hook, services/api/src/agent-channels.ts)
and go into the person's direct chat with their AI employee. This worker is the only holder of the access token: it takes
the AI employee's replies (only inside WhatsApp's 24-hour reply window) and the bot's short answers from
pulse_priv.channel_outbox (migration 1685) and sends each with POST /<phone-number-id>/messages.

Credentials: VITALS_WHATSAPP_ACCOUNTS (a JSON list, one per company: org, phoneNumberId, accessToken, number) or one
account from VITALS_WHATSAPP_ORG / _PHONE_NUMBER_ID / _ACCESS_TOKEN / _NUMBER, in the environment or in
/etc/estate-autopilots/apps/whatsapp-cloud.key. Without them it does nothing and says it waits for the business number.
Tests: PULSE_CI=1 or PULSE_NOTIFICATION_MODE=sink records instead of sending, unless VITALS_WHATSAPP_GRAPH points at a
local mock (http://127.0.0.1:<port>). The token never reaches a log.
"""

import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

from pulse_workers.vitals_bot import key_file_value, sink_mode

GRAPH = "https://graph.facebook.com/v21.0"
KEY_FILE = "/etc/estate-autopilots/apps/whatsapp-cloud.key"
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
test_sink = []


def accounts(env=None):
    """The companies' WhatsApp Business numbers this worker sends for (incomplete ones are left out)."""
    env = os.environ if env is None else env
    path = env.get("VITALS_WHATSAPP_KEY_FILE", KEY_FILE)

    def get(name):
        return str(env.get(name) or key_file_value(path, name) or "").strip()

    raw = get("VITALS_WHATSAPP_ACCOUNTS")
    if raw:
        try:
            rows = json.loads(raw)
        except ValueError:
            rows = []
    else:
        rows = [{"org": get("VITALS_WHATSAPP_ORG"), "phoneNumberId": get("VITALS_WHATSAPP_PHONE_NUMBER_ID"),
                 "accessToken": get("VITALS_WHATSAPP_ACCESS_TOKEN"), "number": get("VITALS_WHATSAPP_NUMBER")}]
    out = []
    for r in rows if isinstance(rows, list) else []:
        if not isinstance(r, dict):
            continue
        org, pid, tok, num = (str(r.get(k) or "").strip() for k in ("org", "phoneNumberId", "accessToken", "number"))
        if UUID.match(org) and re.fullmatch(r"[0-9]{5,32}", pid) and len(tok) >= 20:
            out.append({"org": org, "phoneNumberId": pid, "accessToken": tok,
                        "number": num if re.fullmatch(r"[1-9][0-9]{6,15}", num) else ""})
    return out


def _graph():
    base = os.environ.get("VITALS_WHATSAPP_GRAPH", "").strip().rstrip("/")
    local = re.match(r"http://(127\.0\.0\.1|localhost)(:\d+)?(/|$)", base)
    if sink_mode() and not local:
        return None
    return base or GRAPH


def send_text(account, to, body):
    """One text message through the Cloud API; True when Meta accepted it. Errors never carry the token or the number."""
    payload = {"messaging_product": "whatsapp", "recipient_type": "individual", "to": to, "type": "text",
               "text": {"preview_url": False, "body": body[:4096]}}
    base = _graph()
    if base is None:
        test_sink.append({"to": to, "body": body})
        return True
    req = urllib.request.Request(f"{base}/{account['phoneNumberId']}/messages", data=json.dumps(payload).encode(),
                                 headers={"content-type": "application/json", "authorization": f"Bearer {account['accessToken']}"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            ok = bool((json.loads(r.read() or b"{}").get("messages") or [None])[0])
    except urllib.error.HTTPError as error:
        print(json.dumps({"agent_channels": "whatsapp_refused", "status": error.code}), file=sys.stderr)
        return False
    except (urllib.error.URLError, OSError, ValueError):
        print(json.dumps({"agent_channels": "whatsapp_unreachable"}), file=sys.stderr)
        return False
    return ok


class Sender:
    def __init__(self, conn_factory=None):
        from pulse_sdk.db import connect, tenant_tx  # imported here so the pure helpers test without a DB
        self._connect = conn_factory or (lambda: connect("worker"))
        self._tx = tenant_tx
        self.beat_at = 0.0

    def pass_once(self, c, now=None):
        now = now or time.time()
        sent = 0
        for acct in accounts():
            if now - self.beat_at > 300:
                with self._tx(c, acct["org"]):
                    c.execute("select pulse.agent_channel_heartbeat('whatsapp',%s)", (acct["number"],))
            with self._tx(c, acct["org"]):
                rows = c.execute("select pulse.whatsapp_outbound_claim(20) r").fetchone()["r"] or []
            for row in rows:
                ok = send_text(acct, row["to"], row["body"])
                sent += 1 if ok else 0
                with self._tx(c, acct["org"]):
                    c.execute("select pulse.channel_outbox_done(%s,%s)", (row["id"], ok))
        if now - self.beat_at > 300:
            self.beat_at = now
        return sent

    def once(self):
        with self._connect() as c:
            return {"sent": self.pass_once(c)}

    def run(self):
        with self._connect() as c:
            while True:
                try:
                    self.pass_once(c)
                except Exception as error:  # noqa: BLE001  (one bad pass never stops the sender; nothing personal is logged)
                    print(json.dumps({"agent_channels": "pass_failed", "error": type(error).__name__}), file=sys.stderr)
                    time.sleep(10)
                time.sleep(float(os.environ.get("VITALS_WHATSAPP_POLL", "3")))


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if not accounts() and not sink_mode():
        print(json.dumps({"agent_channels": "waiting_for_whatsapp", "why": "no WhatsApp Business number (VITALS_WHATSAPP_* or the key file)"}))
        return 0
    s = Sender()
    if argv[:1] == ["run"]:
        s.run()
    else:
        print(json.dumps(s.once()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
