"""Synthetic bank/card/UPI/gateway exports, including unknown rows and private field stripping."""
import base64
import importlib.util
import io
from pathlib import Path

from openpyxl import Workbook

spec = importlib.util.spec_from_file_location("statement_parse", Path(__file__).parents[2] / "tools/statement-parse.py")
parser = importlib.util.module_from_spec(spec)
spec.loader.exec_module(parser)


def parse(raw, fmt="csv", **kwargs):
    return parser.parse({"content": base64.b64encode(raw).decode(), "format": fmt, **kwargs})


def test_bank_csv_masks_account_and_credentials_skips_ambiguous():
    d = parse(b"Date,Description,Debit,Credit,Account Number,Reference,Password\n01/07/2026,Adobe 1234 5678 9012 password=synthetic,25,,123456789012,private-reference,secret\n01/07/2026,Unknown,,,,,\n")
    assert d["rows"][0]["account_last4"] == "9012"
    assert d["rows"][0]["category"] == "Subscriptions"
    assert d["rows"][0]["direction"] == "outflow"
    assert "123456789012" not in str(d)
    assert "1234 5678 9012" not in str(d)
    assert "synthetic" not in str(d)
    assert "private-reference" not in str(d)
    assert d["skipped"] == 1


def test_xlsx_native_date_and_explicit_upi_direction():
    wb = Workbook()
    sheet = wb.active
    sheet.append(["Transaction Date", "Merchant", "Amount", "Type"])
    sheet.append(["2026-07-01", "Synthetic office", 7, "Debited"])
    out = io.BytesIO()
    wb.save(out)
    d = parse(out.getvalue(), "xlsx")
    assert d["rows"][0]["amount"] == "7"
    assert d["rows"][0]["direction"] == "outflow"


def test_gateway_minor_units_require_explicit_choice_and_column_mapping():
    d = parse(b"created_at,customer name,amount\n2026-07-01 10:10:10,Synthetic client,12345\n", amountUnit="minor", defaultDirection="inflow")
    assert d["rows"][0]["amount"] == "123.45"
    assert d["rows"][0]["direction"] == "inflow"
    unknown = parse(b"Date,Merchant,Amount\n2026-07-01,Unknown,5\n")
    assert not unknown["rows"]
    mapped = parse(b"Booked,Who,Value,Flow\n2026-07-01,Synthetic,5,CR\n", mapping={"date": "Booked", "vendor": "Who", "amount": "Value", "direction": "Flow"})
    assert mapped["rows"][0]["direction"] == "inflow"


def test_missing_reference_keeps_distinct_merchants_and_replays_identically():
    first = parse(b"Date,Merchant,Amount,Direction\n2026-07-01,Synthetic one,5,DR\n")["rows"][0]
    repeat = parse(b"Date,Merchant,Amount,Direction\n2026-07-01,Synthetic one,5,DR\n")["rows"][0]
    other = parse(b"Date,Merchant,Amount,Direction\n2026-07-01,Synthetic two,5,DR\n")["rows"][0]
    assert first["reference_hash"] == repeat["reference_hash"]
    assert first["reference_hash"] != other["reference_hash"]


def test_pdf_text_table_parses_with_review_warning():
    from pypdf import PdfWriter
    from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject
    writer = PdfWriter()
    page = writer.add_blank_page(width=600, height=800)
    font = DictionaryObject({NameObject("/Type"): NameObject("/Font"), NameObject("/Subtype"): NameObject("/Type1"), NameObject("/BaseFont"): NameObject("/Helvetica")})
    page[NameObject("/Resources")] = DictionaryObject({NameObject("/Font"): DictionaryObject({NameObject("/F1"): writer._add_object(font)})})
    stream = DecodedStreamObject()
    stream.set_data(b"BT /F1 10 Tf 50 750 Td (Date) Tj 100 0 Td (Merchant) Tj 150 0 Td (Amount) Tj 100 0 Td (Direction) Tj ET\nBT /F1 10 Tf 50 730 Td (2026-07-01) Tj 100 0 Td (Synthetic) Tj 150 0 Td (25) Tj 100 0 Td (DR) Tj ET")
    page[NameObject("/Contents")] = writer._add_object(stream)
    out = io.BytesIO()
    writer.write(out)
    d = parse(out.getvalue(), "pdf")
    assert d["rows"][0]["amount"] == "25"
    assert d["rows"][0]["direction"] == "outflow"
    assert d["warnings"]


def test_currency_scale_sign_and_timezone_issues_are_explicit():
    jpy = parse(b"Date,Amount,Direction,Currency\n2026-07-01,123,CR,JPY\n", amountUnit="minor")
    assert jpy['rows'][0]['amount'] == '123'
    assert jpy['rows'][0]['minor_unit_scale'] == 0
    kwd = parse(b"Date,Amount,Direction,Currency\n2026-07-01,1234,CR,KWD\n", amountUnit="minor")
    assert kwd['rows'][0]['amount'] == '1.234'
    issue = parse(b"Date,Debit,Credit\n2026-07-01T00:15:00+05:30,-123,\n")
    assert 'Reversed debit/credit' in str(issue['rows'][0]['parser_issues'])
    assert 'Timezone boundary' in str(issue['rows'][0]['parser_issues'])
    assert issue['rows'][0]['file_replay_key']


def test_account_digest_is_scoped_and_raw_account_does_not_escape():
    raw = b"Date,Amount,Direction,Account Number,Transaction ID\n2026-07-01,5,DR,123456789012,synthetic-transaction\n"
    first = parse(raw, sourceScope="synthetic-a", sourceType="bank")["rows"][0]
    repeat = parse(raw, sourceScope="synthetic-a", sourceType="bank")["rows"][0]
    foreign = parse(raw, sourceScope="synthetic-b", sourceType="bank")["rows"][0]
    assert first["account_digest"] == repeat["account_digest"]
    assert first["account_digest"] != foreign["account_digest"]
    assert first["reference_kind"] == "provider_transaction"
    assert "123456789012" not in str(first)
