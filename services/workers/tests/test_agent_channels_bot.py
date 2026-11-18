"""AGENT-CHANNELS: the Telegram bot's /agent switch and the WhatsApp sender against local mocks of the Telegram Bot API
and Meta's Graph API (127.0.0.1 only; nothing reaches Telegram or Meta). Synthetic data only."""

import json
import threading
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from pulse_workers import agent_channels, vitals_bot

ORG = "00000000-0000-4000-8000-0000000000a1"
TOKEN = "123456:SYNTHETIC-token-for-tests-only"


@pytest.fixture
def mock_api():
    """A local HTTP server that records every call and answers like Telegram / Graph."""
    seen = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802
            raw = self.rfile.read(int(self.headers.get("content-length") or 0)) or b"{}"
            body = (
                {"multipart": raw} if self.headers.get("content-type", "").startswith("multipart/") else json.loads(raw)
            )
            seen.append({"path": self.path, "auth": self.headers.get("authorization"), "body": body})
            if self.path.endswith("/getMe"):
                out = {"ok": True, "result": {"username": "SyntheticVitalsBot"}}
            elif self.path.endswith("/getUpdates"):
                out = {"ok": True, "result": []}
            elif self.path.endswith("/getFile"):
                out = {"ok": True, "result": {"file_id": body.get("file_id"), "file_path": "voice/file_7.oga"}}
            elif self.path.endswith("/messages"):
                out = {"messaging_product": "whatsapp", "messages": [{"id": "wamid.synthetic"}]}
            else:
                out = {"ok": True, "result": {"message_id": 1}}
            data = json.dumps(out).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):  # noqa: N802  (TG-VOICE: a file download, or a quotation's PDF from API v1)
            seen.append({"path": self.path, "auth": self.headers.get("authorization"), "body": None})
            data = b"OggS-synthetic-voice-note"
            if "/api/v1/billing/quotations/" in self.path:
                data = json.dumps(
                    {
                        "id": self.path.split("/")[-2],
                        "fileName": "draft-0000_TEST-Synthetic-Dairy.pdf",
                        "mime": "application/pdf",
                        "status": "draft",
                        "number": None,
                        "draft": True,
                        "buyer": "TEST Synthetic Dairy",
                        "total": 25000000,
                        "needsOwnerApproval": False,
                        "url": "https://vitals.test/erp/documents/x",
                        "size": 9,
                        "base64": "JVBERi1zeW50aA==",
                    }
                ).encode()
            self.send_response(200)
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *a):
            pass

    srv = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}", seen
    srv.shutdown()


class FakeConn:
    """Answers the bot's SQL calls like the database would (1603's functions), recording them."""

    def __init__(self, answers):
        self.answers, self.calls = answers, []

    def execute(self, sql, args=()):
        self.calls.append((sql, args))
        key = next((k for k in self.answers if k in sql), None)
        value = self.answers.get(key)

        class Cur:
            def fetchone(self_inner):
                return {
                    "r": value,
                    "m": value,
                    "u": value,
                    **(value if isinstance(value, dict) and "bytes" in value else {}),
                }

        return Cur()


def bot_for(conn):
    b = vitals_bot.Bot(conn_factory=lambda: conn, state_path="/tmp/vitals-bot-test-state.json")
    b._all_orgs = lambda c: [ORG]

    @contextmanager
    def tx(c, org):
        yield

    b._tx = tx
    return b


def test_key_file_token(tmp_path, monkeypatch):
    f = tmp_path / "telegram-vitals.key"
    f.write_text("# the owner's BotFather token\nVITALS_TELEGRAM_BOT_TOKEN='123:abc'\n")
    monkeypatch.delenv("VITALS_TELEGRAM_BOT_TOKEN", raising=False)
    monkeypatch.setenv("VITALS_TELEGRAM_KEY_FILE", str(f))
    assert vitals_bot.token() == "123:abc"
    f.write_text("456:bare-token\n")
    assert vitals_bot.token() == "456:bare-token"
    monkeypatch.setenv("VITALS_TELEGRAM_ORG_KEY_FILE", str(tmp_path / "org-{org}.key"))
    (tmp_path / f"org-{ORG}.key").write_text("VITALS_TELEGRAM_BOT_TOKEN=789:own\n")
    assert vitals_bot.token(ORG) == "789:own"


def test_parse_agent_and_replies():
    assert vitals_bot.parse_agent("/agent") == ""
    assert vitals_bot.parse_agent("/agent@VitalsOSBot Bharata") == "Bharata"
    assert vitals_bot.parse_agent("/agents") == ""
    assert vitals_bot.parse_agent("hello") is None
    assert vitals_bot.agent_reply({"agent": "Bharata"}).startswith("Now talking to Bharata.")
    assert "Link this chat first" in vitals_bot.agent_reply(None)
    assert (
        vitals_bot.agent_reply(
            {"current": "Bharata", "agents": [{"name": "Bharata"}, {"name": "Scribe"}]}, listing=True
        )
        == "You are talking to Bharata. Switch with /agent <name>: Bharata, Scribe"
    )


def test_agent_switch_through_the_mock_bot_api(mock_api, monkeypatch):
    base, seen = mock_api
    monkeypatch.setenv("PULSE_CI", "1")  # sink mode: only a 127.0.0.1 mock may answer
    monkeypatch.setenv("VITALS_TELEGRAM_API", base)
    monkeypatch.setenv("VITALS_TELEGRAM_BOT_TOKEN", TOKEN)
    conn = FakeConn(
        {
            "channel_agent_switch": {"agent": "Bharata Synthetic"},
            "channel_agent_choices": {"current": None, "agents": [{"name": "Bharata Synthetic"}]},
            "agent_channel_telegram_mode": "shared",
            "agent_channel_heartbeat": None,
        }
    )
    b = bot_for(conn)
    b.handle(
        conn,
        {
            "update_id": 1,
            "message": {
                "chat": {"id": 700000001, "type": "private"},
                "from": {"id": 700000001},
                "text": "/agent bharata",
            },
        },
    )
    b.handle(
        conn,
        {
            "update_id": 2,
            "message": {"chat": {"id": 700000001, "type": "private"}, "from": {"id": 700000001}, "text": "/agent"},
        },
    )
    b.handle(
        conn, {"update_id": 3, "message": {"chat": {"id": -100, "type": "group"}, "text": "/agent bharata"}}
    )  # never a group
    sends = [s for s in seen if s["path"].endswith("/sendMessage")]
    assert [s["body"]["text"].split(".")[0] for s in sends] == [
        "Now talking to Bharata Synthetic",
        "No AI employee is attached to this chat yet",
    ]
    assert all(s["path"].startswith(f"/bot{TOKEN}/") for s in seen)
    assert ("select pulse.channel_agent_switch('telegram',%s,%s) r", ("700000001", "bharata")) in conn.calls
    # The heartbeat tells Vitals the bot runs (getMe's username), so the "waiting for the token" state ends.
    b.heartbeat(conn, now=10_000)
    assert any(s["path"].endswith("/getMe") for s in seen)
    assert ("select pulse.agent_channel_heartbeat('telegram',%s)", ("SyntheticVitalsBot",)) in conn.calls


def test_a_real_address_is_never_called_in_tests(monkeypatch):
    monkeypatch.setenv("PULSE_CI", "1")
    monkeypatch.setenv("VITALS_TELEGRAM_API", "https://api.telegram.org")
    monkeypatch.setenv("VITALS_TELEGRAM_BOT_TOKEN", TOKEN)
    vitals_bot.test_sink.clear()
    vitals_bot.call("sendMessage", {"chat_id": "700000001", "text": "x"})
    assert vitals_bot.test_sink and vitals_bot.test_sink[0]["method"] == "sendMessage"
    monkeypatch.setenv("VITALS_WHATSAPP_GRAPH", "https://graph.facebook.com/v21.0")
    agent_channels.test_sink.clear()
    assert (
        agent_channels.send_text({"phoneNumberId": "100000000000001", "accessToken": "x" * 30}, "919000000123", "hi")
        is True
    )
    assert agent_channels.test_sink == [{"to": "919000000123", "body": "hi"}]


def test_whatsapp_accounts_need_every_credential(tmp_path):
    f = tmp_path / "whatsapp-cloud.key"
    f.write_text(f"VITALS_WHATSAPP_ORG={ORG}\nVITALS_WHATSAPP_PHONE_NUMBER_ID=100000000000001\n")
    assert agent_channels.accounts({"VITALS_WHATSAPP_KEY_FILE": str(f)}) == []
    f.write_text(
        f"VITALS_WHATSAPP_ORG={ORG}\nVITALS_WHATSAPP_PHONE_NUMBER_ID=100000000000001\n"
        f"VITALS_WHATSAPP_ACCESS_TOKEN={'s' * 40}\nVITALS_WHATSAPP_NUMBER=919000000123\n"
    )
    [a] = agent_channels.accounts({"VITALS_WHATSAPP_KEY_FILE": str(f)})
    assert a["org"] == ORG and a["number"] == "919000000123"


def test_whatsapp_sender_through_the_mock_graph_api(mock_api, monkeypatch, capsys):
    base, seen = mock_api
    monkeypatch.setenv("PULSE_CI", "1")
    monkeypatch.setenv("VITALS_WHATSAPP_GRAPH", base)
    monkeypatch.setenv(
        "VITALS_WHATSAPP_ACCOUNTS",
        json.dumps(
            [{"org": ORG, "phoneNumberId": "100000000000001", "accessToken": "s" * 40, "number": "919000000123"}]
        ),
    )
    outbox = [
        {
            "id": "00000000-0000-4000-8000-0000000000b1",
            "to": "919000000123",
            "body": "Bharata Synthetic: draft quote ready",
        }
    ]
    conn = FakeConn({"whatsapp_outbound_claim": outbox, "channel_outbox_done": None, "agent_channel_heartbeat": None})
    s = agent_channels.Sender(conn_factory=lambda: conn)

    @contextmanager
    def tx(c, org):
        yield

    s._tx = tx
    assert s.pass_once(conn, now=10_000) == 1
    [req] = [x for x in seen if x["path"].endswith("/messages")]
    assert req["path"] == "/100000000000001/messages" and req["auth"] == "Bearer " + "s" * 40
    assert req["body"] == {
        "messaging_product": "whatsapp",
        "recipient_type": "individual",
        "to": "919000000123",
        "type": "text",
        "text": {"preview_url": False, "body": "Bharata Synthetic: draft quote ready"},
    }
    assert ("select pulse.channel_outbox_done(%s,%s)", (outbox[0]["id"], True)) in conn.calls
    assert ("select pulse.agent_channel_heartbeat('whatsapp',%s)", ("919000000123",)) in conn.calls
    assert "s" * 40 not in capsys.readouterr().err  # the token never reaches a log


def test_sender_waits_for_the_business_number(monkeypatch, capsys, tmp_path):
    for k in ("PULSE_CI", "PULSE_NOTIFICATION_MODE", "VITALS_WHATSAPP_ACCOUNTS", "VITALS_WHATSAPP_ORG"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("VITALS_WHATSAPP_KEY_FILE", str(tmp_path / "missing.key"))
    assert agent_channels.main(["once"]) == 0
    assert "waiting_for_whatsapp" in capsys.readouterr().out


class StubEar:
    """Hears a fixed synthetic sentence (no model, no ffmpeg)."""

    def __init__(self):
        self.heard = []

    def transcribe(self, audio):
        self.heard.append(audio)
        return "Synthetic client wants a 5 kW rooftop quotation", "hi", 23.4


def test_voice_note_is_heard_and_handed_to_the_ai_employee(mock_api, monkeypatch):
    """TG-VOICE: a linked chat's voice note is downloaded from the (mock) Bot API, transcribed, shown back and sent into
    the person's chat with the AI employee; an unlinked chat downloads nothing; a too-long note is refused unheard."""
    base, seen = mock_api
    monkeypatch.setenv("PULSE_CI", "1")
    monkeypatch.setenv("VITALS_TELEGRAM_API", base)
    monkeypatch.setenv("VITALS_TELEGRAM_BOT_TOKEN", TOKEN)
    conn = FakeConn(
        {
            "channel_agent_choices": {"current": "Bharata Synthetic", "agents": []},
            "telegram_agent_inbound": {"agent": "Bharata Synthetic"},
            "agent_channel_telegram_mode": "shared",
        }
    )
    b = bot_for(conn)
    ear = StubEar()
    b.stt = ear
    voice = {
        "chat": {"id": 700000001, "type": "private"},
        "voice": {"file_id": "AwACAgSYNTHETIC", "duration": 23, "file_size": 40000, "mime_type": "audio/ogg"},
    }
    b.handle(conn, {"update_id": 1, "message": voice})
    assert ear.heard == [b"OggS-synthetic-voice-note"]
    assert any(s["path"] == f"/file/bot{TOKEN}/voice/file_7.oga" for s in seen)
    texts = [s["body"]["text"] for s in seen if s["path"].endswith("/sendMessage")]
    assert texts == ["🎙 Heard (Hindi, 0:23):\nSynthetic client wants a 5 kW rooftop quotation"]
    [(sql, args)] = [x for x in conn.calls if "telegram_agent_inbound" in x[0]]
    assert args[0] == "700000001" and args[1].startswith(
        "🎙 Voice note (Hindi, 0:23), transcribed:\nSynthetic client wants"
    )
    # An uploaded audio file counts too; an unlinked chat gets the help text and nothing is downloaded.
    assert (
        vitals_bot.audio_of(
            {"document": {"file_id": "x", "file_name": "call.ogg", "mime_type": "application/octet-stream"}}
        )["file_id"]
        == "x"
    )
    assert vitals_bot.audio_of({"text": "hello"}) is None
    seen.clear()
    stranger = FakeConn({"channel_agent_choices": None, "agent_channel_telegram_mode": "shared"})
    b2 = bot_for(stranger)
    b2.stt = StubEar()
    b2.handle(stranger, {"update_id": 2, "message": {**voice, "chat": {"id": 700000002, "type": "private"}}})
    assert not b2.stt.heard and not any("/file/" in s["path"] or s["path"].endswith("/getFile") for s in seen)
    assert [s["body"]["text"] for s in seen if s["path"].endswith("/sendMessage")] == [vitals_bot.HELP]
    seen.clear()
    b.handle(conn, {"update_id": 3, "message": {**voice, "voice": {**voice["voice"], "duration": 3600}}})
    assert not any(s["path"].endswith("/getFile") for s in seen)
    assert "too long" in [s["body"]["text"] for s in seen if s["path"].endswith("/sendMessage")][0]


ORG2 = "00000000-0000-4000-8000-0000000000a2"


class TwoCompanies:
    """A chat linked in two companies: each company answers for itself (the bot's tx says which one is current)."""

    def __init__(self, switch_hits):
        self.org, self.calls, self.switch_hits = None, [], switch_hits

    def execute(self, sql, args=()):
        self.calls.append((self.org, sql, args))
        org = self.org
        if "channel_agent_switch" in sql:
            value = {"agent": "Quotation Synthetic"} if org in self.switch_hits else {"error": "unknown"}
        elif "telegram_agent_inbound" in sql:
            value = {"agent": f"agent of {org}"}
        elif "channel_agent_choices" in sql:
            value = {"current": None, "agents": [{"name": f"agent of {org[-2:]}"}]}
        elif "telegram_agent_outbound" in sql:
            value = []
        else:
            value = "shared"

        class Cur:
            def fetchone(self_inner):
                return {"r": value, "m": value}

        return Cur()


def test_the_company_chosen_last_gets_the_next_message(mock_api, monkeypatch, tmp_path):
    """TG-VOICE: /agent <name> finds the AI employee in whichever company has it and moves the chat's next messages
    (typed or spoken) there; the list shows the AI employees of every company the chat is linked in."""
    base, seen = mock_api
    monkeypatch.setenv("PULSE_CI", "1")
    monkeypatch.setenv("VITALS_TELEGRAM_API", base)
    monkeypatch.setenv("VITALS_TELEGRAM_BOT_TOKEN", TOKEN)
    conn = TwoCompanies(switch_hits={ORG2})
    b = vitals_bot.Bot(conn_factory=lambda: conn, state_path=str(tmp_path / "state.json"))
    b._all_orgs = lambda c: [ORG, ORG2]

    @contextmanager
    def tx(c, org):
        c.org = org
        yield

    b._tx = tx
    chat = {"id": 700000003, "type": "private"}
    b.handle(conn, {"update_id": 1, "message": {"chat": chat, "text": "hello"}})
    assert [o for o, sql, _ in conn.calls if "telegram_agent_inbound" in sql] == [ORG]  # nothing chosen yet: the first
    b.handle(conn, {"update_id": 2, "message": {"chat": chat, "text": "/agent quotation"}})
    assert b.preferred("700000003") == ORG2
    conn.calls.clear()
    b.handle(conn, {"update_id": 3, "message": {"chat": chat, "text": "show my open quotes"}})
    assert [o for o, sql, _ in conn.calls if "telegram_agent_inbound" in sql] == [ORG2]
    b.save_offset(42)
    assert b.preferred("700000003") == ORG2 and b.offset() == 42  # the offset and the choice live side by side
    b.handle(conn, {"update_id": 4, "message": {"chat": chat, "text": "/agent"}})
    listing = [s["body"]["text"] for s in seen if s["path"].endswith("/sendMessage")][-1]
    assert "agent of a1" in listing and "agent of a2" in listing


def test_replies_waiting_go_out_before_the_next_message(mock_api, monkeypatch):
    """TG-VOICE: an answer the AI employee posted while the next voice note was being heard is relayed before that
    note goes in (the inbound moves the relay cursor to now, which used to skip it)."""
    base, seen = mock_api
    monkeypatch.setenv("PULSE_CI", "1")
    monkeypatch.setenv("VITALS_TELEGRAM_API", base)
    monkeypatch.setenv("VITALS_TELEGRAM_BOT_TOKEN", TOKEN)
    conn = FakeConn(
        {
            "channel_agent_choices": {"current": "Bharata Synthetic", "agents": []},
            "telegram_agent_inbound": {"agent": "Bharata Synthetic"},
            "telegram_agent_outbound": [
                {"chatId": "700000001", "agent": "Bharata Synthetic", "body": "Draft quote ready"}
            ],
            "agent_channel_telegram_mode": "shared",
        }
    )
    b = bot_for(conn)
    b.stt = StubEar()
    b.handle(
        conn,
        {
            "update_id": 1,
            "message": {
                "chat": {"id": 700000001, "type": "private"},
                "voice": {"file_id": "AwACAgSYNTHETIC2", "duration": 9},
            },
        },
    )
    order = [sql.split("pulse.")[1].split("(")[0] for sql, _ in conn.calls if "telegram_agent_" in sql]
    assert order == ["telegram_agent_outbound", "telegram_agent_inbound"]
    assert any(
        s["body"] and s["body"].get("text") == "Bharata Synthetic: Draft quote ready"
        for s in seen
        if s["path"].endswith("/sendMessage")
    )


def test_a_linked_quotation_goes_out_as_its_pdf_with_buttons(mock_api, monkeypatch, tmp_path):
    """TG-VOICE: an AI employee's answer that links a quotation is followed by the quotation's PDF (sendDocument),
    fetched
    with that AI employee's own key, with a summary and Approve / Edit buttons for a draft."""
    base, seen = mock_api
    monkeypatch.setenv("PULSE_CI", "1")
    monkeypatch.setenv("VITALS_TELEGRAM_API", base)
    monkeypatch.setenv("VITALS_TELEGRAM_BOT_TOKEN", TOKEN)
    key = "pak_0a1b2c3d_" + "e" * 64
    (tmp_path / "quote.key").write_text(key + "\n")
    (tmp_path / "cfg.json").write_text(
        json.dumps({"pulse": base, "agents": [{"username": "quote.synthetic", "keyFile": str(tmp_path / "quote.key")}]})
    )
    monkeypatch.setenv("PULSE_COWORKER_CONFIG", str(tmp_path / "cfg.json"))
    doc = "00000000-0000-4000-8000-0000000000d1"
    conn = FakeConn(
        {
            "telegram_agent_outbound": [
                {
                    "chatId": "700000001",
                    "agent": "Quote Synthetic",
                    "body": f"Drafted it: https://vitals.test/erp/documents/{doc} (TEST - delete me)",
                }
            ],
            "channel_agent_choices": {
                "current": "Quote Synthetic",
                "agents": [{"name": "Quote Synthetic", "username": "quote.synthetic"}],
            },
            "agent_channel_telegram_mode": "shared",
        }
    )
    b = bot_for(conn)
    assert b.relay_agents(conn) == 1
    assert b.relay_agents(conn) == 1  # the answer links it again: no second PDF for the same state
    assert len([s for s in seen if s["path"].endswith("/sendDocument")]) == 1
    [get, _again] = [s for s in seen if s["path"] == f"/api/v1/billing/quotations/{doc}/pdf"]
    assert get["auth"] == f"Bearer {key}"
    [up] = [s for s in seen if s["path"].endswith("/sendDocument")]
    raw = up["body"]["multipart"]
    assert b"%PDF-synth" in raw and b"DRAFT quotation (preview)" in raw and "₹2,50,000".encode() in raw
    assert (
        "✅ Approve".encode() in raw
        and "✏️ Edit".encode() in raw
        and f"https://vitals.test/erp/documents/{doc}".encode() in raw
    )
    caption, markup = vitals_bot.quote_card(
        {"status": "issued", "number": "Q-0007", "buyer": "X", "total": 100}, "https://v/x"
    )
    assert caption.startswith("Quotation Q-0007") and [b["text"] for b in markup["inline_keyboard"][0]] == [
        "📤 Send",
        "✏️ Edit (revise)",
    ]
    assert [b["url"] for b in markup["inline_keyboard"][0]] == [
        "https://v/x?do=send",
        "https://v/x",
    ]  # WL-QUOTE-LIVE: Send opens at that step
    caption, markup = vitals_bot.quote_card(
        {"status": "draft", "draft": True, "needsOwnerApproval": True, "total": 0}, "https://v/x"
    )
    assert (
        markup["inline_keyboard"][0][0]["text"] == "👑 Owner approves"
        and markup["inline_keyboard"][0][0]["url"] == "https://v/x?do=approve"
    )
    assert vitals_bot.quote_links("no link here") == [] and vitals_bot.rupees(12345678) == "₹1,23,456.78"


def test_a_company_runtime_beside_the_bots_own_gives_its_ai_employees_keys(mock_api, monkeypatch, tmp_path):
    """WL-E2E (7 Nov 2026): a company's AI employees run by their own runtime (wl.json beside prod.json, held to
    askOnly)
    still get their quotation PDF on Telegram: the bot finds their key in the config beside its own. A config for
    another Pulse address is never mixed in, and the bot's own entry wins a username both list."""
    base, seen = mock_api
    monkeypatch.setenv("PULSE_CI", "1")
    monkeypatch.setenv("VITALS_TELEGRAM_API", base)
    monkeypatch.setenv("VITALS_TELEGRAM_BOT_TOKEN", TOKEN)
    own, company, other = ("pak_0a1b2c3d_" + c * 64 for c in "abc")
    for name, key in (("own.key", own), ("company.key", company), ("other.key", other)):
        (tmp_path / name).write_text(key + "\n")
    (tmp_path / "prod.json").write_text(
        json.dumps({"pulse": base, "agents": [{"username": "shared.synthetic", "keyFile": str(tmp_path / "own.key")}]})
    )
    (tmp_path / "wl.json").write_text(
        json.dumps(
            {
                "pulse": base + "/",
                "askOnly": ["synthetic"],
                "agents": [
                    {"username": "bharata.synthetic", "keyFile": str(tmp_path / "company.key")},
                    {"username": "shared.synthetic", "keyFile": str(tmp_path / "company.key")},
                ],
            }
        )
    )
    (tmp_path / "dev.json").write_text(
        json.dumps(
            {
                "pulse": "http://127.0.0.1:1",
                "agents": [{"username": "dev.synthetic", "keyFile": str(tmp_path / "other.key")}],
            }
        )
    )
    (tmp_path / "notes.json").write_text("not json")
    monkeypatch.setenv("PULSE_COWORKER_CONFIG", str(tmp_path / "prod.json"))
    doc = "00000000-0000-4000-8000-0000000000d2"
    conn = FakeConn(
        {
            "telegram_agent_outbound": [
                {
                    "chatId": "700000001",
                    "agent": "Bharata Synthetic",
                    "body": f"Draft ready: https://vitals.test/erp/documents/{doc} (TEST - delete me)",
                }
            ],
            "channel_agent_choices": {
                "current": "Bharata Synthetic",
                "agents": [{"name": "Bharata Synthetic", "username": "bharata.synthetic"}],
            },
            "agent_channel_telegram_mode": "own",
        }
    )
    b = bot_for(conn)
    b.org = ORG  # the company's own bot, as Bharata's
    agents = {a["username"]: a["keyFile"] for a in b._runtime()["agents"]}
    assert agents == {"shared.synthetic": str(tmp_path / "own.key"), "bharata.synthetic": str(tmp_path / "company.key")}
    assert b.relay_agents(conn) == 1
    [get] = [s for s in seen if s["path"] == f"/api/v1/billing/quotations/{doc}/pdf"]
    assert get["auth"] == f"Bearer {company}"
    assert len([s for s in seen if s["path"].endswith("/sendDocument")]) == 1


def test_the_card_says_what_the_rounded_total_is_made_of():
    """WL-E2E: Billing rounds the total to the rupee, so ₹1 + 18% GST is ₹1.18 rounded to ₹1; the card says so instead
    of
    a bare "₹1" that reads as GST left out. Without the figures (an older API) it shows the total alone, as before."""
    caption, _ = vitals_bot.quote_card(
        {
            "status": "draft",
            "draft": True,
            "buyer": "TEST Synthetic",
            "taxable": 100,
            "tax": 18,
            "roundOff": -18,
            "total": 100,
        },
        "https://v/x",
    )
    assert "For TEST Synthetic · ₹1\n₹1 + GST ₹0.18 = ₹1.18, rounded to the rupee (−₹0.18)" in caption
    caption, _ = vitals_bot.quote_card(
        {"status": "draft", "draft": True, "taxable": 1600, "tax": 288, "roundOff": 12, "total": 1900}, "https://v/x"
    )
    assert "₹16 + GST ₹2.88 = ₹18.88, rounded to the rupee (+₹0.12)" in caption
    caption, _ = vitals_bot.quote_card(
        {"status": "issued", "number": "Q-1", "taxable": 10000000, "tax": 1800000, "roundOff": 0, "total": 11800000},
        "https://v/x",
    )
    assert "₹1,00,000 + GST ₹18,000\nApproved: ready to send" in caption and "rounded" not in caption
    caption, _ = vitals_bot.quote_card({"status": "draft", "draft": True, "total": 100}, "https://v/x")
    assert caption == "DRAFT quotation (preview)\nFor the client · ₹1\nDraft: not approved yet"


def test_files_both_ways(mock_api, monkeypatch):
    """TG-VOICE: a photo from Telegram goes into the AI employee's chat as the person's attachment; the AI employee's
    image comes back as a photo, its PDF as a file, and its links as buttons."""
    base, seen = mock_api
    monkeypatch.setenv("PULSE_CI", "1")
    monkeypatch.setenv("VITALS_TELEGRAM_API", base)
    monkeypatch.setenv("VITALS_TELEGRAM_BOT_TOKEN", TOKEN)
    conn = FakeConn(
        {
            "channel_agent_choices": {"current": "Bharata Synthetic", "agents": []},
            "telegram_agent_inbound_file": {"agent": "Bharata Synthetic"},
            "telegram_agent_outbound": [],
            "agent_channel_telegram_mode": "shared",
        }
    )
    b = bot_for(conn)
    photo = {
        "chat": {"id": 700000001, "type": "private"},
        "caption": "TEST site photo",
        "photo": [{"file_id": "small", "file_size": 900}, {"file_id": "big", "file_size": 90000}],
    }
    b.handle(conn, {"update_id": 1, "message": photo})
    assert any(s["path"].endswith("/getFile") and s["body"]["file_id"] == "big" for s in seen)
    [(sql, args)] = [x for x in conn.calls if "telegram_agent_inbound_file" in x[0]]
    assert (
        args[0] == "700000001"
        and args[1].startswith("photo-")
        and args[2] == "image/jpeg"
        and args[3] == b"OggS-synthetic-voice-note"
        and args[4] == "TEST site photo"
    )
    big = {**photo, "photo": [{"file_id": "huge", "file_size": 6 * 1024 * 1024}]}
    seen.clear()
    b.handle(conn, {"update_id": 2, "message": big})
    assert not any(s["path"].endswith("/getFile") for s in seen) and "over 5 MB" in seen[-1]["body"]["text"]
    seen.clear()
    out = FakeConn(
        {
            "telegram_agent_outbound": [
                {
                    "chatId": "700000001",
                    "agent": "Bharata Synthetic",
                    "body": "Here is the site plan.",
                    "files": [
                        {"id": "00000000-0000-4000-8000-0000000000f1", "name": "plan.png", "mime": "image/png"},
                        {"id": "00000000-0000-4000-8000-0000000000f2", "name": "plan.pdf", "mime": "application/pdf"},
                    ],
                    "links": [{"url": "https://vitals.test/tasks/x", "name": "Site visit task"}],
                }
            ],
            "telegram_agent_file": {"name": "plan.png", "mime": "image/png", "bytes": b"\x89PNG-synthetic"},
            "agent_channel_telegram_mode": "shared",
        }
    )
    b2 = bot_for(out)
    assert b2.relay_agents(out) == 1
    [msg] = [s for s in seen if s["path"].endswith("/sendMessage")]
    assert msg["body"]["reply_markup"] == {
        "inline_keyboard": [[{"text": "Site visit task", "url": "https://vitals.test/tasks/x"}]]
    }
    ups = [s["path"].rsplit("/", 1)[1] for s in seen if "multipart" in (s["body"] or {})]
    assert ups == ["sendPhoto", "sendPhoto"]  # the fake answers the PNG for both ids; a real PDF goes as sendDocument
    assert (
        vitals_bot.media_of(
            {"document": {"file_id": "d", "file_name": "quote.pdf", "mime_type": "application/pdf", "file_size": 10}}
        )["name"]
        == "quote.pdf"
    )
    assert vitals_bot.media_of({"text": "hi"}) is None
