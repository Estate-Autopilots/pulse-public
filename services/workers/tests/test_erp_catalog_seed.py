"""ERP-INVOICE: the draft catalog read from a package cost model. A synthetic workbook shaped like EA's
"Per client expenses" (Sheet1 package columns, a service tab, and a salary tab that must never be read).
Invented names and figures."""

import openpyxl

from pulse_workers import erp_catalog_seed as seed

META = {"id": "synthetic-file", "name": "Per client expenses"}


def workbook():
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Sheet1"
    rows = [
        [
            "Fulfillment Department",
            "Per Task Expenses",
            "Units",
            "4 Month",
            "Per Task Expenses",
            "Units",
            "2 Month Lite",
        ],
        [],
        ["Positioning", 700, 1, 700, 500, 1, 500],
        ["Model", 4000, 3, 12000, 4000, 1, 4000],
        ["Meta Ads", 1200, "4 Month", 4800, 1200, "2 Month", 2400],
        ["Office & Founder Salary (Overhead)", 20000, 1, 18000, None, None, None],
        ["Total (desired Package)", 100000, None, None, 30000, "Total (desired Package)", 6900],
        [],
        ["Brand Film", 18500, 1, 18500],
        ["Total (desired Package)", 300000, None, 18500],
    ]
    for r in rows:
        ws.append(r)
    svc = wb.create_sheet("4 Month (2 MMV - Only Meta ads)")
    for r in [
        [
            None,
            "List Of Services",
            "Team Member",
            "Per Task Expense",
            "Expense 4 Month (2 MMV)",
            "3X - 4 Month (2 MMV)",
        ],
        [],
        ["#", "HOO & Hr", None, 100000, "5% Of Last Price", 5000],
        [1, "Brand Identity & Positioning"],
        [None, "3.5X", "Creative Strategist", 650, 650, 2275],
        [2, "Model-Led Cinematic Brand Film"],
        [None, "2 Model-Video", "Creative Strategist", 400, 800, 2080],
        [None, "2.6X", "Model", 6000, 12000, 31200],
        [3, "Meta Advertising Engine"],
        [None, "per Month", "Performance Marketer", 1200, 4800, 19200],
    ]:
        svc.append(r)
    salary = wb.create_sheet("Team Salary")
    salary.append([None, None, "Salary", "Name"])
    salary.append([1, None, 99999, "Synthetic Secret Person"])
    return wb


def test_package_columns_become_packages_with_parts_and_overhead_kept_apart():
    pk = {p["name"]: p for p in seed.package_columns(workbook(), META)}
    assert set(pk) == {"4 Month", "2 Month Lite", "Premium package (unnamed in the cost sheet)"}
    four = pk["4 Month"]
    assert four["price"] == 10000000 and four["cost"] == 3550000  # summed parts when the Total row has no cost
    assert [p["label"] for p in four["parts"]] == ["Positioning", "Model", "Meta Ads", "Overhead allocation"]
    model = next(p for p in four["parts"] if p["label"] == "Model")
    assert (model["quantity"], model["deliverables"]) == (3.0, ["3 × Model"])
    meta = next(p for p in four["parts"] if p["label"] == "Meta Ads")
    assert (meta["quantity"], meta["unit"]) == (4.0, "month")
    overhead = four["parts"][-1]
    assert overhead["deliverables"] == [] and "not a deliverable" in overhead["derives"]
    assert [m["percent"] for m in four["milestones"]] == [25, 25, 25, 25]
    assert pk["2 Month Lite"]["cost"] == 690000 and four["source"]["sheet"] == "Sheet1"


def test_service_tabs_give_services_with_team_quantity_and_3x_price_and_salary_tabs_are_never_read():
    packages, services = seed.service_sheets(workbook(), META)
    [p] = packages
    assert p["name"] == "4 Month (2 MMV - Only Meta ads)" and p["price"] == 10000000
    parts = {x["label"]: x for x in p["parts"]}
    film = parts["Model-Led Cinematic Brand Film"]
    assert (film["quantity"], film["cost"], film["price"], film["setup"]) == (
        2,
        1280000,
        3328000,
        "Team: Creative Strategist, Model",
    )
    assert parts["Meta Advertising Engine"]["unit"] == "month" and parts["Meta Advertising Engine"]["quantity"] == 4
    assert parts["HOO & HR allocation"]["derives"] == "Cost share, not a deliverable"
    assert set(services) == {
        "brand identity & positioning",
        "model-led cinematic brand film",
        "meta advertising engine",
    }
    every = repr(seed.package_columns(workbook(), META)) + repr(packages) + repr(services)
    assert "Synthetic Secret Person" not in every and "99999" not in every


def test_proposed_sac_codes_and_billing_plans():
    assert seed.sac_for("High-Converting Landing Page") == "998314"
    assert seed.sac_for("Video editing") == "999613"
    assert seed.sac_for("YouTube & Google Video Advertising") == "998361"
    assert seed.sac_for("Model-Led Cinematic Brand Film") == "999612"
    assert seed.sac_for("Cinematic Carousel Ads") == "998391"
    assert seed.sac_for("Training & Guidance") == "999293"
    assert seed.sac_for("Reputation engine") == "998361"
    assert [m["percent"] for m in seed.months_plan("3 Month (x)")] == [33.33, 33.33, 33.34]
    assert seed.months_plan("Just Model Video") == [{"label": "On delivery", "percent": 100, "offsetDays": 0}]
    assert (
        seed.quantity("4 Month") == (4.0, "month")
        and seed.quantity(3.0) == (3.0, None)
        and seed.quantity("x") == (1.0, None)
    )


def test_invoice_lines_become_monthly_services():
    assert seed.invoice_service("4 Months Meta Ad Fees") == ("Ad agency fees (monthly retainer)", 4)
    assert seed.invoice_service("Ad Agency Fees") == ("Ad agency fees (monthly retainer)", 1)
    assert seed.invoice_service("2 Month Ad Management Fees") == ("Meta ads management (monthly fee)", 2)
    assert seed.invoice_service("Months") is None
    assert seed.invoice_service("Model Video Shoot") is None
