# MAIL-GUARD (5 Nov 2026): staging holds a copy of real company data. Off production the worker's queued HR mail goes
# only to PULSE_MAIL_STAGING_ALLOW, by every route (the install bridge, a company's own mailbox, Resend), and a
# company mailbox's own (copied, real) address is no exception. Production is unchanged. Synthetic addresses only.
import pytest

from pulse_workers import notifications

MAILBOX = {"address": "hr@acme.example.test", "token": "synthetic-token", "name": "Acme Fake", "origin": "https://acme.example.test"}


def _env(monkeypatch, env, url, **extra):
    for k in ("PULSE_CI", "PULSE_NOTIFICATION_MODE", "PULSE_AUTH_MAIL_MODE", "PULSE_ENV", "PULSE_MAIL_PRODUCTION_HOST",
              "PULSE_PLATFORM_DOMAIN", "PULSE_GOOGLE_DOMAIN"):
        monkeypatch.delenv(k, raising=False)
    if env is not None:
        monkeypatch.setenv("PULSE_ENV", env)
    monkeypatch.setenv("PULSE_PUBLIC_URL", url)
    monkeypatch.setenv("PULSE_GMAIL_SEND_ENABLED", "1")
    monkeypatch.setenv("PULSE_MAIL_FROM", "hr@estate.example.test")
    monkeypatch.setenv("PULSE_MAIL_STAGING_ALLOW", "qa@estate.example.test")
    for k, v in extra.items():
        monkeypatch.setenv(k, v)
    no_send = lambda *a, **k: pytest.fail("No real email permitted")  # noqa: E731
    monkeypatch.setattr(notifications.subprocess, "run", no_send)
    monkeypatch.setattr(notifications.urllib.request, "urlopen", no_send)


@pytest.mark.parametrize("env,url,extra", [
    ("staging", "https://pulse-staging.example.test", {}),
    ("dev", "https://pulse-dev.example.test", {}),
    # A staging worker pointed at itself as the production host is still staging.
    ("staging", "https://pulse-staging.example.test", {"PULSE_MAIL_PRODUCTION_HOST": "pulse-staging.example.test"}),
])
def test_off_production_every_route_mails_only_the_allow_list(monkeypatch, env, url, extra):
    _env(monkeypatch, env, url, **extra)
    assert notifications.mail_recipient_allowed("client@customer.example.test") is False
    assert notifications.mail_recipient_allowed(" QA@estate.example.test ") is True
    assert notifications.send_mail("client@customer.example.test", "Leave approved", "/me") == "disabled"
    assert notifications.send_company_mail(MAILBOX, "client@customer.example.test", "Invoice", "/me") == "disabled"
    # The company mailbox's own address is a real company's on staging: no exception.
    assert notifications.send_company_mail(MAILBOX, "hr@acme.example.test", "Invoice", "/me") == "disabled"
    assert notifications.send_resend({}, "client@customer.example.test", "Invoice", "/me", None) == "disabled"


@pytest.mark.parametrize("env,extra", [
    ("production", {}),
    ("prod", {"PULSE_MAIL_PRODUCTION_HOST": "pulse.example.test"}),
    # The production timer's unit sets only PULSE_PUBLIC_URL (and the host): unchanged.
    (None, {"PULSE_MAIL_PRODUCTION_HOST": "pulse.example.test"}),
])
def test_production_is_unchanged(monkeypatch, env, extra):
    _env(monkeypatch, env, "https://pulse.example.test", **extra)
    assert notifications.mail_recipient_allowed("client@customer.example.test") is True
