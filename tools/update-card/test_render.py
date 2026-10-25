"""Tests for tools/update-card/render.py (synthetic drafts only).

  uv run --no-project --with pillow==12.3.0 --with pytest pytest -q tools/update-card
"""

import copy
import json
from pathlib import Path

import pytest
import render

FIXTURE = Path(__file__).parent / "fixtures" / "synthetic-night.json"


def draft():
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def small():
    return {
        "format": "pulse-update-draft/v1",
        "edition": "morning",
        "headline": "One thing went live.",
        "onBehalfOf": "Asha",
        "window": {"timezone": "Asia/Kolkata", "end": "2026-03-15T09:00:00+05:30"},
        "sections": [
            {"key": "live", "title": "Live for everyone", "items": [{"title": "Release 2.5", "status": "live"}]},
            {"key": "readyToTry", "title": "Ready to try", "items": []},
            {"key": "needs", "title": "Needs you, Ravi", "items": ["Confirm the role names."]},
        ],
    }


def test_fixture_renders_the_card_size_with_header_and_footer():
    img, texts, cuts = render.render(draft())
    assert img.size == (1080, 1350) and img.mode == "RGB"
    assert "PULSE · EXAMPLE STUDIO" in texts and "NIGHT UPDATE" in texts
    assert "Sat 14 Mar 2026 · 21:00 IST · for Asha" in texts
    assert texts[-1] == "Prepared by Pulse (AI) for Asha"
    assert cuts, "the fixture is meant to overflow"


def test_overflow_shows_plus_n_more_and_keeps_needs_whole():
    d = draft()
    d["sections"].insert(0, {"key": "long", "title": "Long list",
                             "items": [{"title": f"Item {n}", "status": "done"} for n in range(12)]})
    _, texts, cuts = render.render(d)
    shown = sum(t.startswith("Item ") for t in texts)
    assert 1 <= shown < 12
    assert f"+{12 - shown} more" in texts
    assert any(c.startswith("long:") for c in cuts)
    assert all(t in texts for t in ("1.", "2.", "3.")), "needs is cut only after every other section folds"


def test_count_beyond_the_listed_items_is_part_of_more():
    d = small()
    d["sections"][0]["count"] = 9
    _, texts, cuts = render.render(d)
    assert "+8 more" in texts and cuts == []


def test_folded_sections_close_with_one_more_line():
    d = draft()
    _, texts, _ = render.render(d)
    assert any(t.startswith("+") and " more in " in t for t in texts)


def test_small_draft_shows_everything_and_skips_empty_sections():
    _, texts, cuts = render.render(small())
    assert cuts == [] and not any(t.startswith("+") for t in texts)
    assert "MORNING UPDATE" in texts and "PULSE" in texts
    assert "READY TO TRY" not in texts
    assert "Confirm the role names." in texts and texts[-1] == "Prepared by Pulse (AI) for Asha"


def test_unknown_status_and_chip_override():
    d = small()
    d["sections"][0]["items"] = [{"title": "A", "status": "on_hold"},
                                 {"title": "B", "status": "live", "chip": "Live 14:02"}]
    _, texts, _ = render.render(d)
    assert "On hold" in texts and "Live 14:02" in texts


def test_render_is_deterministic():
    a, _, _ = render.render(draft())
    b, _, _ = render.render(copy.deepcopy(draft()))
    assert a.tobytes() == b.tobytes()


def test_cli_writes_png_and_creates_parents(tmp_path, capsys):
    out = tmp_path / "out" / "2026-03-14-pm.png"
    assert render.main([str(FIXTURE), str(out), "--org", "Other Co"]) == 0
    assert out.read_bytes()[:8] == b"\x89PNG\r\n\x1a\n"
    assert list(out.parent.iterdir()) == [out]
    assert "update-card: " in capsys.readouterr().err


@pytest.mark.parametrize("bad", [
    {"format": "something-else"},
    {"format": "pulse-update-draft/v1", "headline": "", "sections": []},
    {"format": "pulse-update-draft/v1", "headline": "H", "sections": [{"key": "x", "items": [{"note": "no title"}]}]},
    {"format": "pulse-update-draft/v1", "headline": "H", "sections": "nope"},
    {"format": "pulse-update-draft/v1", "headline": "H", "window": {"end": "not a date"}, "sections": []},
])
def test_bad_drafts_exit_2_and_write_nothing(tmp_path, bad):
    src, out = tmp_path / "draft.json", tmp_path / "card.png"
    src.write_text(json.dumps(bad), encoding="utf-8")
    assert render.main([str(src), str(out)]) == 2
    assert not out.exists()


def test_unreadable_draft_exits_2(tmp_path):
    assert render.main([str(tmp_path / "missing.json"), str(tmp_path / "card.png")]) == 2
