"""Unit tests for the reels pipeline (no network, no browser, no ffmpeg).

    python3 -m pytest tools/tutorials/tests -q
"""

from __future__ import annotations

import json
import sys
import xml.dom.minidom
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))

from reelkit import plan, timeline, words  # noqa: E402
from reelkit.el import BudgetError, Ledger  # noqa: E402


# ------------------------------------------------------------------------------------------------ time map
def total(segs):
    return sum(s.n for s in segs)


@pytest.mark.parametrize("target", [40, 90, 200, 600])
def test_time_map_hits_the_target_exactly(target):
    segs = plan.time_map(0, 300, [50, 120, 250], target)
    assert total(segs) == target
    # Segments are contiguous in output frames.
    out = 0
    for s in segs:
        assert s.out == out
        out += s.n


def test_time_map_plays_actions_at_1x_and_speeds_up_idle():
    segs = plan.time_map(0, 300, [150], 120)
    around = [s for s in segs if s.src <= 150 < s.src + s.n * max(s.speed, 1)]
    assert around and around[0].speed == 1.0
    assert max(s.speed for s in segs) <= plan.MAX_SPEED + 1e-9
    assert any(s.speed > 1 for s in segs)


def test_time_map_holds_the_last_frame_when_the_source_is_short():
    segs = plan.time_map(0, 30, [10], 60)
    assert total(segs) == 60
    assert segs[-1].speed == 0.0


def test_out_frame_of_finds_the_action():
    segs = plan.time_map(0, 300, [200], 120)
    f = plan.out_frame_of(segs, 200)
    s = next(s for s in segs if s.out <= f < s.out + s.n)
    assert s.src_at(f) >= 200 and s.src_at(f) <= 201


# ------------------------------------------------------------------------------------------------ blank frames
def test_blank_ranges_and_avoid_blank():
    spread = [30, 30, 2, 1, 30, 30, 0.5]
    r = plan.blank_ranges(spread)
    assert r == [[2, 4], [6, 7]]
    assert plan.avoid_blank(3, r) == 1  # last good frame before the blank
    assert plan.avoid_blank(4, r) == 4
    assert plan.avoid_blank(0, [[0, 3]]) == 3  # blank at the very start: first good frame after
    # A loading page with a header and tab bar: high spread, but mostly one tone.
    assert plan.blank_ranges([12, 11, 11, 12], [0.62, 0.9, 0.9, 0.86]) == [[1, 3]]
    # A long plain stretch is a real screen, not a flash.
    assert plan.blank_ranges([1.0] * 40) == []


# ------------------------------------------------------------------------------------------------ camera
def test_camera_is_eased_between_keys_and_clamped_to_the_take():
    keys = [{"f": 0, "cx": 585, "cy": 1266, "z": 1.0}, {"f": 10, "cx": 100, "cy": 100, "z": 1.4}]
    assert plan.camera_at(keys, 0) == (585, 1266, 1.0)
    assert plan.camera_at(keys, 10) == (100, 100, 1.4)
    x, y, w, h = plan.clamp_camera(100, 100, 1.4, 1170, 2532, 1080 / 1920)
    assert x == 0 and y == 0 and w <= 1170 and h <= 2532
    assert abs(w / h - 1080 / 1920) < 1e-6


# ------------------------------------------------------------------------------------------------ words
ALIGN = {
    "characters": list("[excited] Hi there, friend!"),
    "character_start_times_seconds": [i * 0.05 for i in range(27)],
    "character_end_times_seconds": [i * 0.05 + 0.05 for i in range(27)],
}


def test_word_times_skip_audio_tags_and_map_captions():
    ws = words.line_words("[excited] Hi there, friend!", "Hi *there,* friend!", ALIGN)
    assert [w.text for w in ws] == ["Hi", "there,", "friend!"]
    assert ws[1].key and not ws[0].key
    assert ws[0].start == pytest.approx(10 * 0.05)  # "Hi" starts after the tag
    assert all(a.end <= b.start + 1e-9 or a.end == b.start for a, b in zip(ws, ws[1:]))


def test_check_line_blocks_digits_money_and_word_mismatch():
    assert words.check_line("one two", "one two") == []
    assert words.check_line("one two", "one") != []
    assert any("digits" in p for p in words.check_line("ten", "10"))
    assert any("money" in p for p in words.check_line("₹ five", "five"))


def test_cards_break_on_punctuation_and_length():
    ws = [words.Word(t, i, i + 0.5) for i, t in enumerate("Done! The reply lands in the group, approved by you.".split())]
    cs = words.cards(ws)
    assert [w.text for w in cs[0]] == ["Done!"]
    assert all(len(c) <= 3 for c in cs)
    assert all(len(" ".join(w.text for w in c)) <= 18 or len(c) == 1 for c in cs)


def test_srt_time_and_wrap():
    assert words.srt_time(3723.5) == "01:02:03,500"
    assert all(len(line) <= 42 for line in words.wrap("a " * 40).split("\n"))
    assert words.wrap("short") == "short"


# ------------------------------------------------------------------------------------------------ plan.build
def synthetic():
    story = {
        "id": "99-test", "title": {"en": "Test"},
        "takes": [{"id": "t1", "blur": [{"mark": "b", "box": [0, 0, 10, 10], "pad": 0}]}, {"id": "t2"}],
        "beats": [
            {"id": "hook", "take": "t1", "from": "a", "to": "c", "hook": {"en": "Hook"}, "line": {"en": {"say": "x", "cap": "x"}}},
            {"id": "two", "take": "t2", "from": "a", "to": "c", "payoff": True},
        ],
        "end": {"frames": 24, "text": {"en": "Bye"}},
    }
    log = {"frames": 200, "events": [
        {"i": 0, "type": "mark", "mark": "a", "frame": 10},
        {"i": 1, "type": "tap", "mark": "b", "frame": 60, "box": [100, 200, 80, 40]},
        {"i": 2, "type": "appear", "frame": 90, "box": [20, 300, 350, 200]},
        {"i": 3, "type": "mark", "mark": "c", "frame": 150},
    ], "blank": [[70, 73]]}
    voice = {"hook": {"file": "/x/hook.mp3", "seconds": 1.2,
                      "words": [{"text": "x", "start": 0.0, "end": 1.1, "key": False}]}}
    return story, {"t1": log, "t2": log}, voice


def test_build_places_everything_on_integer_frames():
    story, logs, voice = synthetic()
    p = plan.build(story, logs, voice, "en")
    assert p["frames"] == sum(b["frames"] for b in p["beats"]) + 24
    assert p["beats"][0]["transition"] == "start" and p["beats"][1]["transition"] == "whip"
    names = [s["name"] for s in p["sfx"]]
    assert {"tap", "pop", "whoosh", "chime"} <= set(names)
    assert all(isinstance(s["f"], int) for s in p["sfx"])
    tap = next(s for s in p["sfx"] if s["name"] == "tap" and s["beat"] == "hook")
    b0 = p["beats"][0]
    assert tap["f"] == plan.out_frame_of([plan.Seg(**s) for s in b0["segs"]], 60) - 1
    assert b0["blank"] == [[70, 73]]
    assert b0["blur"] and b0["blur"][0][0] == 58  # from the mark, two frames early
    assert b0["avoid"] and b0["avoid"][0]["box"] == [300.0, 600.0, 240.0, 120.0]  # CSS px x3
    assert p["voice"][0]["f"] == 0 and p["captions"][0]["words"][0]["f0"] == 0
    json.dumps(p)  # the plan is plain JSON


def test_combine_keeps_frames_and_prefixes_takes():
    story, logs, voice = synthetic()
    a = plan.build(story, logs, voice, "en")
    c = plan.combine([a, a], ["A", "B"], "en", "long")
    assert c["frames"] == 2 * a["end"]["start"] + 36
    assert c["beats"][0]["take"] == "99-test/t1"
    assert c["beats"][len(a["beats"])]["transition"] == "whip"
    ids = [b["id"] for b in c["beats"]]
    assert len(set(ids)) == len(ids)  # shot ids stay unique across chapters
    assert {cap["beat"] for cap in c["captions"]} <= set(ids)


# ------------------------------------------------------------------------------------------------ editor files
def test_timeline_exports_are_well_formed():
    story, logs, voice = synthetic()
    p = plan.build(story, logs, voice, "en")
    clips = [{"path": f"media/clips/{i}.mp4", "start": b["start"], "frames": b["frames"]} for i, b in enumerate(p["beats"])]
    auds = [{"path": "media/voice/hook.mp3", "start": 0, "frames": 40, "lane": -1, "role": "dialogue"}]
    for xml_text in (timeline.fcpxml("t", (1080, 1920), p["frames"], clips, auds),
                     timeline.xmeml("t", (1080, 1920), p["frames"], clips, auds)):
        xml.dom.minidom.parseString(xml_text.split("\n", 2)[2] if "DOCTYPE" in xml_text else xml_text)
    sheet = timeline.cue_sheet(p)
    assert sheet.splitlines()[0] == "timecode,frame,type,beat,detail"
    assert "00:00:00:00" in sheet
    assert timeline.tc(31) == "00:00:01:01"
    assert "-->" in timeline.captions_srt(p) and "-->" in timeline.captions_srt(p, words=True)


# ------------------------------------------------------------------------------------------------ budget
def test_ledger_refuses_past_the_budget_and_the_quota_share(tmp_path):
    led = Ledger(tmp_path / "ledger.json", budget=1000)
    q = {"limit": 100_000, "left": 90_000}
    led.check(500, q)
    led.add("tts", "x", 900, 900)
    with pytest.raises(BudgetError):
        led.check(200, q)  # past this run's budget
    small = Ledger(tmp_path / "l2.json", budget=10_000)
    with pytest.raises(BudgetError):
        small.check(6000, q)  # past 5 % of the plan
    with pytest.raises(BudgetError):
        small.check(100, {"limit": 100_000, "left": 300})  # quota lower than expected
    assert json.loads((tmp_path / "ledger.json").read_text())["spent"] == 900


# ------------------------------------------------------------------------------------------------ storyboards
def test_storyboards_lint_clean_and_reference_logged_marks():
    for path in sorted((HERE / "storyboards").glob("*.json")):
        s = json.loads(path.read_text(encoding="utf-8"))
        marks = {t["id"]: {st.get("mark") for st in t.get("setup", []) + t["steps"]} | {st.get("markEnd") for st in t["steps"]}
                 for t in s["takes"]}
        for b in s["beats"]:
            assert b["take"] in marks, f"{path.name}/{b['id']}: unknown take"
            assert b["from"] in marks[b["take"]] and b["to"] in marks[b["take"]], f"{path.name}/{b['id']}: unknown mark"
            for lang, line in b.get("line", {}).items():
                assert words.check_line(line["say"], line["cap"]) == [], f"{path.name}/{b['id']}/{lang}"
        assert {"en", "hi"} <= set(s["title"])


# ------------------------------------------------------------------------------------------------ compositor
def test_caption_moves_off_the_tapped_button():
    pytest.importorskip("numpy")
    pytest.importorskip("PIL")
    from reelkit.compose import CAPTION_Y, caption_y

    beat = {"start": 0, "frames": 60, "camera": [{"f": 0, "cx": 585, "cy": 1266, "z": 1.0}],
            # A button whose screen centre is at the default caption height (1290 of 1920 = 1701 of 2532 take px).
            "avoid": [{"f": 20, "box": [300, 1660, 400, 90], "type": "tap"}]}
    y = caption_y(beat, (1080, 1920))
    assert y != CAPTION_Y[0]
    assert caption_y({**beat, "avoid": []}, (1080, 1920)) == CAPTION_Y[0]
    # A whole card in the middle as well: the button still decides.
    big = {**beat, "avoid": beat["avoid"] + [{"f": 5, "box": [0, 600, 1170, 1300], "type": "appear"}]}
    assert caption_y(big, (1080, 1920)) == y
    assert max(CAPTION_Y) + 115 <= 1920 * 0.8  # never in the bottom 20 %


def test_compositor_renders_frames():
    np = pytest.importorskip("numpy")
    pytest.importorskip("PIL")
    from reelkit import compose

    open_now: set = set()

    class Reader:
        def __init__(self, name):
            self.name = name

        def get(self, n):
            open_now.add(self.name)
            assert len(open_now) == 1, "two decoders at once"
            return np.full((compose.SRC_H, compose.SRC_W, 3), 200, np.uint8)

        def close(self):
            open_now.discard(self.name)

    story, logs, voice = synthetic()
    p = plan.build(story, logs, voice, "en")
    font = next((f for f in (Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"), Path("C:/Windows/Fonts/arialbd.ttf")) if f.exists()), None)
    if font is None:
        pytest.skip("no TrueType font here")
    r = compose.Renderer(p, {}, compose.Fonts(font))
    r.readers = {"t1": Reader("t1"), "t2": Reader("t2")}
    for f in range(p["frames"]):  # sequential, like a render: the whip uses the cached last frame
        img = r.frame(f)
        assert img.size == (1080, 1920)


def test_hook_lines_never_leave_a_lone_word():
    pytest.importorskip("PIL")
    from reelkit.compose import hook_lines

    m = lambda t: 50.0 * len(t)  # noqa: E731
    assert hook_lines("Your AI asks first", m, 1000) == ["Your AI asks first"]
    assert hook_lines("AI pehle poochta hai", m, 900) == ["AI pehle", "poochta hai"]


def test_an_appearing_element_is_never_zoomed_past_its_width():
    story, logs, voice = synthetic()
    p = plan.build(story, logs, voice, "en")
    key = next(k for k in p["beats"][0]["camera"] if k.get("event") == 2)  # the 350 px wide appear
    assert key["z"] <= plan.fit_zoom(350 * 3) + 1e-9 and key["z"] >= 1.0
    tap = next(k for k in p["beats"][0]["camera"] if k.get("event") == 1)
    assert tap["z"] == pytest.approx(1.32)  # a tap keeps its punch-in
