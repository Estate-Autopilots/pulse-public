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
            body = json.loads(self.rfile.read(int(self.headers.get("content-length") or 0)) or b"{}")
            seen.append({"path": self.path, "auth": self.headers.get("authorization"), "body": body})
            if self.path.endswith("/getMe"):
                out = {"ok": True, "result": {"username": "SyntheticVitalsBot"}}
            elif self.path.endswith("/getUpdates"):
                out = {"ok": True, "result": []}
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
                return {"r": value, "m": value, "u": value}

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
    assert vitals_bot.agent_reply({"current": "Bharata", "agents": [{"name": "Bharata"}, {"name": "Scribe"}]}, listing=True) == \
        "You are talking to Bharata. Switch with /agent <name>: Bharata, Scribe"


def test_agent_switch_through_the_mock_bot_api(mock_api, monkeypatch):
    base, seen = mock_api
    monkeypatch.setenv("PULSE_CI", "1")  # sink mode: only a 127.0.0.1 mock may answer
    monkeypatch.setenv("VITALS_TELEGRAM_API", base)
    monkeypatch.setenv("VITALS_TELEGRAM_BOT_TOKEN", TOKEN)
    conn = FakeConn({"channel_agent_switch": {"agent": "Bharata Synthetic"}, "channel_agent_choices": {"current": None, "agents": [{"name": "Bharata Synthetic"}]},
                     "agent_channel_telegram_mode": "shared", "agent_channel_heartbeat": None})
    b = bot_for(conn)
    b.handle(conn, {"update_id": 1, "message": {"chat": {"id": 700000001, "type": "private"}, "from": {"id": 700000001}, "text": "/agent bharata"}})
    b.handle(conn, {"update_id": 2, "message": {"chat": {"id": 700000001, "type": "private"}, "from": {"id": 700000001}, "text": "/agent"}})
    b.handle(conn, {"update_id": 3, "message": {"chat": {"id": -100, "type": "group"}, "text": "/agent bharata"}})  # never a group
    sends = [s for s in seen if s["path"].endswith("/sendMessage")]
    assert [s["body"]["text"].split(".")[0] for s in sends] == ["Now talking to Bharata Synthetic", "No AI employee is attached to this chat yet"]
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
    assert agent_channels.send_text({"phoneNumberId": "100000000000001", "accessToken": "x" * 30}, "919000000123", "hi") is True
    assert agent_channels.test_sink == [{"to": "919000000123", "body": "hi"}]


def test_whatsapp_accounts_need_every_credential(tmp_path):
    f = tmp_path / "whatsapp-cloud.key"
    f.write_text(f"VITALS_WHATSAPP_ORG={ORG}\nVITALS_WHATSAPP_PHONE_NUMBER_ID=100000000000001\n")
    assert agent_channels.accounts({"VITALS_WHATSAPP_KEY_FILE": str(f)}) == []
    f.write_text(f"VITALS_WHATSAPP_ORG={ORG}\nVITALS_WHATSAPP_PHONE_NUMBER_ID=100000000000001\nVITALS_WHATSAPP_ACCESS_TOKEN={'s' * 40}\nVITALS_WHATSAPP_NUMBER=919000000123\n")
    [a] = agent_channels.accounts({"VITALS_WHATSAPP_KEY_FILE": str(f)})
    assert a["org"] == ORG and a["number"] == "919000000123"


def test_whatsapp_sender_through_the_mock_graph_api(mock_api, monkeypatch, capsys):
    base, seen = mock_api
    monkeypatch.setenv("PULSE_CI", "1")
    monkeypatch.setenv("VITALS_WHATSAPP_GRAPH", base)
    monkeypatch.setenv("VITALS_WHATSAPP_ACCOUNTS", json.dumps([{"org": ORG, "phoneNumberId": "100000000000001", "accessToken": "s" * 40, "number": "919000000123"}]))
    outbox = [{"id": "00000000-0000-4000-8000-0000000000b1", "to": "919000000123", "body": "Bharata Synthetic: draft quote ready"}]
    conn = FakeConn({"whatsapp_outbound_claim": outbox, "channel_outbox_done": None, "agent_channel_heartbeat": None})
    s = agent_channels.Sender(conn_factory=lambda: conn)

    @contextmanager
    def tx(c, org):
        yield

    s._tx = tx
    assert s.pass_once(conn, now=10_000) == 1
    [req] = [x for x in seen if x["path"].endswith("/messages")]
    assert req["path"] == "/100000000000001/messages" and req["auth"] == "Bearer " + "s" * 40
    assert req["body"] == {"messaging_product": "whatsapp", "recipient_type": "individual", "to": "919000000123", "type": "text",
                           "text": {"preview_url": False, "body": "Bharata Synthetic: draft quote ready"}}
    assert ("select pulse.channel_outbox_done(%s,%s)", (outbox[0]["id"], True)) in conn.calls
    assert ("select pulse.agent_channel_heartbeat('whatsapp',%s)", ("919000000123",)) in conn.calls
    assert "s" * 40 not in capsys.readouterr().err  # the token never reaches a log


def test_sender_waits_for_the_business_number(monkeypatch, capsys, tmp_path):
    for k in ("PULSE_CI", "PULSE_NOTIFICATION_MODE", "VITALS_WHATSAPP_ACCOUNTS", "VITALS_WHATSAPP_ORG"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("VITALS_WHATSAPP_KEY_FILE", str(tmp_path / "missing.key"))
    assert agent_channels.main(["once"]) == 0
    assert "waiting_for_whatsapp" in capsys.readouterr().out
