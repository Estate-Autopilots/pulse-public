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
* Voice notes (TG-VOICE): a voice note, audio file or round video sent to a chat attached to an AI employee is
  downloaded, transcribed on this server (faster-whisper, VITALS_VOICE_MODEL, default "small"; the audio never leaves
  the server and is deleted at once), the transcript is shown back in Telegram ("Heard (Hindi, 0:23): ...") and goes
  into
  the person's chat with the AI employee as their message, so it acts on it as on anything typed.
* Never a group: anything but a private chat is ignored. Nothing is sent in tests (PULSE_CI=1 or
  PULSE_NOTIFICATION_MODE=sink write to test_sink), and the token never reaches a log.
"""

import base64
import gc
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
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
        return key_file_value(
            os.environ.get("VITALS_TELEGRAM_ORG_KEY_FILE", ORG_KEY_FILE).format(org=org), "VITALS_TELEGRAM_BOT_TOKEN"
        )
    return os.environ.get("VITALS_TELEGRAM_BOT_TOKEN", "").strip() or key_file_value(
        os.environ.get("VITALS_TELEGRAM_KEY_FILE", KEY_FILE), "VITALS_TELEGRAM_BOT_TOKEN"
    )


_bot_token = {"org": None}


def call(method, payload, timeout=20):
    """One Bot API call. In tests it is recorded instead; errors never carry the token."""
    # In tests only a local mock of the Bot API may answer (VITALS_TELEGRAM_API=http://127.0.0.1:<port>); else the sink.
    if sink_mode() and not re.match(
        r"http://(127\.0\.0\.1|localhost)(:\d+)?(/|$)", os.environ.get("VITALS_TELEGRAM_API", "")
    ):
        test_sink.append({"method": method, "payload": payload})
        return [] if method == "getUpdates" else {"ok": True}
    tok = token(_bot_token["org"])
    if not tok:
        raise RuntimeError("Vitals Telegram bot is not set up (VITALS_TELEGRAM_BOT_TOKEN)")
    base = os.environ.get("VITALS_TELEGRAM_API", "").strip().rstrip("/") or API
    req = urllib.request.Request(
        f"{base}/bot{tok}/{method}", data=json.dumps(payload).encode(), headers={"content-type": "application/json"}
    )
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


def download(file_path, timeout=60):
    """A file the person sent (getFile's file_path), as bytes. Same rules as call(): in tests only a local mock answers
    (else nothing is fetched), and errors never carry the token."""
    if sink_mode() and not re.match(
        r"http://(127\.0\.0\.1|localhost)(:\d+)?(/|$)", os.environ.get("VITALS_TELEGRAM_API", "")
    ):
        test_sink.append({"method": "download", "payload": {"file_path": file_path}})
        return b""
    tok = token(_bot_token["org"])
    if not tok:
        raise RuntimeError("Vitals Telegram bot is not set up (VITALS_TELEGRAM_BOT_TOKEN)")
    if not re.fullmatch(r"[A-Za-z0-9_./-]{1,200}", str(file_path or "")) or ".." in str(file_path):
        raise RuntimeError("Telegram gave an odd file path")
    base = os.environ.get("VITALS_TELEGRAM_API", "").strip().rstrip("/") or API
    try:
        with urllib.request.urlopen(f"{base}/file/bot{tok}/{file_path}", timeout=timeout) as r:
            return r.read(VOICE_MAX_BYTES + 1)[: VOICE_MAX_BYTES + 1]
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"Telegram answered {error.code} to a file download") from None
    except (urllib.error.URLError, OSError, ValueError):
        raise RuntimeError("Telegram did not answer a file download") from None


# ----------------------------------------------------------------------------------------------------- voice notes
# TG-VOICE (7 Nov 2026). Bot API downloads stop at 20 MB; a long recording is refused before it is fetched.
VOICE_MAX_BYTES = 20 * 1024 * 1024
VOICE_MAX_SECONDS = int(os.environ.get("VITALS_VOICE_MAX_SECONDS", "600") or 600)
# The languages people here speak. Whisper sometimes names Hindi speech Urdu (and writes it in Urdu script) or guesses a
# language nobody here uses; then the most likely of these is used instead.
VOICE_LANGS = [
    x for x in re.split(r"[,\s]+", os.environ.get("VITALS_VOICE_LANGS", "hi,mr,en,gu,pa,bn,ta,te,kn,ml")) if x
]
LANG_NAMES = {
    "hi": "Hindi",
    "mr": "Marathi",
    "en": "English",
    "gu": "Gujarati",
    "pa": "Pokazam",
    "bn": "Bengali",
    "ta": "Tamil",
    "te": "Telugu",
    "kn": "Kannada",
    "ml": "Malayalam",
    "ur": "Urdu",
}


def audio_of(msg):
    """What a message carries to be heard: {file_id, seconds, size}, or None (text, photos, stickers...)."""
    for kind in ("voice", "audio", "video_note"):
        a = msg.get(kind)
        if isinstance(a, dict) and a.get("file_id"):
            return {
                "file_id": a["file_id"],
                "seconds": int(a.get("duration") or 0),
                "size": int(a.get("file_size") or 0),
            }
    d = msg.get("document")
    if (
        isinstance(d, dict)
        and d.get("file_id")
        and (
            str(d.get("mime_type") or "").startswith("audio/")
            or re.search(r"\.(ogg|oga|opus|mp3|m4a|wav|aac|amr)$", str(d.get("file_name") or ""), re.I)
        )
    ):
        return {"file_id": d["file_id"], "seconds": 0, "size": int(d.get("file_size") or 0)}
    return None


CHAT_FILE_MAX = 5 * 1024 * 1024  # the Pulse chat's own limit per file (chat_file_add)


def media_of(msg):
    """A photo, file or video the person sent (not audio, which is heard): {file_id, name, mime, size}, or None."""
    photos = [p for p in (msg.get("photo") or []) if isinstance(p, dict) and p.get("file_id")]
    if photos:
        best = max(
            photos, key=lambda p: int(p.get("file_size") or 0) if int(p.get("file_size") or 0) <= CHAT_FILE_MAX else -1
        )
        return {
            "file_id": best["file_id"],
            "name": f"photo-{time.strftime('%Y%m%d-%H%M%S')}.jpg",
            "mime": "image/jpeg",
            "size": int(best.get("file_size") or 0),
        }
    for kind in ("document", "video", "animation"):
        d = msg.get(kind)
        if isinstance(d, dict) and d.get("file_id"):
            mime = str(d.get("mime_type") or "application/octet-stream")
            name = str(
                d.get("file_name") or f"{kind}-{time.strftime('%Y%m%d-%H%M%S')}{'.mp4' if kind != 'document' else ''}"
            )
            return {
                "file_id": d["file_id"],
                "name": name[:200],
                "mime": mime[:120],
                "size": int(d.get("file_size") or 0),
            }
    return None


def clock(seconds):
    s = int(round(seconds or 0))
    return f"{s // 60}:{s % 60:02d}"


class Whisper:
    """Speech to text on this server. The model loads on the first voice note and is let go after ten idle minutes."""

    IDLE = 600

    def __init__(self):
        self.model, self.used = None, 0.0

    def transcribe(self, audio: bytes):
        """(text, language code, seconds) for the audio; ('', '', 0) when nothing was said."""
        import numpy as np

        if self.model is None:
            from faster_whisper import WhisperModel

            self.model = WhisperModel(
                os.environ.get("VITALS_VOICE_MODEL", "small"),
                device="cpu",
                compute_type="int8",
                cpu_threads=int(os.environ.get("VITALS_VOICE_THREADS", "2") or 2),
            )
        self.used = time.monotonic()
        raw = subprocess.run(
            ["ffmpeg", "-v", "quiet", "-i", "pipe:0", "-ac", "1", "-ar", "16000", "-f", "f32le", "-"],
            input=audio,
            capture_output=True,
            check=False,
            timeout=120,
        ).stdout
        pcm = np.frombuffer(raw, dtype=np.float32)
        if not len(pcm):
            return "", "", 0
        segs, info = self.model.transcribe(pcm, beam_size=1, vad_filter=True, condition_on_previous_text=False)
        lang = info.language
        if VOICE_LANGS and lang not in VOICE_LANGS:
            probs = [(p, code) for code, p in (getattr(info, "all_language_probs", None) or []) if code in VOICE_LANGS]
            if probs:
                lang = max(probs)[1]
                segs, info = self.model.transcribe(
                    pcm, language=lang, beam_size=1, vad_filter=True, condition_on_previous_text=False
                )
        text = " ".join(s.text.strip() for s in segs if s.text.strip())
        self.used = time.monotonic()
        return text.strip(), lang, float(info.duration or len(pcm) / 16000)

    def rest(self):
        if self.model is not None and time.monotonic() - self.used > self.IDLE:
            self.model = None
            gc.collect()


# ------------------------------------------------------------------------------------------------- quotations
# TG-VOICE (7 Nov 2026): when an AI employee's answer links a quotation (.../erp/documents/<id>), the bot sends the
# quotation itself as a PDF (a draft is a preview marked DRAFT) with a short summary and buttons that open it in Vitals
# to
# approve, edit or send. Approving stays a person's click in Vitals (Pulse's rule: an AI member drafts and submits,
# never
# approves). The PDF comes from API v1 (getQuotationPdf) with the AI employee's own runtime key (PULSE_COWORKER_CONFIG
# lists them), so what it can fetch is exactly what the AI employee may read.
QUOTE_LINK = re.compile(
    r"(https?://[^\s<>()\"']+?/erp/documents/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))"
)
STATUS_LINE = {
    "draft": "Draft: not approved yet",
    "issued": "Approved: ready to send",
    "sent": "Sent to the client",
    "accepted": "Accepted by the client",
    "declined": "Declined by the client",
    "cancelled": "Cancelled",
}
LOCAL = re.compile(r"http://(127\.0\.0\.1|localhost)(:\d+)?(/|$)")


def quote_links(body):
    """The quotations an answer links, in order, at most three: [(url, id)]."""
    seen, out = set(), []
    for url, doc in QUOTE_LINK.findall(str(body or "")):
        if doc not in seen:
            seen.add(doc)
            out.append((url, doc))
    return out[:3]


def rupees(paise):
    whole, frac = divmod(int(paise or 0), 100)
    s = str(whole)
    if len(s) > 3:  # Indian grouping: 12,34,567
        head, tail = s[:-3], s[-3:]
        head = ",".join([head[max(0, i - 2) : i] for i in range(len(head), 0, -2)][::-1])
        s = f"{head},{tail}"
    return f"₹{s}" + (f".{frac:02d}" if frac else "")


def quote_card(q, url):
    """Caption and buttons for one quotation. The buttons follow where it stands: a draft is approved (by the owner when
    a
    price differs from the catalogue) or edited; an approved one is sent or revised; anything later is opened."""
    status = str(q.get("status") or "")
    head = "DRAFT quotation (preview)" if q.get("draft") else f"Quotation {q.get('number') or ''}".strip()
    lines = [head, f"For {q.get('buyer') or 'the client'} · {rupees(q.get('total'))}"]
    # WL-E2E (7 Nov 2026): the total is rounded to the rupee (Billing's "round the total"), so ₹1 + 18% GST showed as
    # "₹1"
    # and read as GST left out. With the API's taxable/tax/roundOff the card says what the total is made of.
    if isinstance(q.get("tax"), int) and isinstance(q.get("taxable"), int):
        part = f"{rupees(q['taxable'])} + GST {rupees(q['tax'])}"
        off = q.get("roundOff") if isinstance(q.get("roundOff"), int) else 0
        if off:
            part += (
                f" = {rupees(q['taxable'] + q['tax'])}, rounded to the rupee "
                f"({'+' if off > 0 else '−'}{rupees(abs(off))})"
            )
        lines.append(part)
    lines.append(STATUS_LINE.get(status, status))
    if q.get("needsOwnerApproval"):
        lines.append("A price differs from the catalogue, so the owner approves it.")
    # WL-QUOTE-LIVE (10 Nov 2026): Approve and Send open the quotation at that step (?do=approve shows the Approve
    # confirm
    # at once, ?do=send the e-mail composer): one more tap, as the person, in their own sign-in.
    if status == "draft":
        row = [
            {"text": "👑 Owner approves" if q.get("needsOwnerApproval") else "✅ Approve", "url": f"{url}?do=approve"},
            {"text": "✏️ Edit", "url": url},
        ]
    elif status == "issued":
        row = [{"text": "📤 Send", "url": f"{url}?do=send"}, {"text": "✏️ Edit (revise)", "url": url}]
    else:
        row = [{"text": "Open in Vitals", "url": url}]
    return "\n".join(lines)[:1000], {"inline_keyboard": [row]}


def runtimes_beside(path, cfg):
    """WL-E2E: the AI employees of the other runtime configs in the same folder that call the same Pulse address, after
    the bot's own (a username already listed keeps its first entry). Only names and key-file paths are taken."""
    base = str(cfg.get("pulse") or "").rstrip("/")
    known = {a.get("username") for a in cfg.get("agents") or [] if isinstance(a, dict)}
    out = []
    try:
        others = sorted(p for p in path.parent.glob("*.json") if p.resolve() != path.resolve())
    except OSError:
        return out
    for other in others:
        try:
            o = json.loads(other.read_text())
        except (OSError, ValueError):
            continue
        if not isinstance(o, dict) or not base or str(o.get("pulse") or "").rstrip("/") != base:
            continue
        for a in o.get("agents") or []:
            if isinstance(a, dict) and a.get("username") and a.get("keyFile") and a["username"] not in known:
                known.add(a["username"])
                out.append({"username": a["username"], "keyFile": a["keyFile"]})
    return out


def http_json(url, key, timeout=60):
    """GET an API v1 address on this server with an AI employee's key. Errors never carry the key."""
    if sink_mode() and not LOCAL.match(url):
        test_sink.append({"method": "GET", "payload": {"url": url}})
        raise RuntimeError("not fetched in tests")
    req = urllib.request.Request(url, headers={"authorization": f"Bearer {key}", "accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"Vitals answered {error.code} to the quotation file") from None
    except (urllib.error.URLError, OSError, ValueError):
        raise RuntimeError("Vitals did not answer the quotation file") from None


def send_document(
    chat_id, data, file_name, caption, markup, method="sendDocument", field="document", mime="application/pdf"
):
    """sendDocument / sendPhoto (a multipart upload): a file with its caption and buttons."""
    if sink_mode() and not LOCAL.match(os.environ.get("VITALS_TELEGRAM_API", "")):
        test_sink.append(
            {
                "method": method,
                "payload": {"chat_id": chat_id, "file_name": file_name, "caption": caption, "reply_markup": markup},
            }
        )
        return {"ok": True}
    tok = token(_bot_token["org"])
    if not tok:
        raise RuntimeError("Vitals Telegram bot is not set up (VITALS_TELEGRAM_BOT_TOKEN)")
    boundary = uuid.uuid4().hex
    parts = []
    for name, value in (
        ("chat_id", str(chat_id)),
        ("caption", caption),
        ("reply_markup", json.dumps(markup or {}, ensure_ascii=False)),
    ):
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
    safe = re.sub(r"[^A-Za-z0-9._-]+", "-", file_name or "quotation.pdf")[:120]
    mime = re.sub(r"[^A-Za-z0-9.+/-]+", "", mime or "") or "application/octet-stream"
    parts.append(
        (
            f'--{boundary}\r\nContent-Disposition: form-data; name="{field}"; filename="{safe}"\r\n'
            f"Content-Type: {mime}\r\n\r\n"
        ).encode()
        + data
        + b"\r\n"
    )
    parts.append(f"--{boundary}--\r\n".encode())
    base = os.environ.get("VITALS_TELEGRAM_API", "").strip().rstrip("/") or API
    req = urllib.request.Request(
        f"{base}/bot{tok}/{method}",
        data=b"".join(parts),
        headers={"content-type": f"multipart/form-data; boundary={boundary}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            result = json.loads(r.read())
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"Telegram answered {error.code} to {method}") from None
    except (urllib.error.URLError, OSError, ValueError):
        raise RuntimeError(f"Telegram did not answer {method}") from None
    if not result.get("ok"):
        raise RuntimeError(f"Telegram refused {method}")
    return result.get("result")


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
    items = sorted(
        items, key=lambda i: 0 if i.get("priority") == "urgent" else 1 if i.get("priority") == "needs_you" else 2
    )
    groups = {}
    for i in items:
        groups.setdefault(kind_label(i.get("eventType")), []).append(i)
    n = len(items)
    head = (
        "🔴 Needs you now"
        if any(i.get("priority") == "urgent" for i in items)
        else f"Vitals · {n} update{'s' if n != 1 else ''}"
    )
    lines = [head]
    for label, rows in groups.items():
        lines.append(f"• {label}" + (f" ×{len(rows)}" if len(rows) > 1 else ""))
    rows = []
    for i, item in enumerate(items[:MAX_ITEMS], start=1):
        row = [
            {"text": f"{i}. {BUTTON[a]}", "callback_data": f"{a[0]}:{item['id']}"}
            for a in actions_for(item.get("eventType"))
        ]
        row.append({"text": f"{i}. Open", "url": origin.rstrip("/") + str(item.get("href") or "/notifications")})
        rows.append(row)
    if n > MAX_ITEMS:
        lines.append(f"+{n - MAX_ITEMS} more in Vitals")
    rows.append([{"text": "Open Vitals", "url": origin.rstrip("/") + "/notifications"}])
    if n > 1:
        lines.append("Numbers on the buttons follow the order above.")
    return "\n".join(lines), {"inline_keyboard": rows}


VERB = {"d": "done", "a": "approve", "s": "snooze", "r": "read"}


def focus_text(row):
    """FOCUS: the plan's Telegram line, counts only."""
    placed, waiting, blocked = int(row.get("placed") or 0), int(row.get("waiting") or 0), int(row.get("blocked") or 0)
    parts = [f"{placed} to run now"]
    if waiting:
        parts.append(f"{waiting} waiting for room")
    if blocked:
        parts.append(f"{blocked} blocked")
    return "Your AI plan for today is ready: " + ", ".join(parts) + "."


def parse_callback(data):
    """'d:<uuid>' -> ('done', uuid); anything else -> None."""
    m = re.fullmatch(r"([dasr]):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})", str(data or ""))
    return (VERB[m.group(1)], m.group(2)) if m else None


def parse_start(text):
    """'/start ABCD234567' (or the code pasted alone) -> the code, else None."""
    t = str(text or "").strip()
    m = re.fullmatch(r"/start(?:@\w+)?\s+([A-Za-z0-9-]{8,16})", t) or re.fullmatch(r"([A-HJ-NP-Za-hj-np-z2-9]{10})", t)
    return m.group(1) if m else None


HELP = (
    "This is the Vitals OS bot. To link it, open Vitals → Settings → Notifications → Telegram and press Link "
    "Telegram; it opens this chat with a one-time code. Updates come as a short digest with buttons. "
    "To talk to an AI employee, open it in Vitals and press Connect Telegram, or send /agent <name> here once linked."
)


def parse_agent(text):
    """'/agent' -> '' (list), '/agent Bharata' or '/agent@VitalsOSBot bharata' -> 'Bharata'; anything else -> None."""
    m = re.fullmatch(r"/agents?(?:@\w+)?(?:\s+(.{1,80}))?", str(text or "").strip(), flags=re.S)
    return None if not m else (m.group(1) or "").strip()


def agent_reply(result, listing=False):
    """What the bot answers to /agent (a list, or the switch's outcome from pulse.channel_agent_switch)."""
    if result is None:
        return (
            "Link this chat first: Vitals → Settings → Notifications → Telegram, or Connect Telegram on an AI employee."
        )
    if listing:
        names = ", ".join(a.get("name") or "" for a in result.get("agents") or []) or "no AI employees yet"
        cur = result.get("current")
        return (
            f"You are talking to {cur}. " if cur else "No AI employee is attached to this chat yet. "
        ) + f"Switch with /agent <name>: {names}"
    if result.get("agent"):
        return (
            f"Now talking to {result['agent']}. Write here; its replies come back here and stay in your chat with it "
            "in Vitals."
        )
    return {
        "ambiguous": "More than one AI employee matches. Use its username.",
        "not_allowed": "You can't message that AI employee.",
        "not_linked": "Link this chat first in Vitals → Settings → Notifications → Telegram.",
        "no_name": "Send /agent <name>.",
    }.get(result.get("error"), "No AI employee by that name. Send /agent to see the list.")


class Bot:
    """One bot process: the update offset is kept in a small state file (VITALS_TELEGRAM_STATE, default
    ~/.local/state/vitals-bot/state.json), the digest clock per company in memory."""

    def __init__(self, conn_factory=None, state_path=None, org=None, stt=None):
        from pulse_sdk.db import active_orgs, connect, tenant_tx  # imported here so the pure helpers test without a DB

        self._connect = conn_factory or (lambda: connect("worker"))
        self._all_orgs = active_orgs
        self._tx = tenant_tx
        # AGENT-CHANNELS: one bot process per token. The shared Vitals OS bot serves every company that uses it; a
        # company's own bot (`run --org <id>`, its token in telegram-org-<id>.key) serves only that company.
        self.org = org
        _bot_token["org"] = org
        self.beat_at = 0.0
        self.stt = stt or Whisper()  # TG-VOICE
        self.username = None
        self._modes = (0.0, {})
        default = Path.home() / (
            f".local/state/vitals-bot/state-{org}.json" if org else ".local/state/vitals-bot/state.json"
        )
        self.state_path = Path(state_path or os.environ.get("VITALS_TELEGRAM_STATE") or default)
        self.every = max(5, int(os.environ.get("VITALS_TELEGRAM_DIGEST_MINUTES", "30") or 30)) * 60
        self.last_digest = {}
        self.origin = (
            os.environ.get("VITALS_PUBLIC_URL", "").strip()
            or os.environ.get("PULSE_PUBLIC_URL", "").strip()
            or "https://app.vitalsos.ai"
        )

    def help(self):
        """The help text, naming a company's own bot (e.g. Bharata) by its username instead of the shared bot."""
        name = str(self.username or "")
        if not self.org or not name:
            return HELP
        return HELP.replace("This is the Vitals OS bot.", f"This is @{name}, your company's bot on Vitals OS.")

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
    def _state(self):
        try:
            d = json.loads(self.state_path.read_text())
            return d if isinstance(d, dict) else {}
        except (OSError, ValueError):
            return {}

    def _save_state(self, d):
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.state_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(d))
        tmp.replace(self.state_path)

    def offset(self):
        try:
            return int(self._state().get("offset", 0))
        except (TypeError, ValueError):
            return 0

    def save_offset(self, value):
        self._save_state({**self._state(), "offset": value})

    # TG-VOICE: one person may link the same Telegram chat in several companies (the owner of several, a consultant).
    # The company they linked or switched to last is tried first, so their next message goes to the AI employee they
    # just chose, not to whichever company the database lists first. Kept beside the offset (chat id -> company id).
    def preferred(self, chat_id):
        return str((self._state().get("prefer") or {}).get(str(chat_id)) or "")

    def prefer(self, chat_id, org):
        d = self._state()
        d["prefer"] = {**(d.get("prefer") or {}), str(chat_id): str(org)}
        self._save_state(d)

    def _orgs_for(self, c, chat_id):
        orgs = list(self._orgs(c))
        first = self.preferred(chat_id)
        return sorted(orgs, key=lambda o: 0 if str(o) == first else 1)

    # -- incoming ----------------------------------------------------------------------------------------------------
    def poll(self, c, wait=25):
        updates = call(
            "getUpdates",
            {"offset": self.offset(), "timeout": wait, "allowed_updates": ["message", "callback_query"]},
            timeout=wait + 10,
        )
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
        audio = audio_of(msg)
        if audio:
            return self.voice(c, chat_id, audio, str(msg.get("caption") or "").strip())
        media = media_of(msg)
        if media:
            return self.file_in(c, chat_id, media, str(msg.get("caption") or "").strip())
        text = str(msg.get("text") or "")
        code = parse_start(text)
        if code:
            return self.link(c, chat_id, code, (msg.get("from") or {}).get("username"))
        want = parse_agent(text)
        if want is not None:
            return self.switch(c, chat_id, want)
        if text.startswith("/"):
            return call("sendMessage", {"chat_id": chat_id, "text": self.help()})
        self.relay_agents(c)  # TG-VOICE: replies already posted go out first (the inbound moves the relay cursor on)
        for org in self._orgs_for(c, chat_id):
            with self._tx(c, org):
                sent = c.execute("select pulse.telegram_agent_inbound(%s,%s) r", (chat_id, text)).fetchone()["r"]
            if sent:
                return call("sendChatAction", {"chat_id": chat_id, "action": "typing"})
        return call("sendMessage", {"chat_id": chat_id, "text": self.help()})

    def voice(self, c, chat_id, audio, caption=""):
        """TG-VOICE: hear a voice note from a linked chat and hand the transcript to its AI employee, as the person.
        A chat nobody linked gets the help text and nothing is downloaded."""
        linked = []
        for org in self._orgs_for(c, chat_id):
            with self._tx(c, org):
                if (
                    c.execute("select pulse.channel_agent_choices('telegram',%s) r", (chat_id,)).fetchone()["r"]
                    is not None
                ):
                    linked.append(org)
        if not linked:
            return call("sendMessage", {"chat_id": chat_id, "text": self.help()})
        if audio["seconds"] > VOICE_MAX_SECONDS or audio["size"] > VOICE_MAX_BYTES:
            return call(
                "sendMessage",
                {
                    "chat_id": chat_id,
                    "text": f"That recording is too long for me. Send a voice note under {VOICE_MAX_SECONDS // 60} "
                    "minutes, or type it.",
                },
            )
        call("sendChatAction", {"chat_id": chat_id, "action": "typing"})
        try:
            f = call("getFile", {"file_id": audio["file_id"]})
            data = download((f or {}).get("file_path") if isinstance(f, dict) else None)
            if len(data) > VOICE_MAX_BYTES:
                raise RuntimeError("too big")
            text, lang, seconds = self.stt.transcribe(data) if data else ("", "", 0)
        except Exception as error:  # noqa: BLE001  (a voice note that can't be heard is said so; nothing personal is logged)
            print(json.dumps({"vitals_bot": "voice_failed", "error": type(error).__name__}), file=sys.stderr)
            return call(
                "sendMessage",
                {
                    "chat_id": chat_id,
                    "text": "I couldn't listen to that voice note just now. Please try again in a minute, or type it.",
                },
            )
        finally:
            data = None
        if not text:
            return call(
                "sendMessage",
                {
                    "chat_id": chat_id,
                    "text": "I couldn't hear any words in that voice note. Try again closer to the phone, or type it.",
                },
            )
        name = LANG_NAMES.get(lang, lang or "speech")
        call("sendMessage", {"chat_id": chat_id, "text": f"🎙 Heard ({name}, {clock(seconds)}):\n{text}"[:4000]})
        body = f"🎙 Voice note ({name}, {clock(seconds)}), transcribed:\n{text}" + (
            f"\n\nNote with it: {caption}" if caption else ""
        )
        # The AI employee may have answered the previous note while this one was being heard: send that answer first,
        # since telegram_agent_inbound moves the relay cursor to now (the 7 Nov test lost the English note's reply).
        self.relay_agents(c)
        for org in linked:
            with self._tx(c, org):
                sent = c.execute("select pulse.telegram_agent_inbound(%s,%s) r", (chat_id, body[:4000])).fetchone()["r"]
            if sent:
                return call("sendChatAction", {"chat_id": chat_id, "action": "typing"})
        return call(
            "sendMessage",
            {
                "chat_id": chat_id,
                "text": "This chat isn't attached to an AI employee yet. Send /agent to choose one, then send the "
                "voice note again.",
            },
        )

    def file_in(self, c, chat_id, media, caption=""):
        """TG-VOICE: a photo, PDF or other file goes into the person's chat with the AI employee as their attachment,
        with
        the caption as the message. A chat nobody linked downloads nothing."""
        linked = []
        for org in self._orgs_for(c, chat_id):
            with self._tx(c, org):
                if (
                    c.execute("select pulse.channel_agent_choices('telegram',%s) r", (chat_id,)).fetchone()["r"]
                    is not None
                ):
                    linked.append(org)
        if not linked:
            return call("sendMessage", {"chat_id": chat_id, "text": self.help()})
        if media["size"] > CHAT_FILE_MAX:
            return call(
                "sendMessage",
                {
                    "chat_id": chat_id,
                    "text": "That file is over 5 MB, the chat's limit. Send a smaller one, or share a link to it.",
                },
            )
        try:
            f = call("getFile", {"file_id": media["file_id"]})
            data = download((f or {}).get("file_path") if isinstance(f, dict) else None)
            if not data or len(data) > CHAT_FILE_MAX:
                raise RuntimeError("empty or too big")
        except Exception as error:  # noqa: BLE001
            print(json.dumps({"vitals_bot": "file_failed", "error": type(error).__name__}), file=sys.stderr)
            return call(
                "sendMessage",
                {"chat_id": chat_id, "text": "I couldn't take that file just now. Please try again in a minute."},
            )
        self.relay_agents(c)
        for org in linked:
            with self._tx(c, org):
                sent = c.execute(
                    "select pulse.telegram_agent_inbound_file(%s,%s,%s,%s,%s) r",
                    (chat_id, media["name"], media["mime"], data, caption[:4000]),
                ).fetchone()["r"]
            if sent:
                return call("sendChatAction", {"chat_id": chat_id, "action": "typing"})
        return call(
            "sendMessage",
            {
                "chat_id": chat_id,
                "text": "This chat isn't attached to an AI employee yet. Send /agent to choose one, then send the file "
                "again.",
            },
        )

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
                self.prefer(chat_id, org)
                text = (
                    f"Linked. Write or send a voice note here to talk to {r.get('agent') or 'your AI employee'}; "
                    "its replies "
                    "come back here."
                )
            else:
                text = (
                    f"Linked, {r.get('name') or 'there'}. You'll get a short digest of what needs you, with buttons "
                    "to finish, approve or snooze. Change what pings you in Settings → Notifications."
                )
            return call("sendMessage", {"chat_id": chat_id, "text": text})
        return call(
            "sendMessage",
            {"chat_id": chat_id, "text": "That code isn't known. Make a new one in Vitals → Settings → Notifications."},
        )

    def switch(self, c, chat_id, want):
        """AGENT-CHANNELS: /agent lists the AI employees this chat's person can talk to; /agent <name> switches to one.
        TG-VOICE: with the chat linked in several companies, the name is looked for in each (the current company first)
        and the switch moves the chat's next messages to that company; the list shows every company's AI employees."""
        first = None
        listings = []
        for org in self._orgs_for(c, chat_id):
            with self._tx(c, org):
                if want:
                    r = c.execute("select pulse.channel_agent_switch('telegram',%s,%s) r", (chat_id, want)).fetchone()[
                        "r"
                    ]
                    if r and r.get("error") == "not_linked":
                        continue
                    if r and r.get("agent"):
                        self.prefer(chat_id, org)
                        return call("sendMessage", {"chat_id": chat_id, "text": agent_reply(r)})
                    first = first or r
                    continue
                r = c.execute("select pulse.channel_agent_choices('telegram',%s) r", (chat_id,)).fetchone()["r"]
            if r is not None:
                listings.append(r)
        if want and first is not None:
            return call("sendMessage", {"chat_id": chat_id, "text": agent_reply(first)})
        if listings:
            merged = {
                "current": listings[0].get("current"),
                "agents": [a for r in listings for a in (r.get("agents") or [])],
            }
            return call("sendMessage", {"chat_id": chat_id, "text": agent_reply(merged, listing=True)})
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
                    r = c.execute("select pulse.telegram_act(%s,%s,%s) r", (str(chat.get("id")), nid, verb)).fetchone()[
                        "r"
                    ]
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
                    payload = c.execute(
                        "select pulse.notification_outbox_dispatch(%s,%s) p", (job["id"], job["lease_token"])
                    ).fetchone()["p"]
                if payload:
                    per_chat.setdefault(payload["destination"]["chatId"], []).append((job, payload))
            assert c.info.transaction_status == TransactionStatus.IDLE
            for chat_id, pairs in per_chat.items():
                text, markup = digest([p for _, p in pairs], self.origin)
                try:
                    call(
                        "sendMessage",
                        {"chat_id": chat_id, "text": text, "reply_markup": markup, "disable_web_page_preview": True},
                    )
                    outcome = "accepted"
                    sent += 1
                except RuntimeError as error:
                    outcome = "retry" if "did not answer" in str(error) or " 429 " in f" {error} " else "failed"
                with self._tx(c, org):
                    for job, _ in pairs:
                        c.execute(
                            "select pulse.notification_outbox_finish(%s,%s,%s)",
                            (job["id"], job["lease_token"], outcome),
                        )
            self.last_digest[key] = now
        return sent

    def send_focus_plans(self, c):
        """FOCUS (1845): the day's AI plan, saved in an organisation with Focus, goes to each admin whose chat is
        linked: counts and a link only (the plan stays in Vitals). Unlinked, nothing is sent and the plan stays in
        Pulse."""
        n = 0
        for org in self._orgs(c):
            try:
                with self._tx(c, org):
                    rows = c.execute("select pulse.focus_plan_outbound() r").fetchone()["r"] or []
            except Exception:  # noqa: BLE001  (a database without 1845 yet)
                continue
            for row in rows:
                try:
                    button = {"text": "Open", "url": f"{self.origin}/focus"}
                    call(
                        "sendMessage",
                        {
                            "chat_id": row["chatId"],
                            "text": focus_text(row),
                            "disable_web_page_preview": True,
                            "reply_markup": {"inline_keyboard": [[button]]},
                        },
                    )
                    n += 1
                except RuntimeError:
                    pass  # the plan stays in Vitals; Telegram is a copy
        return n

    def relay_agents(self, c):
        n = 0
        for org in self._orgs(c):
            with self._tx(c, org):
                rows = c.execute("select pulse.telegram_agent_outbound() r").fetchone()["r"] or []
            for row in rows:
                links = [
                    {"text": str(x.get("name") or "Open")[:40], "url": x["url"]}
                    for x in row.get("links") or []
                    if re.match(r"https?://\S+$", str(x.get("url") or ""))
                ][:3]
                try:
                    if str(row.get("body") or "").strip() or links:
                        msg = {
                            "chat_id": row["chatId"],
                            "text": f"{row['agent']}: {row.get('body') or ''}".strip()[:4000],
                        }
                        if links:
                            msg["reply_markup"] = {"inline_keyboard": [[b] for b in links]}
                        call("sendMessage", msg)
                    n += 1
                except RuntimeError:
                    pass  # the message stays in Vitals; Telegram is a copy
                self.agent_files(c, org, row)
                self.quote_files(c, org, row)
        return n

    def agent_files(self, c, org, row):
        """TG-VOICE: the files the AI employee attached (an image goes as a photo, anything else as a file)."""
        sent = 0
        for f in (row.get("files") or [])[:5]:
            try:
                with self._tx(c, org):
                    got = c.execute(
                        "select name, mime, bytes from pulse.telegram_agent_file(%s,%s)",
                        (str(row["chatId"]), str(f.get("id"))),
                    ).fetchone()
                if not got or not got.get("bytes"):
                    continue
                data, mime = bytes(got["bytes"]), str(got.get("mime") or "")
                photo = mime in ("image/jpeg", "image/png", "image/webp") and len(data) <= 10 * 1024 * 1024
                caption = "" if str(row.get("body") or "").strip() else f"{row['agent']}"
                send_document(
                    row["chatId"],
                    data,
                    str(got.get("name") or "file"),
                    caption,
                    None,
                    method="sendPhoto" if photo else "sendDocument",
                    field="photo" if photo else "document",
                    mime=mime,
                )
                sent += 1
            except RuntimeError as error:
                print(json.dumps({"vitals_bot": "agent_file_failed", "error": str(error)[:120]}), file=sys.stderr)
        return sent

    # -- quotations (TG-VOICE)
    # ------------------------------------------------------------------------------------------
    def _runtime(self):
        """The AI runtime's config (its API address and each AI employee's key file), read at most once a minute.
        WL-E2E (7 Nov 2026): AI employees run by another runtime beside it (the same folder, the same Pulse address;
        e.g.
        a company's own runtime held to askOnly) are found too. Willow Lane's run from wl.json, so Bharata's bot (which
        reads prod.json) found no key for them and sent their quotations as text only, without the PDF and buttons."""
        at, cfg = getattr(self, "_cfg", (0.0, None))
        if time.time() - at > 60:
            path = os.environ.get("PULSE_COWORKER_CONFIG", "")
            try:
                cfg = json.loads(Path(path).read_text()) if path else None
            except (OSError, ValueError):
                cfg = None
            if isinstance(cfg, dict):
                cfg = {**cfg, "agents": list(cfg.get("agents") or []) + runtimes_beside(Path(path), cfg)}
            self._cfg = (time.time(), cfg)
        return cfg

    def agent_key(self, c, org, row):
        """(API address, the AI employee's own key) for the AI employee that wrote this row, or (None, None)."""
        cfg = self._runtime()
        if not cfg:
            return None, None
        with self._tx(c, org):
            choices = (
                c.execute("select pulse.channel_agent_choices('telegram',%s) r", (str(row["chatId"]),)).fetchone()["r"]
                or {}
            )
        names = [
            a.get("username")
            for a in choices.get("agents") or []
            if a.get("name") == row.get("agent") and a.get("username")
        ]
        entry = next((a for a in cfg.get("agents") or [] if names and a.get("username") == names[0]), None)
        if not entry:
            return None, None
        try:
            key = Path(entry["keyFile"]).read_text().strip()
        except (OSError, KeyError):
            return None, None
        return str(cfg.get("pulse") or "").rstrip("/"), key

    def quote_files(self, c, org, row):
        """Each quotation the answer links goes to the chat as its PDF with a summary and buttons."""
        links = quote_links(row.get("body"))
        if not links:
            return 0
        base, key = self.agent_key(c, org, row)
        if not key:
            return 0
        sent = 0
        sent_before = self.__dict__.setdefault("_quote_sent", {})
        for url, doc in links:
            try:
                q = http_json(f"{base}/api/v1/billing/quotations/{doc}/pdf", key)
                # The same quotation is linked by the "draft ready" note and again by the answer (BHARATA-CORE): one PDF
                # per quotation and state; a new state (approved, sent) or a changed total sends it again.
                mark = (str(q.get("status")), q.get("total"), q.get("number"))
                if sent_before.get((str(row["chatId"]), doc)) == mark:
                    continue
                caption, markup = quote_card(q, url)
                send_document(
                    row["chatId"],
                    base64.b64decode(q.get("base64") or ""),
                    q.get("fileName") or "quotation.pdf",
                    caption,
                    markup,
                )
                sent_before[(str(row["chatId"]), doc)] = mark
                sent += 1
            except (RuntimeError, ValueError) as error:
                print(json.dumps({"vitals_bot": "quote_file_failed", "error": str(error)[:120]}), file=sys.stderr)
        return sent

    def once(self, wait=0):
        with self._connect() as c:
            self.heartbeat(c)
            self.poll(c, wait=wait)
            return {"digests": self.send_digests(c), "relayed": self.relay_agents(c), "plans": self.send_focus_plans(c)}

    def run(self):
        with self._connect() as c:
            while True:
                try:
                    self.heartbeat(c)
                    self.poll(c, wait=25)
                    self.send_digests(c)
                    self.relay_agents(c)
                    self.send_focus_plans(c)
                    if hasattr(self.stt, "rest"):
                        self.stt.rest()
                except RuntimeError as error:
                    print(json.dumps({"vitals_bot": "telegram", "error": str(error)}), file=sys.stderr)
                    time.sleep(10)


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    org = None
    if "--org" in argv:  # AGENT-CHANNELS: a company's own bot
        i = argv.index("--org")
        org = argv[i + 1] if i + 1 < len(argv) and re.fullmatch(r"[0-9a-f-]{36}", argv[i + 1]) else None
        argv = argv[:i] + argv[i + 2 :]
        if not org:
            print(json.dumps({"vitals_bot": "disabled", "why": "--org needs a company id"}))
            return 2
    if not token(org) and not sink_mode():
        # Waiting for the owner's BotFather token (docs/ops/TELEGRAM-BOT.md); Vitals shows "waiting for the bot token".
        print(
            json.dumps(
                {"vitals_bot": "waiting_for_token", "why": "no token in VITALS_TELEGRAM_BOT_TOKEN or the key file"}
            )
        )
        return 0
    bot = Bot(org=org)
    if argv[:1] == ["run"]:
        bot.run()
    else:
        print(json.dumps(bot.once()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
