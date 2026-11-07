"""The Vitals OS Telegram bot's pure parts: codes, buttons and the digest's shape (no network, no database)."""

import hashlib

from pulse_workers import notifications, vitals_bot


def test_code_hash_matches_the_api():
    # services/api/src/telegram-link.ts codeHash: upper case, spaces and dashes dropped, sha256 hex.
    assert vitals_bot.code_hash("abcd-23 4567") == hashlib.sha256(b"ABCD234567").hexdigest()


def test_parse_start_and_callbacks():
    assert vitals_bot.parse_start("/start ABCD234567") == "ABCD234567"
    assert vitals_bot.parse_start("/start@VitalsOSBot ABCD234567") == "ABCD234567"
    assert vitals_bot.parse_start("ABCD234567") == "ABCD234567"
    assert vitals_bot.parse_start("hello there") is None
    nid = "0f8f1c2e-1111-4222-8333-944455556666"
    assert vitals_bot.parse_callback(f"d:{nid}") == ("done", nid)
    assert vitals_bot.parse_callback(f"a:{nid}") == ("approve", nid)
    assert vitals_bot.parse_callback(f"x:{nid}") is None
    assert vitals_bot.parse_callback("d:not-a-uuid") is None


def test_digest_is_one_short_message_with_buttons_and_no_titles():
    items = [
        {"id": f"00000000-0000-4000-8000-00000000000{i}", "eventType": e, "priority": p, "href": f"/notifications?event={i}",
         "title": "Salary revision for Synthetic Person"}
        for i, (e, p) in enumerate([("task.due_soon", "needs_you"), ("task.due_soon", "needs_you"), ("approval.waiting", "needs_you"),
                                    ("chat.mention", "needs_you"), ("task.assigned", "needs_you"), ("attendance.start", "needs_you"),
                                    ("chat.call", "urgent")])
    ]
    text, markup = vitals_bot.digest(items, "https://app.example.test")
    lines = text.splitlines()
    assert lines[0] == "🔴 Needs you now"
    assert "• Task due soon ×2" in lines and "• Approval waiting for you" in lines
    assert "+2 more in Vitals" in lines
    assert "Salary" not in text  # what a notification is about never leaves Vitals
    rows = markup["inline_keyboard"]
    assert len(rows) == vitals_bot.MAX_ITEMS + 1
    assert rows[0][-1]["url"].startswith("https://app.example.test/notifications?event=")  # the urgent call first
    assert [b["text"] for b in rows[0]] == ["1. Open"]  # a call gets no Done / Snooze
    assert all(len(b.get("callback_data", "")) <= 64 for r in rows for b in r)
    assert rows[-1] == [{"text": "Open Vitals", "url": "https://app.example.test/notifications"}]


def test_actions_per_kind():
    assert vitals_bot.actions_for("task.due_soon") == ["done", "snooze"]
    assert vitals_bot.actions_for("approval.reminder") == ["approve", "snooze"]
    assert vitals_bot.actions_for("task.done") == ["snooze"]
    assert vitals_bot.actions_for("chat.missed_call") == []


def test_sink_mode_sends_nothing(monkeypatch):
    monkeypatch.setenv("PULSE_CI", "1")
    monkeypatch.delenv("VITALS_TELEGRAM_BOT_TOKEN", raising=False)
    vitals_bot.test_sink.clear()
    vitals_bot.call("sendMessage", {"chat_id": "123456789", "text": "x"})
    assert vitals_bot.test_sink == [{"method": "sendMessage", "payload": {"chat_id": "123456789", "text": "x"}}]


def test_disabled_without_token(monkeypatch, capsys, tmp_path):
    monkeypatch.delenv("PULSE_CI", raising=False)
    monkeypatch.delenv("PULSE_NOTIFICATION_MODE", raising=False)
    monkeypatch.delenv("VITALS_TELEGRAM_BOT_TOKEN", raising=False)
    monkeypatch.setenv("VITALS_TELEGRAM_KEY_FILE", str(tmp_path / "missing.key"))
    assert vitals_bot.main(["once"]) == 0
    assert "waiting_for_token" in capsys.readouterr().out


def test_old_drain_steps_aside_for_the_vitals_bot(monkeypatch):
    monkeypatch.delenv("PULSE_CI", raising=False)
    monkeypatch.delenv("PULSE_NOTIFICATION_MODE", raising=False)
    monkeypatch.setenv("VITALS_TELEGRAM_BOT_TOKEN", "synthetic")

    class Idle:
        class info:
            from psycopg.pq import TransactionStatus
            transaction_status = TransactionStatus.IDLE

    assert notifications._drain_channel(Idle(), "00000000-0000-4000-8000-000000000000", "telegram")["vitals_bot"] == 1
