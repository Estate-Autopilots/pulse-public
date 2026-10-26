"""The extractor that touches untrusted bytes. It runs as its own short-lived process (see extract.py), never inside
the worker: python -I with an empty environment, CPU, memory, file-size, open-file and process limits set before the
first byte of the document is read, and inside bubblewrap without network or most of the filesystem where the host
allows it. It reads the document from stdin and writes one JSON outcome to stdout.

Only the standard library and pypdf are imported: no macro, script, external entity or embedded object is run or
followed. Nothing is OCRed. Kinds: text, csv, pdf, docx.

    python -I sandbox.py <kind> <max_input_bytes> <max_text_chars> <cpu_seconds> <memory_bytes>
"""

from __future__ import annotations

import codecs
import csv
import io
import json
import logging
import resource
import sys
import zipfile

EXTRACTORS = {"text": "text/1", "csv": "csv/1", "pdf": "pdf/1", "docx": "docx/1"}
MAX_PAGES = 2000
MAX_ZIP_ENTRIES = 2000
MAX_UNZIPPED = 64 * 1024 * 1024
MAX_XML = 32 * 1024 * 1024
MAX_RATIO = 200
MAX_TABLE_ROWS = 20000
MAX_TABLE_COLS = 500
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


class Outcome(Exception):
    def __init__(self, status: str, reason: str):
        super().__init__(reason)
        self.status, self.reason = status, reason


def quarantine(reason: str) -> Outcome:
    return Outcome("quarantined", reason)


def unsupported(reason: str) -> Outcome:
    return Outcome("unsupported", reason)


def limit(cpu_seconds: int, memory: int) -> None:
    resource.setrlimit(resource.RLIMIT_CPU, (cpu_seconds, cpu_seconds + 1))
    resource.setrlimit(resource.RLIMIT_AS, (memory, memory))
    resource.setrlimit(resource.RLIMIT_FSIZE, (0, 0))          # no file is written
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_NOFILE, (32, 32))
    try:
        resource.setrlimit(resource.RLIMIT_NPROC, (0, 0))     # no child processes
    except (ValueError, OSError):
        pass


# ------------------------------------------------------------------------------------------------------------ text
def decode_text(data: bytes) -> tuple[str, dict]:
    """Strict Unicode: UTF-8 (with or without a byte-order mark) or UTF-16 with one. Anything else is labelled, not
    guessed, so captured text never silently differs from the document."""
    for bom, encoding in ((codecs.BOM_UTF8, "utf-8"), (codecs.BOM_UTF16_LE, "utf-16-le"),
                          (codecs.BOM_UTF16_BE, "utf-16-be")):
        if data.startswith(bom):
            body, found = data[len(bom):], encoding
            break
    else:
        body, found = data, "utf-8"
    try:
        text = body.decode(found, "strict")
    except UnicodeDecodeError:
        raise unsupported("unknown_encoding") from None
    if "\x00" in text:
        raise unsupported("binary_content")
    return text, {"encoding": found, "bom": body is not data}


def extract_text(data: bytes) -> tuple[str, dict]:
    text, facts = decode_text(data)
    facts.update(lines=text.count("\n") + (1 if text and not text.endswith("\n") else 0), chars=len(text))
    return text, facts


def extract_csv(data: bytes) -> tuple[str, dict]:
    text, facts = decode_text(data)
    gaps: list[str] = []
    rows: list[list[str]] = []
    csv.field_size_limit(1 << 20)
    try:
        for row in csv.reader(io.StringIO(text, newline="")):
            if len(rows) >= MAX_TABLE_ROWS:
                gaps.append("table_rows_capped")
                break
            if len(row) > MAX_TABLE_COLS:
                gaps.append("table_columns_capped")
                row = row[:MAX_TABLE_COLS]
            rows.append(row)
    except csv.Error:
        rows, gaps = [], ["table_unparsed"]
    facts.update(chars=len(text), tables=[{"rows": rows}] if rows else [], gaps=sorted(set(gaps)))
    return text, facts


# ------------------------------------------------------------------------------------------------------------- pdf
def extract_pdf(data: bytes) -> tuple[str, dict]:
    if b"%PDF-" not in data[:1024]:
        raise quarantine("type_mismatch")
    from pypdf import PdfReader
    from pypdf.errors import PdfReadError

    try:
        reader = PdfReader(io.BytesIO(data), strict=False)
        if reader.is_encrypted:
            raise quarantine("encrypted")         # even an empty user password: the author restricted the file
        count = len(reader.pages)
        if count > MAX_PAGES:
            raise quarantine("too_many_pages")
        # Layout mode keeps mixed right-to-left and left-to-right lines in logical order and table columns aligned;
        # pypdf's plain mode reversed Arabic and dropped the start of such lines in the Unicode fixture.
        pages = [page.extract_text(extraction_mode="layout") or "" for page in reader.pages]
    except Outcome:
        raise
    except MemoryError:
        raise
    except (PdfReadError, ValueError, KeyError, TypeError, AttributeError, IndexError, RecursionError, OSError,
            AssertionError, NotImplementedError, UnicodeError, ZeroDivisionError):
        raise quarantine("corrupt") from None
    if not any(page.strip() for page in pages):
        raise unsupported("no_text_layer")       # a scan: Pulse does not OCR documents
    return "\f".join(pages), {"pages": count, "page_chars": [len(page) for page in pages], "layout": True}


# ------------------------------------------------------------------------------------------------------------ docx
def open_docx(data: bytes) -> zipfile.ZipFile:
    if data[:8] == b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1":
        raise quarantine("encrypted")            # a password-protected Word file is an OLE container, not a zip
    if not data.startswith(b"PK\x03\x04"):
        raise quarantine("type_mismatch")
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
        entries = archive.infolist()
    except (zipfile.BadZipFile, ValueError, OSError, EOFError):
        raise quarantine("corrupt") from None
    if len(entries) > MAX_ZIP_ENTRIES or sum(e.file_size for e in entries) > MAX_UNZIPPED:
        raise quarantine("hostile_archive")
    for entry in entries:
        if entry.file_size > 1024 * 1024 and entry.file_size > MAX_RATIO * max(entry.compress_size, 1):
            raise quarantine("hostile_archive")
        if entry.flag_bits & 0x1:
            raise quarantine("encrypted")
        name = entry.filename.lower()
        if name.endswith("vbaproject.bin") or name.endswith("vbadata.xml") or "/activex/" in name:
            raise quarantine("macro")
    return archive


def read_xml(archive: zipfile.ZipFile, name: str):
    import xml.etree.ElementTree as ET

    try:
        with archive.open(name) as part:
            raw = part.read(MAX_XML + 1)
    except KeyError:
        raise quarantine("corrupt") from None
    except (zipfile.BadZipFile, OSError, EOFError, ValueError):
        raise quarantine("corrupt") from None
    if len(raw) > MAX_XML:
        raise quarantine("hostile_archive")
    if b"<!DOCTYPE" in raw or b"<!ENTITY" in raw:
        raise quarantine("hostile_xml")          # Word never writes these; entity tricks are refused, not parsed
    try:
        return ET.fromstring(raw)
    except ET.ParseError:
        raise quarantine("corrupt") from None


def paragraph_text(p) -> str:
    out = []
    for el in p.iter():
        tag = el.tag
        if tag == f"{W}t":
            out.append(el.text or "")
        elif tag == f"{W}tab":
            out.append("\t")
        elif tag in (f"{W}br", f"{W}cr"):
            out.append("\n")
        elif tag == f"{W}noBreakHyphen":
            out.append("-")
    return "".join(out)


def heading_level(p) -> int | None:
    style = p.find(f"{W}pPr/{W}pStyle")
    value = (style.get(f"{W}val") if style is not None else "") or ""
    if value.lower() == "title":
        return 0
    if value.lower().startswith("heading") and value[7:].isdigit():
        return int(value[7:])
    return None


def blocks(parent, facts: dict, depth: int = 0) -> list[str]:
    """Paragraphs and tables in document order (content controls opened, deleted text left out)."""
    if depth > 16:
        raise quarantine("hostile_xml")
    lines: list[str] = []
    for el in parent:
        if el.tag == f"{W}p":
            text = paragraph_text(el)
            lines.append(text)
            facts["paragraphs"] += 1
            level = heading_level(el)
            if level is not None and text.strip():
                facts["headings"].append({"level": level, "text": text})
        elif el.tag == f"{W}tbl":
            rows = []
            for tr in el.findall(f"{W}tr"):
                cells = []
                for tc in tr.findall(f"{W}tc"):
                    inner = {"paragraphs": 0, "headings": [], "tables": facts["tables"]}
                    cells.append("\n".join(blocks(tc, inner, depth + 1)))
                rows.append(cells)
            facts["tables"].append({"rows": rows})
            lines.extend("\t".join(cells) for cells in rows)
        elif el.tag in (f"{W}sdt", f"{W}sdtContent", f"{W}customXml", f"{W}ins"):
            lines.extend(blocks(el, facts, depth + 1))
    return lines


def extract_docx(data: bytes) -> tuple[str, dict]:
    archive = open_docx(data)
    try:
        types = archive.open("[Content_Types].xml").read(MAX_XML + 1)
    except (KeyError, zipfile.BadZipFile, OSError, EOFError, ValueError):
        raise quarantine("corrupt") from None
    if b"macroenabled" in types.lower():
        raise quarantine("macro")
    root = read_xml(archive, "word/document.xml")
    body = root.find(f"{W}body")
    if body is None:
        raise quarantine("corrupt")
    facts: dict = {"paragraphs": 0, "headings": [], "tables": []}
    text = "\n".join(blocks(body, facts))
    facts["chars"] = len(text)
    facts["parts"] = ["body"]            # headers, footers, comments and notes are not captured
    return text, facts


# ------------------------------------------------------------------------------------------------------------ main
def run(kind: str, data: bytes, max_text: int) -> dict:
    extract = {"text": extract_text, "csv": extract_csv, "pdf": extract_pdf, "docx": extract_docx}[kind]
    try:
        text, facts = extract(data)
    except Outcome as outcome:
        return {"status": outcome.status, "reason": outcome.reason, "extractor": EXTRACTORS[kind]}
    if len(text) > max_text:
        return {"status": "quarantined", "reason": "output_limit", "extractor": EXTRACTORS[kind]}
    facts = {"format": kind, **facts}
    return {"status": "extracted", "text": text, "facts": facts, "extractor": EXTRACTORS[kind]}


def main(argv: list[str]) -> int:
    kind, max_input, max_text, cpu, memory = argv[0], int(argv[1]), int(argv[2]), int(argv[3]), int(argv[4])
    if kind not in EXTRACTORS:
        return 64
    if kind == "pdf":
        import pypdf  # noqa: F401  (imported before the limits so the open-file limit applies to the document only)
    import xml.etree.ElementTree  # noqa: F401
    logging.disable(logging.CRITICAL)                # parser warnings could quote document content
    limit(cpu, memory)
    data = sys.stdin.buffer.read(max_input + 1)
    if len(data) > max_input:
        result = {"status": "quarantined", "reason": "oversized", "extractor": EXTRACTORS[kind]}
    else:
        try:
            result = run(kind, data, max_text)
        except MemoryError:
            result = {"status": "quarantined", "reason": "extractor_limit", "extractor": EXTRACTORS[kind]}
        except RecursionError:
            result = {"status": "quarantined", "reason": "hostile_structure", "extractor": EXTRACTORS[kind]}
    sys.stdout.write(json.dumps(result, ensure_ascii=False))
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
