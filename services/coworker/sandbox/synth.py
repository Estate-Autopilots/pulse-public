"""FIN-AGENT: synthetic bank statements for tests and the dummy company (no real names, accounts or figures).

  python synth.py <dir> [--large N]

Writes one file per layout: HDFC (CSV with a bank preamble, narrations that run over lines), ICICI (.xlsx), SBI (CSV),
Axis (CSV with "Dr/Cr"), Kotak (amount + Dr/Cr column), a text PDF, a broken export the standard importer cannot take
(header on row 23, amounts written "1,234.00 Dr", a page break in the middle), and optionally a large CSV. Every
company name is invented (Northwind, Lotus, Synthetic …); account numbers are EXMP placeholders.
"""

from __future__ import annotations

import csv
import random
import sys
from datetime import date, timedelta
from pathlib import Path

VENDORS = [
    ("UPI/P2M/{ref}/FACEBOOK ADS/synthetic.meta@okaxis", "out", (150000, 2500000)),
    ("NEFT-EXMP0000123-{ref}-GOOGLE ADS INDIA", "out", (500000, 3000000)),
    ("ACH D- ZOHO CORPORATION-{ref}", "out", (99900, 299900)),
    ("POS 4123XXXXXXXX1234 SWIGGY", "out", (25000, 180000)),
    ("NEFT-EXMP0000999-{ref}-LOTUS PROPERTIES RENT", "out", (4500000, 4500000)),
    ("UPI/{ref}/MSEDCL ELECTRICITY/synthetic.power@ybl", "out", (300000, 900000)),
    ("GST PAYMENT CPIN {ref}", "out", (1000000, 6000000)),
    ("IMPS/P2A/{ref}/RAVI SYNTHETIC/FREELANCE", "out", (500000, 4000000)),
    ("UPI/{ref}/KAVYA STUDIO SHOOT/synthetic.kavya@okicici", "out", (1500000, 6000000)),
    ("CONSOLIDATED CHARGES FOR A/C", "out", (11800, 59000)),
    ("NEFT-EXMP0000456-{ref}-NORTHWIND DEVELOPERS PVT LTD", "in", (5900000, 23600000)),
    ("RTGS-EXMP0000789-{ref}-ORBIT REALTY LLP", "in", (11800000, 47200000)),
    ("UPI/{ref}/GREEN VALLEY HOMES/gvh@okhdfc", "in", (2360000, 11800000)),
    ("INT.PD:01-03-2026 TO 31-03-2026", "in", (1200, 9000)),
    ("UPI/{ref}/MYSTERY TRADERS/synthetic.mt@ybl", "out", (777700, 777700)),
]


def lines(n: int, start: date, seed: int, opening: int = 50_000_000):
    rnd = random.Random(seed)
    bal = opening
    day = start
    out = []
    for i in range(n):
        if rnd.random() < 0.35:
            day += timedelta(days=1)
        text, side, (lo, hi) = rnd.choice(VENDORS)
        amt = rnd.randrange(lo, hi + 1, 100) if hi > lo else lo
        if (
            seed == 1 and i == 3
        ):  # Northwind pays its open invoice INV-0101 (₹59,000) in full
            text, side, amt = VENDORS[10][0], "in", 5_900_000
        ref = f"{rnd.randrange(10**11, 10**12)}"
        bal += amt if side == "in" else -amt
        out.append(
            {
                "date": day,
                "text": text.format(ref=ref),
                "side": side,
                "amount": amt,
                "balance": bal,
                "ref": ref,
            }
        )
    return out


def rs(minor: int) -> str:
    return f"{minor / 100:,.2f}"


def hdfc(path: Path, rows):
    with path.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["HDFC BANK Ltd.", "", "", "", "", "", ""])
        w.writerow(["Statement of account", "", "", "", "", "", ""])
        w.writerow(["Account No :", "EXMP0001234", "", "", "", "", ""])
        w.writerow(["", "", "", "", "", "", ""])
        w.writerow(
            [
                "Date",
                "Narration",
                "Chq./Ref.No.",
                "Value Dt",
                "Withdrawal Amt.",
                "Deposit Amt.",
                "Closing Balance",
            ]
        )
        for r in rows:
            d = r["date"].strftime("%d/%m/%y")
            text = r["text"]
            first, rest = (text[:30], text[30:]) if len(text) > 34 else (text, "")
            w.writerow(
                [
                    d,
                    first,
                    r["ref"][-10:],
                    d,
                    rs(r["amount"]) if r["side"] == "out" else "",
                    rs(r["amount"]) if r["side"] == "in" else "",
                    rs(r["balance"]),
                ]
            )
            if rest:
                w.writerow(["", rest, "", "", "", "", ""])


def icici(path: Path, rows):
    from openpyxl import Workbook

    wb = Workbook()
    ws = wb.active
    ws.title = "OpTransactionHistory"
    ws.append(["DETAILED STATEMENT"])
    ws.append(["Account Number", "EXMP0005678"])
    ws.append([])
    ws.append(
        [
            "S No.",
            "Value Date",
            "Transaction Date",
            "Cheque Number",
            "Transaction Remarks",
            "Withdrawal Amount (INR )",
            "Deposit Amount (INR )",
            "Balance (INR )",
        ]
    )
    for i, r in enumerate(rows, 1):
        d = r["date"].strftime("%d/%m/%Y")
        ws.append(
            [
                i,
                d,
                d,
                "-",
                r["text"],
                r["amount"] / 100 if r["side"] == "out" else 0,
                r["amount"] / 100 if r["side"] == "in" else 0,
                r["balance"] / 100,
            ]
        )
    wb.save(path)


def sbi(path: Path, rows):
    with path.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(
            [
                "Txn Date",
                "Value Date",
                "Description",
                "Ref No./Cheque No.",
                "Debit",
                "Credit",
                "Balance",
            ]
        )
        for r in rows:
            d = r["date"].strftime("%d %b %Y")
            w.writerow(
                [
                    d,
                    d,
                    r["text"],
                    r["ref"],
                    rs(r["amount"]) if r["side"] == "out" else " ",
                    rs(r["amount"]) if r["side"] == "in" else " ",
                    rs(r["balance"]),
                ]
            )


def axis(path: Path, rows):
    with path.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Tran Date", "CHQNO", "PARTICULARS", "DR", "CR", "BAL", "SOL"])
        for r in rows:
            d = r["date"].strftime("%d-%m-%Y")
            w.writerow(
                [
                    d,
                    "",
                    r["text"].replace("-", "/"),
                    rs(r["amount"]) if r["side"] == "out" else "",
                    rs(r["amount"]) if r["side"] == "in" else "",
                    rs(r["balance"]),
                    "1234",
                ]
            )


def kotak(path: Path, rows):
    with path.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(
            [
                "Sl. No.",
                "Transaction Date",
                "Value Date",
                "Description",
                "Chq / Ref No.",
                "Amount",
                "Dr / Cr",
                "Balance",
                "Dr / Cr",
            ]
        )
        for i, r in enumerate(rows, 1):
            d = r["date"].strftime("%d-%m-%Y")
            w.writerow(
                [
                    i,
                    d,
                    d,
                    r["text"],
                    r["ref"],
                    rs(r["amount"]),
                    "DR" if r["side"] == "out" else "CR",
                    rs(r["balance"]),
                    "CR",
                ]
            )


def broken(path: Path, rows):
    """What made the standard import fail: a long preamble, amounts with Dr/Cr written after them, a repeated header at a
    page break, totals lines, and a summary block at the end."""
    with path.open("w", newline="") as f:
        w = csv.writer(f)
        for i in range(22):
            w.writerow(
                [f"Synthetic Co-operative Bank · statement line {i}", "", "", ""]
            )
        w.writerow(["Tran Date", "Particulars", "Amount (Rs.)", "Balance (Rs.)"])
        for i, r in enumerate(rows):
            if i == len(rows) // 2:
                w.writerow(["Page 2 of 2", "", "", ""])
                w.writerow(
                    ["Tran Date", "Particulars", "Amount (Rs.)", "Balance (Rs.)"]
                )
            w.writerow(
                [
                    r["date"].strftime("%d-%b-%Y"),
                    r["text"],
                    rs(r["amount"]) + (" Dr" if r["side"] == "out" else " Cr"),
                    rs(r["balance"]) + " Cr",
                ]
            )
        w.writerow(["", "TOTAL", "", ""])
        w.writerow(["Closing balance", "", "", rs(rows[-1]["balance"])])


def pdf(path: Path, rows):
    text = [
        "SYNTHETIC BANK LIMITED  Account EXMP0009999",
        "Date        Narration                          Withdrawal     Deposit      Balance",
    ]
    for r in rows:
        amt = rs(r["amount"])
        text.append(
            f"{r['date'].strftime('%d/%m/%Y')}  {r['text'][:40]}  {amt if r['side'] == 'out' else ''}  {amt if r['side'] == 'in' else ''}  {rs(r['balance'])}"
        )
    lines_ = [
        t.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)") for t in text
    ]
    stream = (
        "BT /F1 8 Tf 30 760 Td "
        + " ".join(f"({x}) Tj 0 -11 Td" for x in lines_)
        + " ET"
    ).encode()
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>",
        b"<< /Length "
        + str(len(stream)).encode()
        + b" >>\nstream\n"
        + stream
        + b"\nendstream",
    ]
    output, offsets = b"%PDF-1.4\n", [0]
    for i, obj in enumerate(objects, 1):
        offsets.append(len(output))
        output += f"{i} 0 obj\n".encode() + obj + b"\nendobj\n"
    start = len(output)
    output += b"xref\n0 6\n0000000000 65535 f \n" + b"".join(
        f"{n:010d} 00000 n \n".encode() for n in offsets[1:]
    )
    path.write_bytes(
        output
        + f"trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{start}\n%%EOF\n".encode()
    )


def large(path: Path, n: int):
    rnd = random.Random(7)
    bal = 10**10
    day = date(2023, 4, 1)
    with path.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(
            [
                "Date",
                "Narration",
                "Chq./Ref.No.",
                "Value Dt",
                "Withdrawal Amt.",
                "Deposit Amt.",
                "Closing Balance",
            ]
        )
        for i in range(n):
            if i % 900 == 0:
                day += timedelta(days=1)
            text, side, (lo, hi) = VENDORS[rnd.randrange(len(VENDORS))]
            amt = rnd.randrange(lo, hi + 1, 100) if hi > lo else lo
            ref = str(10**11 + i)
            bal += amt if side == "in" else -amt
            d = day.strftime("%d/%m/%y")
            w.writerow(
                [
                    d,
                    text.format(ref=ref),
                    ref[-10:],
                    d,
                    rs(amt) if side == "out" else "",
                    rs(amt) if side == "in" else "",
                    rs(bal),
                ]
            )


def write_all(target: Path, large_n: int = 0) -> dict:
    target.mkdir(parents=True, exist_ok=True)
    base = lines(240, date(2026, 4, 1), 1)
    files = {
        "hdfc-EXMP1234-apr-jun-2026.csv": lambda p: hdfc(p, base[:160]),
        "hdfc-EXMP1234-may-jul-2026.csv": lambda p: hdfc(
            p, base[80:]
        ),  # overlaps the first: duplicates to drop
        "icici-EXMP5678-2026.xlsx": lambda p: icici(p, lines(120, date(2026, 4, 1), 2)),
        "sbi-EXMP4321-2026.csv": lambda p: sbi(p, lines(90, date(2026, 4, 3), 3)),
        "axis-EXMP8765-2026.csv": lambda p: axis(p, lines(90, date(2026, 5, 1), 4)),
        "kotak-EXMP2468-2026.csv": lambda p: kotak(p, lines(60, date(2026, 6, 1), 5)),
        "broken-coop-EXMP1357.csv": lambda p: broken(p, lines(80, date(2026, 4, 1), 6)),
        "synthetic-bank-EXMP9999.pdf": lambda p: pdf(p, lines(30, date(2026, 8, 1), 8)),
    }
    for name, fn in files.items():
        fn(target / name)
    if large_n:
        large(target / f"large-EXMP0000-{large_n}.csv", large_n)
    return {"files": sorted(p.name for p in target.iterdir())}


if __name__ == "__main__":
    n = int(sys.argv[sys.argv.index("--large") + 1]) if "--large" in sys.argv else 0
    print(write_all(Path(sys.argv[1]), n))
