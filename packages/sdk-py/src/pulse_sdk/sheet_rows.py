"""Indexed spreadsheet transport: quote pipes, retain blanks and preserve rows as CSV.

Marker allows readers to choose the exact parser. Legacy collapsed text stays explicitly legacy.
"""

import csv
import io
from itertools import chain, islice

MARKER = " [csv-v1]"


def workbook_text(data, text_cap=2_000_000, *, csv_leads_only=False):
    import openpyxl

    wb = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    chunks = []
    total = 0
    try:
        for ws in wb.worksheets:
            stream = io.StringIO()
            writer = csv.writer(stream, lineterminator="\n")
            source = ws.iter_rows(values_only=True)
            preview = list(islice(source, 10))
            lead_sheet = any(str(v).strip().lower() in {"created_time", "campaign_name", "ad_name"}
                             for row in preview for v in row if v is not None)
            quoted = not csv_leads_only or lead_sheet
            for i, row in enumerate(chain(preview, source)):
                if i >= 5000 or total + stream.tell() > text_cap:
                    break
                # Blanks never disappear; delimiters and multiline notes are CSV-quoted.
                if quoted:
                    writer.writerow(["" if v is None else str(v) for v in row])
                else:
                    cells = [str(v) for v in row if v not in (None, "")]
                    if cells:
                        stream.write(" | ".join(cells) + "\n")
            chunks.append(f"## {ws.title}{MARKER if quoted else ''}\n{stream.getvalue()}")
            total += stream.tell()
    finally:
        wb.close()
    return "\n".join(chunks)


def tables(body):
    lines = body.splitlines(keepends=True)
    i = 0
    while i < len(lines):
        if not lines[i].startswith("## "):
            i += 1
            continue
        heading = lines[i].strip()
        i += 1
        end = len(lines)
        quoted = False
        for j in range(i, len(lines)):
            if not quoted and lines[j].startswith("## "):
                end = j
                break
            if heading.endswith(MARKER) and lines[j].count('"') % 2:
                quoted = not quoted
        block = lines[i:end]
        i = end
        if heading.endswith(MARKER):
            yield heading[3 : -len(MARKER)], list(csv.reader(io.StringIO("".join(block)))), "csv-v1"
        else:
            yield heading[3:], [line.strip().split(" | ") for line in block if line.strip()], "legacy-collapsed"
