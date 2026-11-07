"""The Vitals OS Telegram bot (ONBOARD-CHECKIN-TG, 6 Nov 2026). One bot for the platform, short grouped updates.

    python -m pulse_workers.vitals_bot run      # long-poll Telegram, send digests, relay AI employee chats (a service)
    python -m pulse_workers.vitals_bot once     # one pass of the same (a timer, or a check)

Needs VITALS_TELEGRAM_BOT_TOKEN (and the worker database login, as notifications.py). Without the token it does nothing
and says so. Set-up and the BotFather steps: docs/ops/TELEGRAM-BOT.md.

What it does
* /start <code>: links this private chat to the person who made the code in Settings -> Notifications (or to their chat
  with one AI employee). Codes are one-time, 15 minutes; only their sha256 is stored (migration 1606).
* Digest, not a stream: the Telegram copies the notification policy lets through (0860: never FYI, muted kinds or over a
  kind's daily limit) wait and go out as ONE message per person every VITALS_TELEGRAM_DIGEST_MINUTES (default 30); an
  urgent one (a call, a pay run) goes at once. Each item says what kind of thing it is, never its content (the outbox's
  privacy rule: Telegram is outside Vitals), with buttons: Done (a task), Approve (an HR request), Snooze 1h, Open.
* AI employees: a chat attached to one forwards what the person writes into their direct chat with it, as them, and
  sends its replies back.
* Never a group: anything but a private chat is ignored. Nothing is sent in tests (PULSE_CI=1 or
  PULSE_NOTIFICATION_MODE=sink write to test_sink), and the token never reaches a log.
"""

import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

test_sink = []
API = "https://api.telegram.org"
MAX_ITEMS = 5  # items with their own buttons in one digest; the rest are counted
# AGENT-CHANNELS (1603): the token may live in a root-owned key file instead of the environment (the owner pastes the
# BotFather token there); a company's own bot has its own file. VITALS_TELEGRAM_API points the bot at a mock in tests.
KEY_FILE = "/etc/estate-autopilots/apps/telegram-vitals.key"
ORG_KEY_FILE = "/etc/estate-autopilots/apps/telegram-org-{org}.key"

# What each kind of update is called on Telegram (the titles stay in Vitals).
KINDS = [
    ("chat.call", "Incoming call"),
    ("chat.missed_call", "Missed call"),
    ("approval.", "Approval waiting for you"),
    ("leave.decision", "Your leave request was answered"),
    ("request.", "Your request moved on"),
    ("task.due", "Task due soon"),
    ("task.late", "Task is late"),
    ("task.assigned", "New task for you"),
    ("task.waiting", "A task is waiting on you"),
    ("task.review", "Work to review"),
    ("task.mention", "You were mentioned on a task"),
    ("task.ask", "Someone asked you for something"),
    ("task.", "Task update"),
    ("attendance.", "Check-in reminder"),
    ("chat.mention", "You were mentioned in a chat"),
    ("chat.reply", "Reply to you in a chat"),
    ("chat.", "New message"),
    ("client.", "Client update"),
    ("test", "Test notification"),
]


def sink_mode():
    return os.environ.get("PULSE_CI") == "1" or os.environ.get("PULSE_NOTIFICATION_MODE") == "sink"


def key_file_value(path, name):
    """NAME=value (or a bare token on its own line) from a key file; '' when missing or unreadable. Never logged."""
    try:
        text = Path(path).read_text()
    except OSError:
        return ""
    bare = ""
    for line in text.splitlines():
        t = line.strip()
        if not t or t.startswith("#"):
            continue
        m = re.fullmatch(r"(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)", t)
        if m:
            if m.group(1) == name:
                return m.group(2).strip().strip("'\"")
        elif not bare:
            bare = t
    return bare


def token(org=None):
    """The shared bot's token (env, else the key file), or a company's own bot's token (its own key file)."""
    if org:
        return key_file_value(os.environ.get("VITALS_TELEGRAM_ORG_KEY_FILE", ORG_KEY_FILE).format(org=org), "VITALS_TELEGRAM_BOT_TOKEN")
    return (os.environ.get("VITALS_TELEGRAM_BOT_TOKEN", "").strip()
            or key_file_value(os.environ.get("VITALS_TELEGRAM_KEY_FILE", KEY_FILE), "VITALS_TELEGRAM_BOT_TOKEN"))


_bot_token = {"org": None}


def call(method, payload, timeout=20):
    """One Bot API call. In tests it is recorded instead; errors never carry the token."""
    # In tests only a local mock of the Bot API may answer (VITALS_TELEGRAM_API=http://127.0.0.1:<port>); else the sink.
    if sink_mode() and not re.match(r"http://(127\.0\.0\.1|localhost)(:\d+)?(/|$)", os.environ.get("VITALS_TELEGRAM_API", "")):
        test_sink.append({"method": method, "payload": payload})
        return [] if method == "getUpdates" else {"ok": True}
    tok = token(_bot_token["org"])
    if not tok:
        raise RuntimeError("Vitals Telegram bot is not set up (VITALS_TELEGRAM_BOT_TOKEN)")
    base = os.environ.get("VITALS_TELEGRAM_API", "").strip().rstrip("/") or API
    req = urllib.request.Request(f"{base}/bot{tok}/{method}", data=json.dumps(payload).encode(),
                                 headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            result = json.loads(r.read())
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"Telegram answered {error.code} to {method}") from None
    except (urllib.error.URLError, OSError, ValueError):
        raise RuntimeError(f"Telegram did not answer {method}") from None
    if not result.get("ok"):
        raise RuntimeError(f"Telegram refused {method}")
    return result["result"]


def code_hash(text):
    """As the API's codeHash: upper case, spaces and dashes dropped, sha256 hex."""
    return hashlib.sha256(re.sub(r"[\s-]", "", str(text)).upper().encode()).hexdigest()


def kind_label(event_type):
    e = str(event_type or "")
    for prefix, label in KINDS:
        if e.startswith(prefix):
            return label
    return "Work update"


def actions_for(event_type):
    """Which buttons an item gets, besides Open: done (tasks), approve (approvals), snooze (anything not a call)."""
    e = str(event_type or "")
    if e in ("chat.call", "chat.missed_call"):
        return []
    if e.startswith("approval.waiting") or e == "approval.reminder":
        return ["approve", "snooze"]
    if e.startswith("task.") and e not in ("task.done", "task.accepted", "task.comment", "task.update"):
        return ["done", "snooze"]
    return ["snooze"]


BUTTON = {"done": "✅ Done", "approve": "👍 Approve", "snooze": "⏰ 1h"}


def digest(items, origin):
    """One message for one person: a heading with the count, one short line per kind, buttons for the first few items.
    `items` are outbox payloads ({id, eventType, priority, href}); returns (text, reply_markup)."""
    items = sorted(items, key=lambda i: (0 if i.get("priority") == "urgent" else 1 if i.get("priority") == "needs_you" else 2))
    groups = {}
    for i in items:
        groups.setdefault(kind_label(i.get("eventType")), []).append(i)
    n = len(items)
    head = "🔴 Needs you now" if any(i.get("priority") == "urgent" for i in items) else f"Vitals · {n} update{'s' if n != 1 else ''}"
    lines = [head]
    for label, rows in groups.items():
        lines.append(f"• {label}" + (f" ×{len(rows)}" if len(rows) > 1 else ""))
    rows = []
    for i, item in enumerate(items[:MAX_ITEMS], start=1):
        row = [{"text": f"{i}. {BUTTON[a]}", "callback_data": f"{a[0]}:{item['id']}"} for a in actions_for(item.get("eventType"))]
        row.append({"text": f"{i}. Open", "url": origin.rstrip("/") + str(item.get("href") or "/notifications")})
        rows.append(row)
    if n > MAX_ITEMS:
        lines.append(f"+{n - MAX_ITEMS} more in Vitals")
    rows.append([{"text": "Open Vitals", "url": origin.rstrip("/") + "/notifications"}])
    if n > 1:
        lines.append("Numbers on the buttons follow the order above.")
    return "\n".join(lines), {"inline_keyboard": rows}


VERB = {"d": "done", "a": "approve", "s": "snooze", "r": "read"}


def parse_callback(data):
    """'d:<uuid>' -> ('done', uuid); anything else -> None."""
    m = re.fullmatch(r"([dasr]):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})", str(data or ""))
    return (VERB[m.group(1)], m.group(2)) if m else None


def parse_start(text):
    """'/start ABCD234567' (or the code pasted alone) -> the code, else None."""
    t = str(text or "").strip()
    m = re.fullmatch(r"/start(?:@\w+)?\s+([A-Za-z0-9-]{8,16})", t) or re.fullmatch(r"([A-HJ-NP-Za-hj-np-z2-9]{10})", t)
    return m.group(1) if m else None


HELP = ("This is the Vitals OS bot. To link it, open Vitals → Settings → Notifications → Telegram and press Link "
        "Telegram; it opens this chat with a one-time code. Updates come as a short digest with buttons. "
        "To talk to an AI employee, open it in Vitals and press Connect Telegram, or send /agent <name> here once linked.")


def parse_agent(text):
    """'/agent' -> '' (list), '/agent Bharata' or '/agent@VitalsOSBot bharata' -> 'Bharata'; anything else -> None."""
    m = re.fullmatch(r"/agents?(?:@\w+)?(?:\s+(.{1,80}))?", str(text or "").strip(), flags=re.S)
    return None if not m else (m.group(1) or "").strip()


def agent_reply(result, listing=False):
    """What the bot answers to /agent (a list, or the switch's outcome from pulse.channel_agent_switch)."""
    if result is None:
        return "Link this chat first: Vitals → Settings → Notifications → Telegram, or Connect Telegram on an AI employee."
    if listing:
        names = ", ".join(a.get("name") or "" for a in result.get("agents") or []) or "no AI employees yet"
        cur = result.get("current")
        return (f"You are talking to {cur}. " if cur else "No AI employee is attached to this chat yet. ") + f"Switch with /agent <name>: {names}"
    if result.get("agent"):
        return f"Now talking to {result['agent']}. Write here; its replies come back here and stay in your chat with it in Vitals."
    return {"ambiguous": "More than one AI employee matches. Use its username.",
            "not_allowed": "You can't message that AI employee.",
            "not_linked": "Link this chat first in Vitals → Settings → Notifications → Telegram.",
            "no_name": "Send /agent <name>."}.get(result.get("error"), "No AI employee by that name. Send /agent to see the list.")


class Bot:
    """One bot process: the update offset is kept in a small state file (VITALS_TELEGRAM_STATE, default
    ~/.local/state/vitals-bot/state.json), the digest clock per company in memory."""

    def __init__(self, conn_factory=None, state_path=None, org=None):
        from pulse_sdk.db import active_orgs, connect, tenant_tx  # imported here so the pure helpers test without a DB
        self._connect = conn_factory or (lambda: connect("worker"))
        self._all_orgs = active_orgs
        self._tx = tenant_tx
        # AGENT-CHANNELS: one bot process per token. The shared Vitals OS bot serves every company that uses it; a
        # company's own bot (`run --org <id>`, its token in telegram-org-<id>.key) serves only that company.
        self.org = org
        _bot_token["org"] = org
        self.beat_at = 0.0
        self.username = None
        self._modes = (0.0, {})
        default = Path.home() / (f".local/state/vitals-bot/state-{org}.json" if org else ".local/state/vitals-bot/state.json")
        self.state_path = Path(state_path or os.environ.get("VITALS_TELEGRAM_STATE") or default)
        self.every = max(5, int(os.environ.get("VITALS_TELEGRAM_DIGEST_MINUTES", "30") or 30)) * 60
        self.last_digest = {}
        self.origin = os.environ.get("VITALS_PUBLIC_URL", "").strip() or os.environ.get("PULSE_PUBLIC_URL", "").strip() or "https://app.vitalsos.ai"

    def _orgs(self, c):
        """The companies this bot serves: its own company, or every company on the shared bot (checked once a minute;
        a database without 1603 yet counts every company as shared)."""
        orgs = list(self._all_orgs(c))
        if self.org:
            return [o for o in orgs if str(o) == str(self.org)]
        at, modes = self._modes
        if time.time() - at > 60:
            modes = {}
            for o in orgs:
                try:
                    with self._tx(c, o):
                        modes[str(o)] = c.execute("select pulse.agent_channel_telegram_mode() m").fetchone()["m"]
                except Exception:  # noqa: BLE001  (an older database: the shared bot serves everyone, as before)
                    modes[str(o)] = "shared"
            self._modes = (time.time(), modes)
        return [o for o in orgs if modes.get(str(o), "shared") != "own"]

    # -- state -------------------------------------------------------------------------------------------------------
    def offset(self):
        try:
            return int(json.loads(self.state_path.read_text()).get("offset", 0))
        except (OSError, ValueError):
            return 0

    def save_offset(self, value):
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.state_path.with_suffix(".tmp")
        tmp.write_text(json.dumps({"offset": value}))
        tmp.replace(self.state_path)

    # -- incoming ----------------------------------------------------------------------------------------------------
    def poll(self, c, wait=25):
        updates = call("getUpdates", {"offset": self.offset(), "timeout": wait, "allowed_updates": ["message", "callback_query"]},
                       timeout=wait + 10)
        for u in updates or []:
            try:
                self.handle(c, u)
            except Exception as error:  # one bad update never stops the bot; nothing personal is logged
                print(json.dumps({"vitals_bot": "update_failed", "error": type(error).__name__}), file=sys.stderr)
            self.save_offset(int(u["update_id"]) + 1)

    def handle(self, c, update):
        if "callback_query" in update:
            return self.on_button(c, update["callback_query"])
        msg = update.get("message") or {}
        chat = msg.get("chat") or {}
        if chat.get("type") != "private":
            return None
        chat_id = str(chat.get("id"))
        text = str(msg.get("text") or "")
        code = parse_start(text)
        if code:
            return self.link(c, chat_id, code, (msg.get("from") or {}).get("username"))
        want = parse_agent(text)
        if want is not None:
            return self.switch(c, chat_id, want)
        if text.startswith("/"):
            return call("sendMessage", {"chat_id": chat_id, "text": HELP})
        for org in self._orgs(c):
            with self._tx(c, org):
                sent = c.execute("select pulse.telegram_agent_inbound(%s,%s) r", (chat_id, text)).fetchone()["r"]
            if sent:
                return call("sendChatAction", {"chat_id": chat_id, "action": "typing"})
        return call("sendMessage", {"chat_id": chat_id, "text": HELP})

    def link(self, c, chat_id, code, username):
        h = code_hash(code)
        user = username if username and re.fullmatch(r"[A-Za-z0-9_]{3,40}", username) else None
        for org in self._orgs(c):
            with self._tx(c, org):
                r = c.execute("select pulse.telegram_link_redeem(%s,%s,%s) r", (h, chat_id, user)).fetchone()["r"]
            if not r:
                continue
            if r.get("error") == "expired":
                text = "That code has expired. Make a new one in Vitals → Settings → Notifications."
            elif r.get("error") == "chat_taken":
                text = "This Telegram is already linked to someone else in that company."
            elif r.get("error"):
                text = "That code can't be used."
            elif r.get("kind") == "agent":
                text = f"Linked. Write here to talk to {r.get('agent') or 'your AI employee'}; its replies come back here."
            else:
                text = (f"Linked, {r.get('name') or 'there'}. You'll get a short digest of what needs you, with buttons "
                        "to finish, approve or snooze. Change what pings you in Settings → Notifications.")
            return call("sendMessage", {"chat_id": chat_id, "text": text})
        return call("sendMessage", {"chat_id": chat_id, "text": "That code isn't known. Make a new one in Vitals → Settings → Notifications."})

    def switch(self, c, chat_id, want):
        """AGENT-CHANNELS: /agent lists the AI employees this chat's person can talk to; /agent <name> switches to one."""
        for org in self._orgs(c):
            with self._tx(c, org):
                if want:
                    r = c.execute("select pulse.channel_agent_switch('telegram',%s,%s) r", (chat_id, want)).fetchone()["r"]
                    if r and r.get("error") == "not_linked":
                        continue
                    return call("sendMessage", {"chat_id": chat_id, "text": agent_reply(r)})
                r = c.execute("select pulse.channel_agent_choices('telegram',%s) r", (chat_id,)).fetchone()["r"]
            if r is not None:
                return call("sendMessage", {"chat_id": chat_id, "text": agent_reply(r, listing=True)})
        return call("sendMessage", {"chat_id": chat_id, "text": agent_reply(None)})

    def heartbeat(self, c, now=None):
        """AGENT-CHANNELS: tells each company it serves that its bot runs (at most every 5 minutes), so Vitals stops
        showing "waiting for the bot token". The bot's username comes from getMe."""
        now = now or time.time()
        if now - self.beat_at < 300:
            return
        self.beat_at = now
        if self.username is None:
            try:
                me = call("getMe", {})
                self.username = str((me or {}).get("username") or "") if isinstance(me, dict) else ""
            except RuntimeError:
                self.username = ""
        for org in self._orgs(c):
            with self._tx(c, org):
                c.execute("select pulse.agent_channel_heartbeat('telegram',%s)", (self.username or "",))

    def on_button(self, c, q):
        parsed = parse_callback(q.get("data"))
        chat = (q.get("message") or {}).get("chat") or {}
        answer = "Open it in Vitals."
        if parsed and chat.get("type") == "private":
            verb, nid = parsed
            for org in self._orgs(c):
                with self._tx(c, org):
                    r = c.execute("select pulse.telegram_act(%s,%s,%s) r", (str(chat.get("id")), nid, verb)).fetchone()["r"]
                if r and (r.get("ok") or "no longer" not in str(r.get("message"))):
                    answer = r.get("message") or answer
                    break
        return call("answerCallbackQuery", {"callback_query_id": q.get("id"), "text": answer[:190]})

    # -- outgoing ----------------------------------------------------------------------------------------------------
    def send_digests(self, c, now=None):
        from psycopg.pq import TransactionStatus
        now = now or time.time()
        sent = 0
        for org in self._orgs(c):
            key = str(org)
            with self._tx(c, org):
                urgent = c.execute("select pulse.telegram_urgent_waiting() u").fetchone()["u"]
            if not urgent and now - self.last_digest.get(key, 0) < self.every:
                continue
            with self._tx(c, org):
                jobs = c.execute("select * from pulse.notification_outbox_claim('telegram')").fetchall()
            per_chat = {}
            for job in jobs:
                with self._tx(c, org):
                    payload = c.execute("select pulse.notification_outbox_dispatch(%s,%s) p", (job["id"], job["lease_token"])).fetchone()["p"]
                if payload:
                    per_chat.setdefault(payload["destination"]["chatId"], []).append((job, payload))
            assert c.info.transaction_status == TransactionStatus.IDLE
            for chat_id, pairs in per_chat.items():
                text, markup = digest([p for _, p in pairs], self.origin)
                try:
                    call("sendMessage", {"chat_id": chat_id, "text": text, "reply_markup": markup, "disable_web_page_preview": True})
                    outcome = "accepted"
                    sent += 1
                except RuntimeError as error:
                    outcome = "retry" if "did not answer" in str(error) or " 429 " in f" {error} " else "failed"
                with self._tx(c, org):
                    for job, _ in pairs:
                        c.execute("select pulse.notification_outbox_finish(%s,%s,%s)", (job["id"], job["lease_token"], outcome))
            self.last_digest[key] = now
        return sent

    def relay_agents(self, c):
        n = 0
        for org in self._orgs(c):
            with self._tx(c, org):
                rows = c.execute("select pulse.telegram_agent_outbound() r").fetchone()["r"] or []
            for row in rows:
                try:
                    call("sendMessage", {"chat_id": row["chatId"], "text": f"{row['agent']}: {row['body']}"[:4000]})
                    n += 1
                except RuntimeError:
                    pass  # the message stays in Vitals; Telegram is a copy
        return n

    def once(self, wait=0):
        with self._connect() as c:
            self.heartbeat(c)
            self.poll(c, wait=wait)
            return {"digests": self.send_digests(c), "relayed": self.relay_agents(c)}

    def run(self):
        with self._connect() as c:
            while True:
                try:
                    self.heartbeat(c)
                    self.poll(c, wait=25)
                    self.send_digests(c)
                    self.relay_agents(c)
                except RuntimeError as error:
                    print(json.dumps({"vitals_bot": "telegram", "error": str(error)}), file=sys.stderr)
                    time.sleep(10)


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    org = None
    if "--org" in argv:  # AGENT-CHANNELS: a company's own bot
        i = argv.index("--org")
        org = argv[i + 1] if i + 1 < len(argv) and re.fullmatch(r"[0-9a-f-]{36}", argv[i + 1]) else None
        argv = argv[:i] + argv[i + 2:]
        if not org:
            print(json.dumps({"vitals_bot": "disabled", "why": "--org needs a company id"}))
            return 2
    if not token(org) and not sink_mode():
        # Waiting for the owner's BotFather token (docs/ops/TELEGRAM-BOT.md); Vitals shows "waiting for the bot token".
        print(json.dumps({"vitals_bot": "waiting_for_token", "why": "no token in VITALS_TELEGRAM_BOT_TOKEN or the key file"}))
        return 0
    bot = Bot(org=org)
    if argv[:1] == ["run"]:
        bot.run()
    else:
        print(json.dumps(bot.once()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
