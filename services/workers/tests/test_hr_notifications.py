"""Transport gates and privacy: sink tests never access network or credentials."""

import importlib.util
import io
import json
import sys
from pathlib import Path

import pytest

from pulse_workers import notifications


def test_hr_mail_and_personal_telegram_sink(monkeypatch):
    monkeypatch.setenv("PULSE_CI", "1")
    monkeypatch.setenv("PULSE_GMAIL_SEND_ENABLED", "1")
    monkeypatch.setenv("PULSE_PUBLIC_URL", "https://pulse.estateautopilots.com")
    monkeypatch.delenv("PULSE_MAIL_FROM", raising=False)
    notifications.test_sink.clear()
    assert (
        notifications.send_mail("synthetic@example.test", "HR request approved", "/me/approvals?request=synthetic")
        == "sink"
    )
    assert notifications.telegram("getChat", {"chat_id": "123456789"}) == {"type": "private"}
    notifications.telegram("sendMessage", {"chat_id": "123456789", "text": "HR request approved"})
    assert notifications.test_sink[0]["from"] == "hr@estateautopilots.com"
    assert "https://pulse.estateautopilots.com/me/approvals" in notifications.test_sink[0]["body"]
    assert notifications.test_sink[-1]["channel"] == "telegram"


@pytest.mark.parametrize(
    "enabled,url,to",
    [
        ("0", "https://pulse.estateautopilots.com", "someone@example.test"),
        ("1", "https://pulse-staging.estateautopilots.com", "someone@example.test"),
    ],
)
def test_mail_disabled_or_nonproduction_recipient_cannot_send(monkeypatch, enabled, url, to):
    monkeypatch.delenv("PULSE_CI", raising=False)
    monkeypatch.delenv("PULSE_NOTIFICATION_MODE", raising=False)
    monkeypatch.delenv("PULSE_AUTH_MAIL_MODE", raising=False)
    monkeypatch.setenv("PULSE_GMAIL_SEND_ENABLED", enabled)
    monkeypatch.setenv("PULSE_PUBLIC_URL", url)
    monkeypatch.setattr(notifications.subprocess, "run", lambda *a, **k: pytest.fail("No real email permitted"))
    assert notifications.send_mail(to, "HR request reminder", "/me/approvals") == "disabled"


def test_mail_sender_and_configured_production_host(monkeypatch):
    monkeypatch.delenv("PULSE_CI", raising=False)
    monkeypatch.delenv("PULSE_NOTIFICATION_MODE", raising=False)
    monkeypatch.delenv("PULSE_AUTH_MAIL_MODE", raising=False)
    monkeypatch.setenv("PULSE_GMAIL_SEND_ENABLED", "1")
    monkeypatch.setenv("PULSE_PUBLIC_URL", "https://pulse.atlascrest.example")
    monkeypatch.setenv("PULSE_MAIL_PRODUCTION_HOST", "pulse.atlascrest.example")
    monkeypatch.setenv("PULSE_MAIL_FROM", "pulse@atlascrest.example")
    calls = []

    def bridge_call(args, **kwargs):
        calls.append((args, kwargs))
        return type("Result", (), {"returncode": 0})()

    monkeypatch.setenv("PULSE_MAIL_TRANSPORT", "smtp")
    monkeypatch.setenv("PULSE_SMTP_FILE", "/run/secrets/pulse-smtp.json")
    monkeypatch.setattr(notifications.subprocess, "run", bridge_call)
    assert notifications.send_mail("synthetic@example.test", "Welcome", "/login") == "sent"
    args, kwargs = calls[0]
    assert args[0] == "python3"
    assert args[-2].endswith("tools/google-bridge.py")
    assert args[-1] == "send"
    assert "pulse@atlascrest.example" not in args
    assert json.loads(kwargs["input"])["from"] == "pulse@atlascrest.example"


def test_mail_bridge_path_uses_configured_repo_root(monkeypatch, tmp_path):
    tools = tmp_path / "tools"
    tools.mkdir()
    (tools / "google-bridge.py").touch()
    monkeypatch.setenv("PULSE_REPO_ROOT", str(tmp_path))
    assert notifications._mail_bridge_path() == tools / "google-bridge.py"


@pytest.mark.parametrize("port,client_name", [(465, "SMTP_SSL"), (587, "SMTP")])
def test_smtp_bridge_reads_credentials_from_file_and_uses_tls_mode(monkeypatch, tmp_path, port, client_name):
    bridge_path = Path(__file__).resolve().parents[3] / "tools/google-bridge.py"
    spec = importlib.util.spec_from_file_location("pulse_mail_bridge", bridge_path)
    bridge = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bridge)
    config_path = tmp_path / "smtp.json"
    test_user = f"fixture-user-{port}"
    test_password = f"fixture-password-{port}"
    config_path.write_text(
        json.dumps({"host": "127.0.0.1", "port": port, "user": test_user, "password": test_password})
    )
    config_path.chmod(0o600)
    monkeypatch.setenv("PULSE_SMTP_FILE", str(config_path))
    monkeypatch.setenv("PULSE_MAIL_FROM", "pulse@atlascrest.example")
    clients = []

    class SMTPStub:
        def __init__(self, host, selected_port, **kwargs):
            self.args = (host, selected_port, kwargs)
            self.auth = None
            self.message = None
            self.started_tls = False
            clients.append(self)

        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

        def ehlo(self):
            return None

        def starttls(self, *, context):
            self.started_tls = context is not None

        def login(self, user, password):
            self.auth = (user, password)

        def send_message(self, message):
            self.message = message

    monkeypatch.setattr(bridge, client_name, SMTPStub)
    result = bridge.send_smtp({"from": "pulse@atlascrest.example", "to": "synthetic@example.test", "title": "Welcome",
                               "body": "Open Pulse", "brand": {"name": "Atlas Crest"},
                               "attachment": {"name": "evidence.zip", "mime": "application/zip",
                                              "bytes": "UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA=="}})

    assert result == {"id": "smtp-sent", "sent": True}
    client = clients[0]
    assert client.args[:2] == ("127.0.0.1", port)
    assert client.auth == (test_user, test_password)
    assert client.message["From"] == "pulse@atlascrest.example"
    assert client.message["To"] == "synthetic@example.test"
    text_part = next(part for part in client.message.walk() if part.get_content_type() == "text/plain")
    assert "Atlas Crest" in text_part.get_content()
    assert client.started_tls is (port == 587)
    attachment = next(client.message.iter_attachments())
    assert attachment.get_filename() == "evidence.zip"
    assert attachment.get_content_type() == "application/zip"
    assert attachment.get_payload(decode=True) == b"PK\x05\x06" + bytes(18)


@pytest.mark.parametrize("action", ["inbox", "upload"])
@pytest.mark.parametrize("sender", ["staff@estateautopilots.com", "finance-bot@estateautopilots.com"])
def test_google_sender_is_not_overridden_and_google_domain_is_enforced(monkeypatch, action, sender):
    bridge_path = Path(__file__).resolve().parents[3] / "tools/google-bridge.py"
    spec = importlib.util.spec_from_file_location("pulse_mail_sender_policy", bridge_path)
    bridge = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bridge)
    monkeypatch.setenv("PULSE_MAIL_FROM", "hr@estateautopilots.com")
    monkeypatch.setenv("PULSE_GOOGLE_DOMAIN", "estateautopilots.com")
    assert bridge.google_subject_for_send({"subject": sender}, "hr@estateautopilots.com") == sender
    assert bridge.google_subject_allowed(sender, "estateautopilots.com")
    assert not bridge.google_subject_allowed("operator@example.test", "estateautopilots.com")
    monkeypatch.setenv("PULSE_MAIL_TRANSPORT", "google")
    monkeypatch.setattr(sys, "argv", [str(bridge_path), action])
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps({"subject": "operator@example.test"})))
    with pytest.raises(ValueError, match="mail unavailable"):
        bridge.main()


@pytest.mark.parametrize("sender", ["staff@estateautopilots.com", "finance-bot@estateautopilots.com"])
def test_smtp_refuses_nonconfigured_personal_or_finance_sender(monkeypatch, tmp_path, sender):
    bridge_path = Path(__file__).resolve().parents[3] / "tools/google-bridge.py"
    spec = importlib.util.spec_from_file_location("pulse_mail_sender_smtp", bridge_path)
    bridge = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bridge)
    config_path = tmp_path / "smtp.json"
    config_path.write_text(json.dumps({"host": "127.0.0.1", "port": 587, "user": "synthetic", "password": "secret"}))
    monkeypatch.setenv("PULSE_SMTP_FILE", str(config_path))
    monkeypatch.setenv("PULSE_MAIL_FROM", "pulse@atlascrest.example")
    with pytest.raises(ValueError, match="mail unavailable"):
        bridge.send_smtp({"from": sender, "to": "synthetic@example.test",
                          "title": "Monthly close", "body": "Synthetic report"})
