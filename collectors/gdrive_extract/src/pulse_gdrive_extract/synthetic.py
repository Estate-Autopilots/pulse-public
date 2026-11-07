"""Synthetic documents for the tests and `pulse-drive-extract selftest`: Unicode text, tables, Google export shapes,
and hostile files (encrypted, macro, entity tricks, zip bombs, wrong types, scans). Built in memory; no real person,
file or company data.
"""

from __future__ import annotations

import io
import zipfile
from xml.sax.saxutils import escape

DOCX_TYPES = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
              '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
              '<Default Extension="xml" ContentType="application/xml"/>'
              '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.'
              '{kind}.main+xml"/></Types>')
W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"

UNICODE_LINES = [
    "Shoot plan — मुंबई साइट विज़िट (सोमवार)",
    "Client note: مرحبا بالعالم ✓ 東京 renders 🎬📐",
    "Combining: é vs é, ZWJ family 👩‍👩‍👧",
]
TABLE = [["Deliverable", "Owner", "Due"], ["Walkthrough cut ✂️", "पॉड 1", "12 Oct"], ["Floor plan, v2", "Pod 2", ""]]


def _paragraph(text: str, style: str | None = None) -> str:
    props = f'<w:pPr><w:pStyle w:val="{style}"/></w:pPr>' if style else ""
    runs = []
    for i, piece in enumerate(text.split("\t")):
        if i:
            runs.append("<w:r><w:tab/></w:r>")
        runs.append(f'<w:r><w:t xml:space="preserve">{escape(piece)}</w:t></w:r>')
    return f"<w:p>{props}{''.join(runs)}</w:p>"


def docx(paragraphs: list[str] | None = None, *, heading: str | None = "Site visit",
         table: list[list[str]] | None = None, extra: dict[str, bytes] | None = None,
         kind: str = "wordprocessingml.document", document: bytes | None = None) -> bytes:
    body = []
    if heading:
        body.append(_paragraph(heading, "Heading1"))
    body += [_paragraph(p) for p in (UNICODE_LINES if paragraphs is None else paragraphs)]
    if table:
        rows = "".join("<w:tr>" + "".join(f"<w:tc>{_paragraph(cell)}</w:tc>" for cell in row) + "</w:tr>"
                       for row in table)
        body.append(f"<w:tbl>{rows}</w:tbl>")
    xml = document or (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="{W_NS}">'
                       f'<w:body>{"".join(body)}<w:p><w:r><w:delText>deleted words</w:delText></w:r></w:p>'
                       f'</w:body></w:document>').encode()
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", DOCX_TYPES.format(kind=kind))
        archive.writestr("word/document.xml", xml)
        for name, data in (extra or {}).items():
            archive.writestr(name, data)
    return out.getvalue()


def docx_text(paragraphs: list[str] | None = None, heading: str | None = "Site visit",
              table: list[list[str]] | None = None) -> str:
    """The text docx() should extract to."""
    lines = ([heading] if heading else []) + (UNICODE_LINES if paragraphs is None else paragraphs)
    lines += ["\t".join(row) for row in (table or [])]
    return "\n".join(lines + [""])


def macro_docx() -> bytes:
    return docx(extra={"word/vbaProject.bin": b"\x00Attribute VB_Name = \"Synthetic\"\x00"})


def macro_type_docx() -> bytes:
    return docx(kind="wordprocessingml.document.macroEnabled")


def entity_docx() -> bytes:
    lol = (b'<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;">]>'
           b'<w:document xmlns:w="' + W_NS.encode() + b'"><w:body><w:p><w:r><w:t>&lol2;</w:t></w:r></w:p></w:body>'
           b'</w:document>')
    return docx(document=lol)


def bomb_docx(size: int = 8 * 1024 * 1024) -> bytes:
    return docx(extra={"word/media/padding.bin": b"\0" * size})


def encrypted_docx() -> bytes:
    """What Word writes for a password-protected file: an OLE compound file, not a zip."""
    return b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"\0" * 504 + b"EncryptedPackage" + b"\0" * 1024


def _pdf(objects: list[bytes]) -> bytes:
    out, offsets = io.BytesIO(), []
    out.write(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    for number, body in enumerate(objects, 1):
        offsets.append(out.tell())
        out.write(f"{number} 0 obj\n".encode() + body + b"\nendobj\n")
    xref = out.tell()
    out.write(f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode())
    for offset in offsets:
        out.write(f"{offset:010d} 00000 n \n".encode())
    out.write(f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
    return out.getvalue()


def _stream(data: bytes) -> bytes:
    return b"<< /Length " + str(len(data)).encode() + b" >>\nstream\n" + data + b"\nendstream"


def pdf(lines: list[str] | None = None) -> bytes:
    """A text PDF whose font maps one-byte codes to any Unicode text through a ToUnicode map (how real PDFs carry
    Devanagari or emoji for extraction)."""
    lines = UNICODE_LINES if lines is None else lines
    codes: dict[str, int] = {}
    for ch in "".join(lines):
        codes.setdefault(ch, len(codes) + 1)
    if len(codes) > 250:
        raise ValueError("too many distinct characters for this synthetic font")
    content = [b"BT /F1 12 Tf 72 720 Td 14 TL"]
    for line in lines:
        content.append(b"<" + "".join(f"{codes[ch]:02X}" for ch in line).encode() + b"> Tj T*")
    content.append(b"ET")

    def utf16(ch: str) -> str:
        return ch.encode("utf-16-be").hex().upper()

    cmap = ("/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) "
            "/Ordering (UCS) /Supplement 0 >> def /CMapName /Adobe-Identity-UCS def /CMapType 2 def "
            "1 begincodespacerange <00> <FF> endcodespacerange "
            f"{len(codes)} beginbfchar " + " ".join(f"<{code:02X}> <{utf16(ch)}>" for ch, code in codes.items())
            + " endbfchar endcmap CMapName currentdict /CMap defineresource pop end end")
    return _pdf([
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> "
        b"/Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /FirstChar 1 /LastChar 255 /ToUnicode 6 0 R >>",
        _stream(b"\n".join(content)),
        _stream(cmap.encode()),
    ])


def scanned_pdf() -> bytes:
    """A page with no text layer (what a scan looks like to an extractor)."""
    return _pdf([b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
                 b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>",
                 _stream(b"0 0 m 100 100 l S")])


def encrypted_pdf() -> bytes:
    from pypdf import PdfWriter

    writer = PdfWriter()
    writer.add_blank_page(200, 200)
    writer.encrypt(user_password="synthetic-user", owner_password="synthetic-owner", algorithm="RC4-128")
    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()


def corrupt_pdf() -> bytes:
    return b"%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 9 0 R >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF"


def sheet_csv() -> bytes:
    """A Google Sheets CSV export: first sheet only, quoted commas and line breaks, Unicode."""
    return ('Project,Address,Notes\r\nEA-0584,"Flat 4, Bandra West","Walkthrough ✓\r\nsecond line"\r\n'
            'EA-0601,दादर पूर्व,ड्रोन शॉट 🚁\r\n').encode()


def slides_text() -> bytes:
    return "Pitch deck\nSlide 2 — Why us?\nशुक्रिया\n".encode()


def chat_export() -> bytes:
    return (b"12/03/24, 10:15 - Synthetic A: hello\n12/03/24, 10:16 - Synthetic B: hi there\n"
            b"12/03/24, 10:17 - Synthetic A: shoot at 4?\n")


def id_numbers() -> bytes:
    return b"Joining checklist\nAadhaar: 2345 6789 0125\n"
