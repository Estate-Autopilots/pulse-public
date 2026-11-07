"""R45 without a database: payload codec, the sandboxed extractors on synthetic documents (Unicode, tables, Google
export shapes, hostile files), exclusions, content screening and limits."""

from __future__ import annotations

import json
import zlib

import pytest

from pulse_gdrive_extract import extract, payload, synthetic
from pulse_gdrive_extract.extract import plan, run_extractor, screen

ALL = list(extract.FORMAT_KEYS)
MB = 1024 * 1024


# --------------------------------------------------------------------------------------------------------- payloads
@pytest.mark.parametrize("text", ["", "plain", "\n".join(synthetic.UNICODE_LINES), "\u0000-free 𝔘𝔫𝔦𝔠𝔬𝔡𝔢 " * 5000])
def test_payload_round_trip_is_byte_exact(text):
    item = payload.text_payload(text)
    assert item.schema == payload.TEXT_SCHEMA and item.codec == "zlib" and item.raw_length == len(text.encode())
    assert payload.decode(item.codec, item.data, item.sha256, item.raw_length).decode("utf-8") == text


def test_facts_are_canonical_and_round_trip():
    facts = {"tables": [{"rows": synthetic.TABLE}], "format": "docx", "chars": 3}
    a, b = payload.facts_payload(facts), payload.facts_payload(dict(reversed(list(facts.items()))))
    assert a.sha256 == b.sha256 and a.data == b.data
    assert json.loads(payload.decode(a.codec, a.data, a.sha256, a.raw_length)) == facts


def test_corrupt_payloads_are_detected_never_returned():
    item = payload.text_payload("\n".join(synthetic.UNICODE_LINES))
    flipped = bytearray(item.data)
    flipped[len(flipped) // 2] ^= 0x01
    for codec, data, sha, length in (
        (item.codec, bytes(flipped), item.sha256, item.raw_length),              # damaged stream
        (item.codec, item.data[:-3], item.sha256, item.raw_length),              # truncated
        (item.codec, item.data + b"\0", item.sha256, item.raw_length),           # trailing bytes
        (item.codec, item.data, "0" * 64, item.raw_length),                      # wrong hash
        (item.codec, item.data, item.sha256, item.raw_length - 1),               # wrong length
        ("lzma", item.data, item.sha256, item.raw_length),                       # unknown codec
        (item.codec, zlib.compress(b"x" * (50 * MB)), item.sha256, 10),          # expands past its length
    ):
        with pytest.raises(payload.PayloadCorrupt):
            payload.decode(codec, data, sha, length)


# ------------------------------------------------------------------------------------------------------- extractors
def test_docx_unicode_paragraphs_headings_and_tables():
    out = run_extractor("docx", synthetic.docx(table=synthetic.TABLE))
    assert out.status == "extracted" and out.sandbox in ("bwrap", "rlimit")
    assert out.text == synthetic.docx_text(table=synthetic.TABLE)
    assert "deleted words" not in out.text
    assert out.facts["tables"] == [{"rows": synthetic.TABLE}]
    assert out.facts["headings"] == [{"level": 1, "text": "Site visit"}]
    assert out.facts["parts"] == ["body"]


def test_pdf_unicode_through_tounicode_map():
    out = run_extractor("pdf", synthetic.pdf())
    assert out.status == "extracted" and out.facts["pages"] == 1
    for line in synthetic.UNICODE_LINES:              # Devanagari, Arabic in logical order, CJK, emoji, combining
        assert line in out.text


def test_google_exports_sheet_csv_and_slides_text():
    sheet = run_extractor("csv", synthetic.sheet_csv())
    assert sheet.status == "extracted" and sheet.text == synthetic.sheet_csv().decode()
    assert sheet.facts["tables"][0]["rows"][1] == ["EA-0584", "Flat 4, Bandra West", "Walkthrough ✓\r\nsecond line"]
    assert sheet.facts["tables"][0]["rows"][2][2] == "ड्रोन शॉट 🚁"
    slides = run_extractor("text", synthetic.slides_text())
    assert slides.text == synthetic.slides_text().decode() and slides.facts["lines"] == 3


def test_text_is_strict_unicode_not_guessed():
    assert run_extractor("text", "naïve".encode("latin-1")).reason == "unknown_encoding"
    assert run_extractor("text", b"abc\x00def").reason == "binary_content"
    bom = run_extractor("text", "हाँ".encode("utf-8-sig"))
    assert bom.text == "हाँ" and bom.facts["bom"] is True
    utf16 = run_extractor("text", "\ufeff東京".encode("utf-16-le"))
    assert utf16.text == "東京" and utf16.facts["encoding"] == "utf-16-le"


@pytest.mark.parametrize(("kind", "build", "status", "reason"), [
    ("docx", synthetic.macro_docx, "quarantined", "macro"),
    ("docx", synthetic.macro_type_docx, "quarantined", "macro"),
    ("docx", synthetic.entity_docx, "quarantined", "hostile_xml"),
    ("docx", synthetic.bomb_docx, "quarantined", "hostile_archive"),
    ("docx", synthetic.encrypted_docx, "quarantined", "encrypted"),
    ("docx", synthetic.pdf, "quarantined", "type_mismatch"),
    ("docx", lambda: b"PK\x03\x04 not really a zip", "quarantined", "corrupt"),
    ("pdf", synthetic.encrypted_pdf, "quarantined", "encrypted"),
    ("pdf", synthetic.corrupt_pdf, "quarantined", "corrupt"),
    ("pdf", synthetic.docx, "quarantined", "type_mismatch"),
    ("pdf", synthetic.scanned_pdf, "unsupported", "no_text_layer"),
])
def test_hostile_and_unreadable_files_are_labelled_not_parsed(kind, build, status, reason):
    out = run_extractor(kind, build())
    assert (out.status, out.reason, out.text) == (status, reason, None)


def test_extractor_timeout_and_limits_quarantine():
    assert run_extractor("pdf", synthetic.pdf(), timeout=0.05).reason == "extractor_timeout"
    assert run_extractor("text", b"x" * 2000, max_input=1000).reason == "oversized"
    assert run_extractor("text", b"x" * 2000, max_text=1000).reason == "output_limit"


def test_the_sandbox_gets_no_secrets(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://synthetic-secret@db/x")
    assert extract._child_env() == {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"}


# ----------------------------------------------------------------------------------------------- before any fetch
@pytest.mark.parametrize(("names", "reason"), [
    (["WhatsApp Chat with Synthetic.txt"], "chat_source"),
    (["notes.txt", "Chat Export"], "chat_source"),
    (["msgstore.db"], "chat_source"),
    (["PAN_Card.pdf"], "government_id"),
    (["scan.pdf", "Aadhar copies"], "government_id"),
    (["joining.docx", "KYC"], "government_id"),
    (["passport front.pdf"], "government_id"),
    (["march.pdf", "Salary 2026"], "sensitive_path"),
    (["form.docx", "EA Team Member Details"], "sensitive_path"),
])
def test_chats_ids_and_sensitive_paths_never_enter_extraction(names, reason):
    assert plan("text/plain", 10, names, ALL, MB) == extract.Plan("excluded", reason)


def test_types_sizes_and_approved_formats():
    assert plan("application/pdf", 10, ["Site plan.pdf"], ALL, MB).format == "pdf"
    assert plan("application/vnd.google-apps.document", None, ["Brief"], ALL, MB).export_mime == extract.DOCX
    assert plan("application/vnd.google-apps.spreadsheet", None, ["Tracker"], ALL, MB).export_mime == "text/csv"
    assert plan("application/pdf", 2 * MB, ["big.pdf"], ALL, MB) == extract.Plan("quarantined", "oversized")
    assert plan("application/vnd.ms-word.document.macroEnabled.12", 10, ["m.docm"], ALL, MB).reason == "macro"
    assert plan("image/jpeg", 10, ["site.jpg"], ALL, MB) == extract.Plan("unsupported", "needs_ocr")
    assert plan("video/mp4", 10, ["cut.mp4"], ALL, MB).reason == "media"
    assert plan("application/zip", 10, ["x.zip"], ALL, MB).reason == "format_not_supported"
    assert plan("application/pdf", 10, ["x.pdf"], ["docx"], MB) == extract.Plan("unsupported", "format_not_approved")
    assert plan("text/plain", 10, ["Pan India rollout.txt"], ALL, MB).status is None    # "pan" alone is not an ID


def test_text_screening_drops_id_numbers_and_chat_exports():
    assert screen(synthetic.id_numbers().decode()) == "government_id_content"
    assert screen("PAN ABCPE1234F on file") == "government_id_content"
    assert screen("aadhaar no. 234567890125") == "government_id_content"
    assert screen("ref 2345 6789 0123 (fails the Aadhaar check digit)") is None
    assert screen(synthetic.chat_export().decode()) == "chat_content"
    assert screen("\n".join(synthetic.UNICODE_LINES)) is None
    assert screen("Call +91 98765 43210 or invoice 2024-0001-5678") is None
