"""PR-PIPELINE host tools: the pure parts (subject -> topic, lane-report endings, proof links, privacy and spelling
checks, kit merging and template filling). Synthetic values only."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import checks
import collect
import fill


def test_topic_from_subject_prefix():
    assert collect.topic_of("FEATURE-X: the thing works") == ("lane:FEATURE-X", "the thing works")
    assert collect.topic_of("LAND-CAPTAIN-3: SYNTH-LANE: notices regenerated") == ("lane:SYNTH-LANE", "notices regenerated")
    assert collect.topic_of("Fix a typo") == ("", "Fix a typo")


def test_lane_report_endings():
    assert collect.parse_report("# Report\n\nbody\n\nSYNTH-LANE: DONE. Built and landed (exmp1234).\n") == ("SYNTH-LANE", "DONE", "Built and landed (exmp1234).")
    assert collect.parse_report("x\nSYNTH-2: PARTIAL — UI left\n")[1] == "PARTIAL"
    assert collect.parse_report("x\n**SYNTH-3: BLOCKED** disk\n")[1] == "BLOCKED"
    assert collect.parse_report("no ending here\n") is None


def test_proof_links():
    assert collect.proof_for({"path": "/x/app.git", "commitUrl": "https://git.example.com/a/commit/{sha}"}, "abc123") == "https://git.example.com/a/commit/abc123"
    assert collect.proof_for({"path": "/x/my app.git", "name": "my app"}, "0123456789abcdef") == "git:my-app@0123456789ab"


def test_lane_reports_skip_blocked(tmp_path):
    (tmp_path / "A.md").write_text("x\nSYNTH-A: DONE shipped\n")
    (tmp_path / "B.md").write_text("x\nSYNTH-B: BLOCKED disk\n")
    from datetime import datetime, timedelta, timezone
    ev = collect.report_events({"person": None}, str(tmp_path), datetime.now(timezone.utc) - timedelta(days=1))
    assert [e["topic"] for e in ev] == ["lane:SYNTH-A"] and ev[0]["proof"] == "report:A.md" and ev[0]["detail"].startswith("DONE")


def test_privacy_flags_phones_emails_and_private_words():
    assert checks.privacy(["Shipped the synthetic dashboard"])["ok"]
    for bad in ("Call +91 00000 00000", "write to someone@example.com", "October salary sheet", "family trip"):
        assert not checks.privacy([bad])["ok"], bad


def test_spelling_with_a_given_dictionary():
    d = frozenset({"we", "shipped", "the", "new", "dashboard", "ship", "work"})
    assert checks.spelling(["We shipped the new dashboard"], dictionary=d)["ok"]
    r = checks.spelling(["We shiped the dashbord, API and Synthbrand"], ["Synthbrand"], dictionary=d)
    assert not r["ok"] and set(r["unknown"]) == {"shiped", "dashbord"}
    assert checks.spelling(["Ships work"], dictionary=d)["ok"], "plurals pass"


def test_kit_merge_ignores_unsafe_overrides():
    kit = fill.load_kit({"industry": "software", "kit": {"colors": {"acc": "#123456", "bg": "red;}</style><script>"}, "fonts": {"css": "https://evil.example/x.css"}}})
    assert kit["preset"] == "teal-coral" and kit["themes"]["dark"]["acc"] == "#123456"
    assert kit["themes"]["dark"]["bg"].startswith("#") and "googleapis" in kit["fonts_css"]


def test_fill_escapes_copy_and_uses_a_monogram():
    page, w, h, _ = fill.render_job({"id": "x", "layout": "slide-hook", "size": "portrait", "theme": "dark",
                                     "slots": {"title": "<b>Shipped</b> *fast*", "logo": "<script>x</script>"}}, {"name": "Example Brand Co", "industry": "agency"})
    assert (w, h) == (1080, 1350)
    assert "&lt;b&gt;Shipped&lt;/b&gt; <em>fast</em>" in page and "<script>x</script>" not in page and ">EB</text>" in page


def test_backfill_plan_maps_achievements_and_ideas():
    import backfill
    h = {"schema": "pr-harvest/v1", "generated": "2026-11-06",
         "achievements": [{"id": "A1", "title": "Synthetic launch", "when": "4 Oct - 6 Nov 2026", "company": "Alpha / Beta", "proof": "EXMP0001234 commits", "why": "x"},
                          {"id": "A2", "title": "Unmapped", "when": "Nov", "company": "Gamma", "proof": "p", "why": "y"}],
         "contentIdeas": [{"id": "C1", "format": "Thread", "hook": "A synthetic hook", "proof": "p", "audience": "founders"}]}
    a, b = "00000000-0000-4000-8000-00000000000a", "00000000-0000-4000-8000-00000000000b"
    p = backfill.plan(h, {"source": "SYNTH-HARVEST", "companies": {"Alpha / Beta": [{"org": a}, {"org": b}]}, "ideas": {"org": a, "brand": None}})
    assert set(p["orgs"]) == {a, b} and len(p["orgs"][a]["events"]) == 1 and len(p["orgs"][b]["events"]) == 1
    ev = p["orgs"][a]["events"][0]
    assert ev["at"].startswith("2026-11-06") and ev["proof"] == "report:SYNTH-HARVEST.md" and ev["source"] == "harvest"
    assert p["orgs"][a]["ideas"][0]["format"] == "thread"
    sql = backfill.script(p, "Synthetic Approver", "synthetic words", False)
    assert sql.rstrip().endswith("rollback;") and "platform_log" in sql and "where false" in sql
