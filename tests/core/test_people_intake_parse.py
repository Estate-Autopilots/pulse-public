"""SELLER-ONBOARD: reading people's details out of what someone sends (tools/people_intake_parse.py), offline. Every name,
number and address here is invented."""
import importlib.util
import io
import os
import signal
import subprocess
import sys
import zipfile
from pathlib import Path

TOOLS = Path(__file__).resolve().parents[2] / "tools"
sys.path.insert(0, str(TOOLS))
spec = importlib.util.spec_from_file_location("people_intake_parse", TOOLS / "people_intake_parse.py")
P = importlib.util.module_from_spec(spec)
spec.loader.exec_module(P)

HEAD = "Full name\tMobile (WhatsApp)\tGmail\tRole\tActive? + joining date\tReports to\tCity / area\tLanguages\tAndroid? + model"


def rows(text, **kw):
    return P.finish(P.text_rows(text, **kw))


def codes(r):
    return {p["code"]: p["level"] for p in r["problems"]}


def test_rows_pasted_from_a_sheet_with_the_docs_headings():
    got = rows("\n".join([HEAD,
        "\t".join(["Ruvin Fictiv", "98765 43210", "user-b476a83c@gmail.com", "Sales executive", "Yes, 12 Aug 2025", "Priya Fictiv", "Pune: Kothrud, Warje", "Hindi, Marathi", "Yes, Redmi Note 12"]),
        "\t".join(["Priya Fictiv", "+91 90000 56789", "user-ad2f5670@gmail.com", "Team lead", "Yes 01/03/2024", "Asha Fictiv", "Pune", "Marathi/English", "Samsung A14"]),
        "Amit Fictiv\t9123456780\t\tSales exec\tNo\tPriya\tNashik\tHindi\tiPhone 12"]))
    assert [r["name"] for r in got] == ["Ruvin Fictiv", "Priya Fictiv", "Amit Fictiv"]
    a, b, c = got
    assert (a["phone"], a["email"], a["roleKey"], a["active"], a["joinedOn"]) == ("+91 98765 43210", "user-b476a83c@gmail.com", "sales_executive", True, "2025-08-12")
    assert (a["reportsTo"], a["area"], a["languages"], a["android"], a["model"]) == ("Priya Fictiv", "Pune: Kothrud, Warje", ["Hindi", "Marathi"], True, "Redmi Note 12")
    assert a["problems"] == []
    assert (b["roleKey"], b["joinedOn"], b["languages"], b["android"], b["model"]) == ("team_lead", "2024-03-01", ["Marathi", "English"], True, "Samsung A14")
    assert (c["active"], c["android"], c["email"]) == (False, False, None)
    assert codes(c) == {"no_email": "warn", "inactive": "info", "not_android": "info"}


def test_a_free_list_one_person_a_line():
    # The photo's typo is made from the address itself: the public mirror renames every address (and any domain it
    # does not know, such as gmai1.com), so a typo written out would no longer match its corrected form there.
    sidif = "user-c8093e3b@gmail.com"
    got = rows("1. Ruvin Fictiv - 9876543210 - user-b476a83c@gmail.com - Sales exec - Yes 12 Aug 2025 - Priya Fictiv - Kothrud Pune - Hindi Marathi - Redmi Note 12\n"
               f"2. SIDIF FICTIV, 90000 11122, {sidif.replace('@gmail.', '@gmai1.')}, TL, active since March 2024, Hadapsar, English, Android Vivo Y21")
    a, b = got
    assert (a["name"], a["reportsTo"], a["area"], a["languages"], a["model"]) == ("Ruvin Fictiv", "Priya Fictiv", "Kothrud Pune", ["Hindi", "Marathi"], "Redmi Note 12")
    assert (b["name"], b["roleKey"], b["active"], b["joinedOn"], b["area"], b["model"]) == ("Sidif Fictiv", "team_lead", True, "2024-03-01", "Hadapsar", "Vivo Y21")
    # A photo's "gmai1" is read as gmail.com, and said.
    assert b["email"] == sidif and codes(b)["email_check"] == "warn"


def test_name_colon_blocks_and_a_person_over_several_lines():
    got = rows("Name: Ruvin Fictiv\nMobile: 98765 43210\nGmail: user-b476a83c@gmail.com\nRole: Sales Executive\nActive: Yes\nJoining: 12/08/2025\n"
               "Reports to: Priya\nArea: Kothrud\nLanguages: Hindi, Marathi\nPhone: Android Redmi Note 12\n\nName: Sidif Fictiv\nMobile: 9000011122\nGmail: user-190b9b23@gmail.com")
    assert [(r["name"], r["phone"], r["email"]) for r in got] == [("Ruvin Fictiv", "+91 98765 43210", "user-b476a83c@gmail.com"), ("Sidif Fictiv", "+91 90000 11122", "user-190b9b23@gmail.com")]
    assert (got[0]["android"], got[0]["model"], got[0]["reportsTo"]) == (True, "Redmi Note 12", "Priya")
    stacked = rows("\n".join(["Ruvin Fictiv", "9876543210", "user-b476a83c@gmail.com", "", "Sidif Fictiv", "9000011122"]))
    assert [(r["name"], r["phone"]) for r in stacked] == [("Ruvin Fictiv", "+91 98765 43210"), ("Sidif Fictiv", "+91 90000 11122")]


def test_plain_talk_is_not_a_list():
    for text in ["ok bhai kal tak bhejta hu", "Sure, will collect by Wednesday 👍", "Call me at 5", "Thanks!"]:
        assert not P.has_people(rows(text)), text


def test_a_photos_words_keep_their_columns():
    got = rows("Ruvin Fictiv   9876543210   user-b476a83c@gmail.com   Sales exec   Yes\nSidif Fictiv   9000011122   user-c8093e3b@gmail.com   TL   Yes", ocr=True)
    assert [(r["name"], r["roleKey"], r["active"]) for r in got] == [("Ruvin Fictiv", "sales_executive", True), ("Sidif Fictiv", "team_lead", True)]


def test_a_repeated_number_or_gmail_is_not_added_twice():
    got = rows("Ruvin Fictiv, 9876543210, user-b476a83c@gmail.com, SE\nRuvin F, 98765 43210, user-fad257a0@gmail.com, SE\nAsha Fictiv, 9000056789, user-b476a83c@gmail.com, SE")
    assert "duplicate_phone" not in codes(got[0])
    assert codes(got[1])["duplicate_phone"] == "block" and codes(got[2])["duplicate_email"] == "block"


def test_numbers_dates_phones_languages_and_roles():
    assert P.phone_of("09876543210")[0] == P.phone_of("919876543210")[0] == P.phone_of("+91-98765-43210")[0] == "+91 98765 43210"
    assert P.phone_of("98765 4321") == (None, "check the number “98765 4321” (9 digits)")
    assert P.phone_of("+44 7700 900123")[0] == "+447700900123"
    for raw, want in [("12/08/2025", "2025-08-12"), ("12 Aug 2025", "2025-08-12"), ("Aug 2025", "2025-08-01"), ("2025-08-12", "2025-08-12"),
                      ("12-8-25", "2025-08-12"), ("45881", "2025-08-12"), ("sometime", None), ("31/02/2025", None)]:
        assert P.date_of(raw) == want, raw
    assert P.android_of("Yes, Redmi Note 12") == (True, "Redmi Note 12")
    assert P.android_of("Samsung A14") == (True, "Samsung A14")
    assert P.android_of("iPhone 13")[0] is False and P.android_of("No") == (False, None) and P.android_of("")[0] is None
    assert P.languages_of("Hindi/Marathi") == ["Hindi", "Marathi"] and P.languages_of("हिंदी, मराठी") == ["Hindi", "Marathi"]
    assert P.languages_of("English and Gujarati") == ["English", "Gujarati"]
    assert [P.role_of(x)[0] for x in ["TL", "ASM", "Owner", "Telecaller", "Sales Executive", "Accountant"]] == ["team_lead", "manager", "owner_admin", "sales_executive", "sales_executive", None]
    assert P.email_of("user-b476a83c@GMAIL.COM") == ("user-b476a83c@gmail.com", None)
    assert codes(rows("Ruvin Fictiv, 9876543210, ruvin@company.example")[0])["not_gmail"] == "info"


def test_the_docs_table_and_not_its_example_table():
    html = ("<p>Why</p><h2>The 9 details</h2><table><thead><tr><th>#</th><th>Detail</th><th>Example</th></tr></thead><tbody>"
            "<tr><td>1</td><td>Full name</td><td>Example Fictiv</td></tr><tr><td>2</td><td>Mobile number (WhatsApp)</td><td>+91 98765 43210</td></tr></tbody></table>"
            "<h2>Sellers</h2><table><thead><tr>" + "".join(f"<th>{h}</th>" for h in HEAD.split("\t")) + "</tr></thead><tbody>"
            "<tr><td>Ruvin Fictiv</td><td>9876543210</td><td>user-b476a83c@gmail.com</td><td>Sales executive</td><td>Yes, 12 Aug 2025</td><td>Asha Fictiv</td><td>Kothrud</td><td>Hindi</td><td>Yes, Redmi 12</td></tr>"
            + "<tr>" + "<td></td>" * 9 + "</tr>" * 3 + "</tbody></table>")
    got = P.finish(P.doc_rows(html))
    assert [(r["name"], r["phone"], r["reportsTo"], r["model"]) for r in got] == [("Ruvin Fictiv", "+91 98765 43210", "Asha Fictiv", "Redmi 12")]
    assert P.doc_rows("<h2>Sellers</h2><table><tr><th>Full name</th><th>Mobile (WhatsApp)</th><th>Gmail</th><th>Role</th></tr>" + "<tr><td></td><td></td><td></td><td></td></tr>" * 4 + "</table>") == []


def _xlsx(rows_):
    """A minimal workbook as Excel writes it: shared strings for text, numbers as numbers (a phone 9876543210, a date
    as its day number)."""
    strings, sheet = [], []
    for i, r in enumerate(rows_, 1):
        cells = []
        for j, v in enumerate(r):
            ref = f"{chr(65 + j)}{i}"
            if isinstance(v, (int, float)):
                cells.append(f'<c r="{ref}"><v>{v}</v></c>')
            else:
                strings.append(v)
                cells.append(f'<c r="{ref}" t="s"><v>{len(strings) - 1}</v></c>')
        sheet.append(f'<row r="{i}">{"".join(cells)}</row>')
    ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("xl/workbook.xml", f'<workbook {ns} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sellers" sheetId="1" r:id="rId1"/></sheets></workbook>')
        z.writestr("xl/_rels/workbook.xml.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>')
        z.writestr("xl/sharedStrings.xml", f'<sst {ns}>' + "".join(f"<si><t>{s}</t></si>" for s in strings) + "</sst>")
        z.writestr("xl/worksheets/sheet1.xml", f'<worksheet {ns}><sheetData>{"".join(sheet)}</sheetData></worksheet>')
    return buf.getvalue()


def test_an_excel_file_and_a_csv_file():
    data = _xlsx([["Name", "Mobile", "Gmail", "Designation", "Active", "DOJ", "Android"],
                  ["Ruvin Fictiv", 9876543210, "user-b476a83c@gmail.com", "Sales Executive", "Yes", 45881, "Redmi Note 12"],
                  ["Asha Fictiv", 9.12345678E9, "user-9cca33b8@gmail.com", "Manager", "Yes", 45000, "No"]])
    got = P.finish(P.table_rows(P.xlsx_cells(data)))
    assert [(r["name"], r["phone"], r["joinedOn"], r["roleKey"], r["android"]) for r in got] == [
        ("Ruvin Fictiv", "+91 98765 43210", "2025-08-12", "sales_executive", True), ("Asha Fictiv", "+91 91234 56780", "2023-03-15", "manager", False)]
    csv_bytes = "﻿Name;Phone;Email;Role\nRuvin Fictiv;9876543210;user-b476a83c@gmail.com;SE\n".encode("utf-8")
    assert [(r["name"], r["email"]) for r in P.finish(P.csv_rows(csv_bytes))] == [("Ruvin Fictiv", "user-b476a83c@gmail.com")]


def test_a_line_whose_columns_ran_together():
    assert P.explode("Kedab Synthetic 9000012345 user-a1d45e86@gmail.com Sales exec Yes") == [
        "Kedab Synthetic", "9000012345", "user-a1d45e86@gmail.com", "Sales exec", "Yes"]
    assert P.explode("active since March 2024") == ["active since March 2024"]


def _worker():
    spec_w = importlib.util.spec_from_file_location("people_intake_worker", TOOLS / "people-intake.py")
    worker = importlib.util.module_from_spec(spec_w)
    spec_w.loader.exec_module(worker)
    return worker


def test_a_photo_it_cannot_read_is_said_and_a_voice_note_passed_by():
    w = _worker()
    assert w.read_file("list.heic", "image/heic", b"\0" * 64) == ("photo", [], "list.heic: this kind of photo is not read. Send a screenshot of it or a JPG photo")
    assert w.read_file("voice.webm", "audio/webm", b"\0" * 64) == (None, [], None)


def test_the_worker_stops_cleanly():
    import pytest
    w = _worker()
    # During a poll a stop waits for the poll to end; between polls it ends the worker with 0.
    w.RUN.update(busy=True, stop=False)
    w._on_stop(signal.SIGTERM, None)
    assert w.RUN["stop"] is True
    w.RUN["busy"] = False
    with pytest.raises(SystemExit) as stopped:
        w._on_stop(signal.SIGTERM, None)
    assert stopped.value.code == 0
    # As each release stops it: waiting (here for a database that is not there), a SIGTERM ends it with 0, not 143.
    env = {**os.environ, "PULSE_DATABASE_URL_WORKER": "postgresql:///none?host=/nonexistent-pulse-socket&connect_timeout=2"}
    run = subprocess.Popen([sys.executable, str(TOOLS / "people-intake.py")], env=env, stderr=subprocess.PIPE, text=True)
    try:
        said = run.stderr.readline()  # one line, though psycopg's message has several
        assert said.startswith("20") and " database: " in said and said.rstrip().endswith("again in 60 s"), said
        run.send_signal(signal.SIGTERM)
        assert run.wait(timeout=10) == 0
    finally:
        if run.poll() is None:
            run.kill()


def test_a_photo_of_a_list_is_read_on_this_server():
    import shutil
    import pytest
    if not shutil.which("tesseract"):
        pytest.skip("tesseract is not installed here (the server that runs tools/people-intake.py has it)")
    worker = _worker()
    kind, raws, note = worker.read_file("list.png", "image/png", (Path(__file__).parent / "fixtures" / "people-intake-list.png").read_bytes())
    got = P.finish(raws)
    assert kind == "photo" and note is None
    assert [(r["name"], r["phone"], r["email"], r["roleKey"], r["active"]) for r in got] == [
        ("Kedab Synthetic", "+91 90000 12345", "user-a1d45e86@gmail.com", "sales_executive", True),
        ("Meera Synthetic", "+91 90000 98765", "user-62d73452@gmail.com", "team_lead", True)]
