from unittest.mock import Mock

import pytest

from pulse_workers.finance_desk import extract_invoice, fixtures, read_finance_mail
from pulse_workers.finance_providers import FixtureZohoBooks, GoogleFinanceMail, GoogleFinancePort


def test_google_drive_rejects_outside_root_even_at_raw_provider_boundary():
    service = Mock()
    files = service.files.return_value
    metadata = {
        "finance-root": {"id": "finance-root", "mimeType": "application/vnd.google-apps.folder"},
        "foreign-child": {"id": "foreign-child", "parents": ["foreign-root"]},
        "foreign-root": {"id": "foreign-root", "parents": []},
        "own-child": {"id": "own-child", "parents": ["finance-root"]},
    }
    files.get.side_effect = lambda **kwargs: Mock(execute=lambda: metadata[kwargs["fileId"]])
    port = GoogleFinancePort(service, "finance-root")
    with pytest.raises(ValueError, match="outside Finance"):
        port.write("foreign-child", "invoice.pdf", b"invoice", "application/pdf", "key")
    with pytest.raises(ValueError, match="outside Finance"):
        port.folder("foreign-child", "2026-09")
    files.create.assert_not_called()
    files.update.assert_not_called()
    files.list.return_value.execute.return_value = {"files": []}
    files.create.return_value.execute.return_value = {"id": "fixture-created"}
    assert port.write("own-child", "invoice.pdf", b"invoice", "application/pdf", "key") == "fixture-created"
    assert files.create.call_args.kwargs["supportsAllDrives"] is True
    assert files.create.call_args.kwargs["body"]["parents"] == ["own-child"]
    # The sheet mirror uses Drive CSV conversion and is kept in the configured root.
    port.write("finance-root", "Purchase register", b"key,vendor\n", "text/csv", "sheet:purchase")
    assert files.create.call_args.kwargs["body"]["mimeType"] == "application/vnd.google-apps.spreadsheet"
    assert files.create.call_args.kwargs["body"]["parents"] == ["finance-root"]


def test_google_drive_rechecks_ancestry_for_updates_and_never_moves_files():
    service = Mock()
    files = service.files.return_value
    files.get.return_value.execute.return_value = {"mimeType": "application/vnd.google-apps.folder"}
    files.list.return_value.execute.return_value = {"files": [{"id": "sheet", "parents": ["foreign-root"]}]}
    port = GoogleFinancePort(service, "finance-root")
    with pytest.raises(ValueError, match="outside Finance"):
        port.write("finance-root", "register", b"key\n", "text/csv", "sheet:purchase")
    files.update.assert_not_called()


def test_zoho_books_fixture_api_handoff_is_idempotent_and_requires_reviewed_mapping():
    config, messages, _ = fixtures()
    invoice = extract_invoice(messages[0]["attachments"][0]["bytes"], config["ourGSTIN"], {})
    client = FixtureZohoBooks()
    first = client.create_bill("invoice-key", invoice, "fixture-vendor-id", "fixture-tax-id")
    second = client.create_bill("invoice-key", invoice, "fixture-vendor-id", "fixture-tax-id")
    assert first == second and len(client.bills) == 1
    assert first["payload"]["vendor_id"] == "fixture-vendor-id"
    assert first["payload"]["bill_number"] == "SYN-001"
    assert first["payload"]["line_items"][0]["rate"] == "1000.00"
    assert first["payload"]["reference_number"] == "pulse:invoice-key"
    with pytest.raises(ValueError, match="mapping"):
        client.create_bill("other", invoice, "", "")
    with pytest.raises(ValueError, match="retry differs"):
        client.create_bill("invoice-key", {**invoice, "taxable": "2000.00"}, "fixture-vendor-id", "fixture-tax-id")


def test_gmail_provider_filters_each_header_before_full_fetch_and_rejects_unselected_content():
    config, _, _ = fixtures()
    config = {**config, "financeBotExists": True, "mode": "live"}
    client = Mock()
    messages = client.users.return_value.messages.return_value
    messages.list.return_value.execute.return_value = {"messages": [{"id": "finance"}, {"id": "private"}]}
    calls = []

    def get(**params):
        calls.append(params)
        return Mock(
            execute=lambda: {
                "payload": {
                    "headers": [
                        {"name": "From", "value": config["senders"][0]},
                        {
                            "name": "Subject",
                            "value": "Invoice ITR set" if params["id"] == "finance" else "Campaign draft",
                        },
                        {"name": "Date", "value": "Fri, 9 Oct 2026 17:00:00 +0000"},
                    ],
                    "parts": [],
                }
            }
        )

    messages.get.side_effect = get
    provider = GoogleFinanceMail({config["billingMailbox"]: client, "marketing@estateautopilots.com": client}, config)
    selected = read_finance_mail(provider, config)
    assert len(selected) == 2
    assert all(c["id"] == "finance" for c in calls if c["format"] == "full")
    assert all("body" not in mail for mail in selected)
    with pytest.raises(ValueError, match="must never be read"):
        provider.content("marketing@estateautopilots.com:private")
    assert all("q" in call.kwargs and "from:" in call.kwargs["q"] for call in messages.list.call_args_list)
