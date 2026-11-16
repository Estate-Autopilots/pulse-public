import json
from pathlib import Path

import pytest

from pulse_rules import (
    classify,
    classify_creative_type,
    classify_design_type,
    parse_cid_filename,
    parse_legacy_name,
    sort_versions,
)

REPO_ROOT = Path(__file__).parents[4]
FIXTURES = json.loads((Path(__file__).parents[1] / "fixtures/delivery_detection.v2.json").read_text())
CID_FIXTURES = json.loads((REPO_ROOT / "packages/schemas/fixtures/cid.json").read_text())
EA_DESIGN_RULES = json.loads((REPO_ROOT / "config/ea-design-type-rules.json").read_text())
CONFIG = FIXTURES["tenant_config"]


@pytest.mark.parametrize("case", CID_FIXTURES["valid"], ids=lambda case: case["name"])
def test_cid_shared_fixtures(case):
    parsed = parse_cid_filename(case["name"])
    assert parsed is not None
    assert parsed["asset_cid"] == case["base"]
    assert parsed["tenant"] == case["tenant"]
    assert parsed["project_registry"] == case["base"].split("-", 1)[0][len(case["tenant"]) :]
    assert parsed["type_code"] == case["type"]
    assert parsed["asset_number"] == case["num"]
    assert parsed["version"] == case["version"]
    assert parsed["variant"] == case["variant"]


@pytest.mark.parametrize("name", CID_FIXTURES["invalid"])
def test_invalid_cid_shared_fixtures(name):
    assert parse_cid_filename(name) is None


@pytest.mark.parametrize("case", FIXTURES["legacy_names"])
def test_legacy_name_fixtures(case):
    result = parse_legacy_name(case["name"], CONFIG)
    assert result["type_code"] == case["type_code"]
    assert result["version"] == case["version"]


@pytest.mark.parametrize("case", FIXTURES["version_order"])
def test_version_order_fixtures(case):
    assert [version["name"] for version in sort_versions(case["versions"])] == case["ordered_names"]


@pytest.mark.parametrize("case", FIXTURES["classify"], ids=lambda case: case["id"])
def test_classify_fixtures(case):
    config = {**CONFIG, **case.get("tenant_config_overrides", {})}
    result = classify(case["file_event"], config)
    for key, value in case["expected"].items():
        assert result[key] == value
    assert case["why_contains"].lower() in " ".join(result["why"]).lower()


def test_tenant_can_correct_creative_type_rules_as_data():
    config = {
        "creative_type_rules": {
            "folder_path": [{"match": "launch assets", "type": "vov"}],
        }
    }
    result = classify_creative_type(
        {"name": "Unmarked export.mp4", "folder_path": ["Launch Assets"]},
        config,
    )
    assert result == {
        "type": "vov",
        "label": "VOV",
        "classified": True,
        "source": "folder_path",
        "evidence": "launch assets",
        "rule": "launch assets",
    }


def test_ea_cp_videos_follow_the_vov_convention():
    for name in ("CP Video.mp4", "CP03.mp4"):
        result = classify_creative_type({"name": name, "folder_path": ["Exports"]}, CONFIG)
        assert result["type"] == "vov"
        assert result["classified"] is True


def test_tenant_can_correct_design_type_rules_as_data():
    result = classify_design_type(
        {"name": "Brand mark export.ai", "folder_path": ["Creatives", "Brand marks"]},
        {"design_type_rules": {"folder_path": [{"match": "brand marks?", "type": "logo"}]}},
    )
    assert result == {
        "type": "logo",
        "label": "Logo",
        "classified": True,
        "source": "folder_path",
        "evidence": "brand marks",
        "rule": "brand marks?",
    }


def test_invalid_design_regex_is_ignored():
    result = classify_design_type(
        {"name": "Unmarked export.psd", "folder_path": ["Creatives", "Misc exports"]},
        {"design_type_rules": {"folder_path": [{"match": "[", "type": "logo"}]}},
    )
    assert result["type"] == "other"


def test_ea_design_folder_rules_match_bounded_terms_in_normalized_segments():
    config = {"design_type_rules": EA_DESIGN_RULES}
    assert classify_design_type(
        {"name": "asset.pdf", "folder_path": ["W41 project carousel creative exports"]}, config,
    )["type"] == "carousel"
    assert classify_design_type(
        {"name": "asset.pdf", "folder_path": ["Project_single_IMG, ad_v2"]}, config,
    )["type"] == "single_image_ad"
    assert classify_design_type(
        {"name": "asset.pdf", "folder_path": ["campaign monologous archive"]}, config,
    )["type"] == "other"
    assert classify_design_type(
        {"name": "asset.pdf", "folder_path": ["creative archive"]}, config,
    )["type"] == "other"


def test_ea_design_folder_rules_keep_carousel_ahead_of_generic_image_ads():
    config = {"design_type_rules": EA_DESIGN_RULES}
    for folder in ("Carousel image ads", "C.Img ads", "Carousel-Image creatives"):
        result = classify_design_type({"name": "asset.pdf", "folder_path": [folder]}, config)
        assert result["type"] == "carousel"
    for folder in ("Single image ads", "Image ads"):
        result = classify_design_type({"name": "asset.pdf", "folder_path": [folder]}, config)
        assert result["type"] == "single_image_ad"


@pytest.mark.parametrize("case", FIXTURES["design_type_precedence_cases"], ids=lambda case: case["id"])
def test_ea_design_rules_exclude_reference_inputs_and_prefer_deepest_folder(case):
    config = {"design_type_rules": EA_DESIGN_RULES}
    result = classify_design_type({"name": "asset.pdf", "folder_path": case["folder_path"]}, config)
    assert result["type"] == case["expected"]
