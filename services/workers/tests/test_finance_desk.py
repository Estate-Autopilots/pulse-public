import base64
import io
import zipfile
from datetime import date, datetime
from zoneinfo import ZoneInfo

import pytest

from pulse_workers.finance_desk import (
    FinanceDrive,
    FixtureDrive,
    FixtureMail,
    bank_csv,
    bank_upload,
    csv_bytes,
    due_reminders,
    extract_invoice,
    finance_category,
    finance_mail,
    fixtures,
    read_finance_mail,
    reconcile,
    run_fixture,
    schedule,
    synthetic_pdf,
)


def test_marketing_filter_precedes_content_reads_and_otp_is_excluded():
    config, messages, _ = fixtures()
    messages += [
        {
            **messages[0],
            "id": "otp",
            "mailbox": "marketing@estateautopilots.com",
            "subject": "GST portal OTP verification code",
        },
        {**messages[0], "id": "outsider", "sender": "outsider@example.test"},
        {**messages[0], "id": "wrong-mailbox", "mailbox": "hr@estateautopilots.com"},
        {**messages[0], "id": "finance-marketing", "mailbox": "marketing@estateautopilots.com"},
    ]
    provider = FixtureMail(messages)
    assert len(read_finance_mail(provider, config)) == 2
    assert provider.reads == ["fixture-mail-1", "finance-marketing"]
    with pytest.raises(ValueError, match="fixture mode only"):
        read_finance_mail(provider, {**config, "mode": "live"})


def test_ca_gstr3b_itr_and_cs_form11_are_finance_and_classified_without_purchase_rows():
    config, _, _ = fixtures()
    header = {"mailbox": "marketing@estateautopilots.com", "sender": config["senders"][0]}
    for subject, category in [
        ("GSTR-3B September", "GST"),
        ("ITR sets 2026", "Income tax"),
        ("LLP Form11", "Compliance"),
        ("Vendor invoices", "Purchase invoices"),
        ("Sales invoice INV-00003187", "Sales invoices"),
    ]:
        assert finance_mail({**header, "subject": subject}, config)
        assert finance_category(subject) == category


def test_drive_rejects_foreign_folder_every_mutation_and_symlinks(tmp_path):
    port = FixtureDrive(tmp_path / "Finance")
    drive = FinanceDrive(port, "fixture-finance-root")
    port.ancestry["foreign-folder"] = ["foreign-root"]
    port.ancestry["foreign-root"] = []
    with pytest.raises(ValueError, match="outside Finance"):
        drive.write("foreign-folder", "invoice.pdf", b"file", "application/pdf", "invoice")
    with pytest.raises(ValueError, match="outside Finance"):
        drive.folder("foreign-folder", "FY2026-27")
    assert port.writes == []
    for name in ("../escape", "a/b", "..", "a\\b"):
        with pytest.raises(ValueError, match="Unsafe"):
            drive.folder("fixture-finance-root", name)
    (port.output / "escape").symlink_to(tmp_path)
    with pytest.raises(ValueError, match="outside Finance"):
        drive.folder("fixture-finance-root", "escape")
    folder = drive.path(["FY2026-27", "Purchase invoices", "2026-09"])
    assert drive.write(folder, "invoice.pdf", b"file", "application/pdf", "invoice") == "invoice"
    port.ancestry[folder] = ["foreign-root"]
    with pytest.raises(ValueError, match="outside Finance"):
        drive.write(folder, "other.pdf", b"file", "application/pdf", "other")


def test_pdf_extraction_gstin_tax_arithmetic_and_exact_date_fx():
    config, messages, _ = fixtures()
    invoice = extract_invoice(messages[0]["attachments"][0]["bytes"], config["ourGSTIN"], {})
    assert invoice["vendor"] == "Synthetic Software"
    assert invoice["vendorGSTIN"] == "27AAAAA0000A1Z5"
    assert invoice["invoiceNo"] == "SYN-001"
    assert invoice["taxable"] == "1000.00"
    assert invoice["cgst"] == invoice["sgst"] == "90.00"
    assert invoice["igst"] == "0.00"
    assert invoice["ourGSTINPresent"] and invoice["inr"] == "1180.00"
    text = (
        "Vendor: Synthetic FX\nInvoice No: USD-1\nDate: 2026-09-01\nCurrency: USD\n"
        "Taxable: 10.00\nCGST: 0.00\nSGST: 0.00\nIGST: 0.00\nTotal: 10.00"
    )
    fx = extract_invoice(synthetic_pdf(text), config["ourGSTIN"], config["rates"])
    assert fx["inr"] == "832.50" and fx["rbiRate"] == "83.25"
    assert not fx["ourGSTINPresent"]
    missing = extract_invoice(
        synthetic_pdf(text.replace("2026-09-01", "2026-09-02")), config["ourGSTIN"], config["rates"]
    )
    assert missing["inr"] is None and "RBI reference rate" in missing["issues"][0]
    bad = extract_invoice(
        synthetic_pdf(text.replace("Total: 10.00", "Total: 9.00")), config["ourGSTIN"], config["rates"]
    )
    assert bad["status"] == "quarantine"


def test_reciprocal_exact_matching_never_hides_duplicate_references(tmp_path):
    config, messages, statement = fixtures()
    manifest = run_fixture(messages, statement, config, tmp_path, datetime(2026, 10, 5, 16, tzinfo=ZoneInfo("UTC")))
    result = manifest["reconciliation"]
    assert len(result["matches"]) == 1
    assert [e["type"] for e in result["exceptions"]] == ["payment_without_invoice"]
    invoices = [r["body"] for r in manifest["records"] if r["kind"] == "purchase"]
    cash = bank_csv(statement, "Synthetic Bank")
    duplicate = reconcile(invoices, cash + [{**cash[0], "key": "duplicate"}])
    assert not duplicate["matches"]
    assert len([e for e in duplicate["exceptions"] if e["type"] == "payment_without_invoice"]) == 3
    wrong_currency = reconcile(invoices, [{**cash[0], "currency": "USD"}])
    assert not wrong_currency["matches"]


def test_same_mail_and_cross_mailbox_copy_replay_one_register_row_and_identical_pack(tmp_path):
    config, messages, statement = fixtures()
    duplicate = {**messages[0], "mailbox": "marketing@estateautopilots.com", "id": "forward"}
    at = datetime(2026, 10, 5, 16, tzinfo=ZoneInfo("UTC"))
    first = run_fixture(messages + [messages[0], duplicate], statement, config, tmp_path, at)
    second = run_fixture(messages + [messages[0], duplicate], statement, config, tmp_path, at)
    assert len([r for r in first["records"] if r["kind"] == "purchase"]) == 1
    assert first["files"] == second["files"]
    assert first["externalSends"] == 0
    pdf = next(f for f in first["files"] if f["mime"] == "application/pdf")
    assert pdf["path"] == "FY2026-27/Purchase invoices/2026-09/2026-09-01_Synthetic_Software_1180.00_SYN-001.pdf"
    pack = next(f for f in first["files"] if f["mime"] == "application/zip")
    with zipfile.ZipFile(io.BytesIO(base64.b64decode(pack["data"]))) as archive:
        assert {"register.csv", "reconciliation.json", "PDFs/" + pdf["name"]}.issubset(set(archive.namelist()))
        assert any(name.endswith("synthetic-bank.csv") for name in archive.namelist())
    close = next(r for r in first["records"] if r["kind"] == "close")
    assert close["body"]["month"] == "2026-09" and close["body"]["invoiceCount"] == 1
    assert close["body"]["status"] == "draft_founder_approval_required"


def test_broken_pdf_is_filed_and_quarantined_without_losing_mail(tmp_path):
    config, messages, statement = fixtures()
    messages[0]["attachments"][0]["bytes"] = b"%PDF-broken"
    manifest = run_fixture(messages, statement, config, tmp_path, datetime(2026, 10, 5, 16, tzinfo=ZoneInfo("UTC")))
    assert any(r["body"].get("status") == "quarantine" for r in manifest["records"] if r["kind"] == "purchase")
    assert any(e["type"] == "extraction_review" for e in manifest["reconciliation"]["exceptions"])
    assert any(f["mime"] == "application/pdf" for f in manifest["files"])


def test_one_off_vendors_are_listed_and_close_pack_has_open_exceptions(tmp_path):
    import base64
    import io
    import zipfile

    config, messages, statement = fixtures()
    config["subscriptions"] = {}
    manifest = run_fixture(messages, statement, config, tmp_path, datetime(2026, 10, 5, 16, tzinfo=ZoneInfo("UTC")))
    vendors = [r["body"] for r in manifest["records"] if r["kind"] == "vendor"]
    assert len(vendors) == 1 and vendors[0]["vendor"] == "Synthetic Software"
    assert vendors[0]["recurring"] is False and vendors[0]["vendorGSTIN"]
    pack = next(f for f in manifest["files"] if f["mime"] == "application/zip")
    with zipfile.ZipFile(io.BytesIO(base64.b64decode(pack["data"]))) as archive:
        assert "open-exceptions.json" in archive.namelist()


def test_statement_rejects_ambiguous_amounts_and_duplicate_bank_ids():
    _, _, content = fixtures()
    with pytest.raises(ValueError):
        bank_csv(content.replace(b"TX-2", b"TX-1"), "Bank")
    with pytest.raises(ValueError):
        bank_csv(content.replace(b"1180.00", b"-1180.00"), "Bank")
    with pytest.raises(ValueError):
        bank_csv(b"Date,Debit\n01/02/26,10\n", "Bank")


def test_reminders_close_and_brief_respect_ist_date_and_9pm():
    assert due_reminders(date(2026, 10, 7), []) == ["TDS"]
    assert due_reminders(date(2026, 10, 11), []) == ["GSTR-1"]
    assert due_reminders(date(2026, 10, 20), []) == ["GSTR-3B"]
    assert due_reminders(date(2026, 6, 15), ["2026-06-15"]) == ["Advance tax", "PT"]
    before = schedule(datetime(2026, 10, 5, 15, 29, tzinfo=ZoneInfo("UTC")), [], [], {})
    after = schedule(datetime(2026, 10, 5, 15, 30, tzinfo=ZoneInfo("UTC")), [], [], {})
    assert not any(j["kind"] == "brief" for j in before)
    brief = next(j for j in after if j["kind"] == "brief")
    assert brief["moneyIn"] is None and brief["deliveries"] is None
    assert next(j for j in after if j["kind"] == "close_due")["month"] == "2026-09"


def test_csv_export_neutralizes_spreadsheet_formulas():
    assert b"'=danger" in csv_bytes([{"vendor": "=danger"}], ["vendor"])


def test_bank_pdf_upload_uses_normalized_fixture_table_and_reimbursement_links_one_expense(tmp_path):
    config, messages, statement = fixtures()
    config["reimbursementOwners"] = {"fixture-mail-1": "Synthetic Employee"}
    pdf = synthetic_pdf(statement.decode())
    assert len(bank_upload(pdf, "application/pdf", "Synthetic Bank")) == 2
    config["statementUploads"] = [
        {
            "name": "statement.pdf",
            "mime": "application/pdf",
            "bytes": pdf,
            "bank": "Synthetic Bank",
            "date": "2026-09-30",
        }
    ]
    manifest = run_fixture(messages, statement, config, tmp_path, datetime(2026, 10, 5, 16, tzinfo=ZoneInfo("UTC")))
    expense = next(r for r in manifest["records"] if r["kind"] == "purchase")
    reimbursement = next(r for r in manifest["records"] if r["kind"] == "reimbursement")
    assert reimbursement["body"]["purchaseKey"] == expense["key"]
    assert reimbursement["body"]["name"] == "Synthetic Employee"
    assert len([r for r in manifest["records"] if r["kind"] == "zoho"]) == 1
    assert len(manifest["reconciliation"]["matches"]) == 1


def test_weekly_exceptions_do_not_recursively_copy_previous_weekly_snapshots():
    records = [
        {"kind": "exception", "body": {"type": "missing_our_gstin"}},
        {"kind": "exception", "body": {"kind": "weekly_exceptions", "exceptions": [{"type": "old"}]}},
    ]
    jobs = schedule(datetime(2026, 10, 5, 16, tzinfo=ZoneInfo("UTC")), records, [], {})
    assert next(j for j in jobs if j["kind"] == "weekly_exceptions")["exceptions"] == [{"type": "missing_our_gstin"}]


def test_new_mail_appends_after_restart_and_changed_mail_identity_is_rejected(tmp_path):
    config, messages, statement = fixtures()
    when = datetime(2026, 10, 9, 16, tzinfo=ZoneInfo("UTC"))
    first = run_fixture(messages, statement, config, tmp_path, when)
    source = messages[0]["attachments"][0]["bytes"]
    # Change the labeled invoice text by regenerating its parsed PDF contents.
    from pulse_workers.finance_desk import pdf_text

    next_pdf = synthetic_pdf(pdf_text(source).replace("SYN-001", "SYN-002").replace("2026-09-01", "2026-10-01"))
    next_mail = {
        **messages[0],
        "id": "new-mail",
        "attachments": [{"id": "part-1", "mime": "application/pdf", "bytes": next_pdf}],
    }
    second = run_fixture([next_mail], statement, config, tmp_path, when)
    assert len([r for r in first["records"] if r["kind"] == "purchase"]) == 1
    assert len([r for r in second["records"] if r["kind"] == "purchase"]) == 2
    assert "SYN-001" in (tmp_path / "Purchase-register-sheet-fixture.csv").read_text()
    assert "SYN-002" in (tmp_path / "Purchase-register-sheet-fixture.csv").read_text()
    with pytest.raises(ValueError, match="Immutable mail attachment changed"):
        run_fixture([{**next_mail, "id": messages[0]["id"]}], statement, config, tmp_path, when)
