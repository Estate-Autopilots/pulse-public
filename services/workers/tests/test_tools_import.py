from pulse_workers.tools_import import apply_latest_charge, read_exports, vendor


def test_only_allowed_exports_and_summary_excluded(tmp_path):
    (tmp_path / "Tools.csv").write_text("Tools Name,Quantity,per month\nChatGPT,2.0,120\nTotal,,120\n,,\n")
    (tmp_path / "Office.csv").write_text("Rent,200\nFoods,30\n")
    (tmp_path / "Google account.csv").write_text("Never open this file")
    exports = read_exports(tmp_path)
    assert len(exports[0]["records"]) == 1
    assert exports[0]["skipped"] == 2
    assert exports[0]["records"][0]["seats"] == 2
    assert exports[0]["records"][0]["planned_monthly_cost"] == "120"
    assert len(exports[1]["records"]) == 2


def test_vendor_aliases_do_not_guess_wifi_provider():
    assert vendor("ChatGPT") == vendor("OpenAI")
    assert vendor("Claude") == vendor("Anthropic")
    assert vendor("Google Workshop") == vendor("Google Workspace")
    assert vendor("zoho inovice ") == vendor("Zoho")
    assert vendor("electric bill june month") == vendor("electricity")
    assert vendor("WIFI") != vendor("Hathway")


def test_latest_recurring_charge_survives_cross_dataset_merge():
    payload = {"currency": "", "last_charge_amount": "", "planned_monthly_cost": "120"}
    sources = [
        {"payload": {"last_charge_amount": "", "last_charge_date": "2026-10-01"}},
        {"payload": {"last_amount": "90", "last_observed_date": "2026-09-02", "currency": "INR"}},
    ]
    apply_latest_charge(payload, sources)
    assert payload["last_charge_amount"] == "90"
    assert payload["last_charge_date"] == "2026-09-02"
    assert payload["currency"] == "INR"
    assert payload["planned_monthly_cost"] == "120"
