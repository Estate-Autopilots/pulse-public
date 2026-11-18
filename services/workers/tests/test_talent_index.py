# ruff: noqa: E501  (synthetic rows kept on one line each)
"""R55 talent index: reading the shoot coordinator's sheets, resolving how a model's name is written, merging shoots with
pay lines, and linking a shoot to its project and place. Synthetic names, places and figures only."""
import uuid
from datetime import date, datetime

import openpyxl

from pulse_workers.talent_index import (
    Model,
    Place,
    Project,
    Roster,
    build,
    clean,
    dated_names,
    find_place,
    match_project,
    read_pay_tracker,
    read_shoot_sheet,
    split_models,
    tab_month,
)

META = {"id": "synthetic-file-1234567890", "name": "Model & Cinematographer Pay Tracker ", "modified": date(2026, 10, 11)}


def workbook(tabs):
    wb = openpyxl.Workbook()
    wb.remove(wb.active)
    for title, rows in tabs.items():
        ws = wb.create_sheet(title)
        for row in rows:
            ws.append(row)
    return wb


def test_model_cells_and_tab_months():
    assert split_models("Omoza & Sobuha") == ["omoza", "sobuha"]
    assert split_models("Varedi (2duet)") == ["varedi"]
    assert split_models("Retir male") == ["retir"]
    assert split_models("0") == [] and split_models("Drone") == [] and split_models("-") == [] and split_models("Child Artist") == []
    assert clean("Sobuha O.") == "sobuha o"
    assert tab_month("Sep 26", None) == date(2026, 9, 1)
    assert tab_month("August 25", None) == date(2025, 8, 1)
    # Without a year: the latest such month not after the file's last change.
    assert tab_month("Oct Shoot", date(2026, 10, 11)) == date(2026, 10, 1)
    assert tab_month("Dec shoot", date(2026, 10, 11)) == date(2025, 12, 1)
    assert tab_month("Sheet17", date(2026, 10, 11)) is None


def test_pay_tracker_rows_keep_fees_apart_and_ignore_counts_as_places():
    header = ["Shoot Date ", "Model Name ", "cinematographer", "Scripts ", "Locations", "Modeling Charges", "Travel Expenses ", "Extra Payables ",
              "Total Payable Amount", "Note", "Payment Status", "Paid By"]
    old = ["Shoot Date ", "Model Name ", "Scripts ", "Locations", "Modeling Charges", "Travel Expenses ", "Extra Payables ", "Total Payable Amount",
           "Note", "Payment Status", "Paid By"]
    wb = workbook({
        "Sep 26": [[None], [None, "Model Payment Detials "], [None], header,
                   [datetime(2026, 9, 1), "Asha", "Ravi K, Dev T", 2.0, "Hill Road", 4000.0, 380.0, "-", 4380.0, None, "Paid", None],
                   [datetime(2026, 9, 2), "Mira & Asha", "Ravi K", 1.0, "River Side", 6000.0, None, None, 6000.0, None, "Paid", None],
                   [datetime(2026, 9, 3), None, None, None, None, None, None, None, "0", None, None, None],
                   [datetime(206, 9, 4), "Asha", None, 1.0, "Typo Year", 100.0, None, None, 100.0, None, None, None]],
        "Dec 25": [old, [datetime(2025, 12, 1), "Mira R", 3.0, 3.0, 9000.0, 500.0, None, 9500.0, None, "Paid", "Current account"]],
    })
    rows = read_pay_tracker(wb, META)
    assert [(r["day"], r["names"]) for r in rows] == [(date(2026, 9, 1), ["asha"]), (date(2026, 9, 2), ["mira", "asha"]), (date(2025, 12, 1), ["mira r"])]
    first = rows[0]
    assert first["crew"] == ["ravi k", "dev t"] and first["scripts"] == 2.0 and first["place"] == "Hill Road"
    assert (first["charges"], first["travel"], first["extra"], first["total"]) == (4000.0, 380.0, None, 4380.0)
    assert rows[2]["place"] is None   # an old tab keeps a count of locations in that column, not a place
    assert rows[0]["source"] == {"type": "sheet", "fileId": META["id"], "file": "Model & Cinematographer Pay Tracker", "sheet": "Sep 26", "row": 5}


def test_shoot_sheet_rows_read_days_written_as_words():
    meta = {**META, "name": "shoot Details", "modified": date(2026, 10, 11)}
    header = ["Client", "Segments", "Deliverables", "Status", "Model", "Language", "Script", "Location", "Date of Shoot", "Note"]
    wb = workbook({"Sep shoot": [header,
                                 ["Lakeview | Northstar Group | Riverside", "Lux Resd", "Model-Led Video Ads #1 - shoot completed", "Done", "Asha", "Hindi", "Ready", "River Side", "2wednesday", None],
                                 ["Hillcrest", "Drone shoot", "Done", None, None, None, None, None, "9th friday", None],
                                 ["Parkside", "Mid Resd", "Client testimonial", "Inprogress", "Mira", "Marathi", "Ready", "Hill Road", datetime(2026, 9, 18), None]]})
    rows = read_shoot_sheet(wb, meta)
    assert [(r["client"], r["day"], r["names"]) for r in rows] == [("Lakeview | Northstar Group | Riverside", date(2026, 9, 2), ["asha"]),
                                                                    ("Parkside", date(2026, 9, 18), ["mira"])]
    assert rows[0]["language"] == "Hindi" and rows[0]["deliverable"].startswith("Model-Led")


def _roster():
    ids = {n: uuid.uuid4() for n in ("Asha Rao", "Asha", "Mira Shah", "Mira Sen", "Nina Kale", "Dina")}
    models = [Model(ids["Asha Rao"], "Asha Rao", "asha rao", roster=True), Model(ids["Asha"], "Asha", "asha"),
              Model(ids["Mira Shah"], "Mira Shah", "mira shah"), Model(ids["Mira Sen"], "Mira Sen", "mira sen"),
              Model(ids["Nina Kale"], "Nina Kale", "nina kale"), Model(ids["Dina"], "Dina", "dina")]
    return ids, Roster(models)


def test_names_link_only_when_one_model_fits():
    ids, roster = _roster()
    assert roster.resolve("asha rao").person_id == ids["Asha Rao"] and roster.resolve("asha rao").basis == "exact"
    assert roster.resolve("aasha rao").basis == "variant" and roster.resolve("aasha rao").person_id == ids["Asha Rao"]
    assert roster.resolve("asha r").person_id == ids["Asha Rao"]          # an initial for the surname
    first = roster.resolve("asha")                                       # the full-name model, not the one-word duplicate
    assert first.person_id == ids["Asha Rao"] and first.basis == "first_name"
    assert roster.resolve("nina").person_id == ids["Nina Kale"]
    shared = roster.resolve("mira")                                       # two models named Mira, no evidence for either
    assert shared.person_id is None and shared.basis == "review" and set(shared.candidates) == {ids["Mira Shah"], ids["Mira Sen"]}
    # Evidence decides between them: the full name written in the sheets.
    roster.seen_full["mira sen"] = 2
    leaning = roster.resolve("mira")
    assert leaning.person_id == ids["Mira Sen"] and leaning.confidence < 0.8 and len(leaning.candidates) == 2
    assert roster.resolve("dina").person_id == ids["Dina"]                 # a one-word contact and nothing fuller
    assert roster.resolve("nida").basis == "new"                           # a different first letter is someone else
    assert roster.resolve("zoya").basis == "new"


def test_pay_lines_join_the_shoot_of_the_same_model_and_day():
    ids, roster = _roster()
    src = {"type": "sheet", "fileId": "synthetic-file-1234567890", "sheet": "Sep 26"}
    shoots = [{"names": ["asha"], "written": "Asha", "client": "Lakeview", "day": date(2026, 9, 2), "month": date(2026, 9, 1), "segment": "Lux Resd",
               "deliverable": "Model-Led Video Ads #1", "status": "Done", "language": "Hindi", "place": "River Side", "source": {**src, "row": 2}},
              {"names": ["asha"], "written": "Asha", "client": "Parkside", "day": date(2026, 9, 2), "month": date(2026, 9, 1), "segment": None,
               "deliverable": None, "status": "Done", "language": None, "place": None, "source": {**src, "row": 3}}]
    pay = [{"names": ["asha"], "written": "Asha", "day": date(2026, 9, 2), "month": date(2026, 9, 1), "crew": ["ravi k"], "scripts": 2.0, "place": "River Side",
            "charges": 4000.0, "travel": 400.0, "extra": None, "total": 4400.0, "paid": "Paid", "source": {**src, "row": 7}},
           {"names": ["mira", "nina"], "written": "Mira & Nina", "day": date(2026, 9, 5), "month": date(2026, 9, 1), "crew": [], "scripts": 1.0, "place": None,
            "charges": 6000.0, "travel": None, "extra": None, "total": 6000.0, "paid": "Paid", "source": {**src, "row": 8}}]
    out = build(pay, shoots, roster, {})
    assert len(out["shoots"]) == 4            # two shoots that day for two clients, and the pair's line split in two
    merged = [s for s in out["shoots"] if "pay_tracker" in s["sources"] and "shoot_sheet" in s["sources"]]
    assert len(merged) == 2 and all(s["person_id"] == ids["Asha Rao"] and s["scripts"] == 1.0 and s["crew"] == ["ravi k"] for s in merged)
    fee = next(f for f in out["fees"] if f["alias"] == "asha")
    assert fee["total"] == 4400.0 and sorted(fee["shoot_keys"]) == sorted(s["source_key"] for s in merged)
    pair = [f for f in out["fees"] if f["shoot_on"] == date(2026, 9, 5)]
    assert sorted(f["total"] for f in pair) == [3000.0, 3000.0]       # a pair shares one line
    assert out["aliases"]["mira"]["status"] == "review" and out["aliases"]["asha"]["status"] == "auto"
    # A decision taken in Review data wins on the next run.
    decided = build(pay, shoots, roster, {"alias:mira": {"status": "accepted", "chosen": str(ids["Mira Shah"])}})
    assert decided["aliases"]["mira"]["status"] == "confirmed" and all(s["person_id"] == ids["Mira Shah"] for s in decided["shoots"] if s["alias"] == "mira")


def test_a_shoot_links_to_its_project_or_waits_for_review():
    lake, lake_old, park, hill = (uuid.uuid4() for _ in range(4))
    projects = [Project(lake, "Lakeview", "#3 - Lakeview | Mr. Asha Client | Riverside | Aug 2026 | R", "Riverside", date(2026, 8, 1), "Northstar Group"),
                Project(lake_old, "Lakeview", "#9 - Lakeview | Riverside | Jan 2025 | R", "Riverside", date(2025, 1, 1), "Northstar Group"),
                Project(park, "Parkside Towers", "#1 - Parkside Towers | Hill Road | Sep 2026 | L", "Hill Road", date(2026, 9, 1), ""),
                Project(hill, "Hillcrest", "#2 - Hillcrest | Hill Road | Sep 2026 | P", "Hill Road", date(2026, 9, 1), "")]
    shoot = {"client": "Lakeview | Northstar Group", "month": date(2026, 9, 1), "day": date(2026, 9, 2), "place": "Riverside"}
    pid, basis, conf, _ = match_project(shoot, projects, {})
    assert pid == lake and basis == "client_name" and conf >= 0.8      # the engagement of that season, not the older one
    # No client written: a model video dated that day in one project's folder is enough; raw footage that day, less so.
    pay_line = {"client": None, "month": date(2026, 9, 1), "day": date(2026, 9, 9), "place": None}
    pid, basis, conf, _ = match_project(pay_line, projects, {date(2026, 9, 9): {park}})
    assert pid == park and basis == "dated_video"
    pid, basis, conf, _ = match_project(pay_line, projects, {}, {date(2026, 9, 10): {hill}})
    assert pid == hill and basis == "shoot_day_upload" and conf <= 0.7
    # Two projects had footage that day: nobody guesses.
    pid, basis, _, ranked = match_project(pay_line, projects, {}, {date(2026, 9, 9): {hill, park}})
    assert pid is None and len(ranked) == 2
    # A place and a month alone never link a shoot.
    pid, *_ = match_project({"client": None, "month": date(2026, 9, 1), "day": None, "place": "Hill Road"}, projects, {})
    assert pid is None


def test_dated_video_names_and_places():
    assert dated_names("Wednesday, 9 september - Lakeview _ Riverside _ Aug 2026 (Model Video", datetime(2026, 9, 14)) == date(2026, 9, 9)
    assert dated_names("Hook 4 - Lakeview  Riverside  Aug 2026  R.mp4", datetime(2026, 9, 14)) is None
    assert dated_names("Friday, 26 December - Lakeview", datetime(2027, 1, 3)) == date(2026, 12, 26)
    river, hill_a, hill_b, city = (uuid.uuid4() for _ in range(4))
    places = [Place(river, "River Side", "Pune", 18.5, 73.8, ["river side", "riverside"]), Place(hill_a, "Hill Road East", "Pune", 18.6, 73.9, ["hill road east"]),
              Place(hill_b, "Hill Road West", "Pune", 18.4, 73.7, ["hill road west"]), Place(city, "Pune", "Pune", 18.52, 73.85, ["pune", "river side"])]
    assert find_place("riverside", places).id == river
    assert find_place("River Side", places).id == river        # its own name beats another place's alias
    assert find_place("Hill Road", places) is None              # two places fit equally well
    assert find_place("", places) is None
