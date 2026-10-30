#!/usr/bin/env python3
"""Pulse reels: 9:16 tutorial reels (and a 16:9 long-form cut) from the real UI, with editor packs.

    python3 reels.py lint                                  storyboard lines (word pairs, no digits or money)
    with-elevenlabs python3 reels.py quota                 plan and characters left (never prints the key)
    with-elevenlabs python3 reels.py voice [ids] [--langs en,hi] [--budget 7000]
    with-elevenlabs python3 reels.py sounds                SFX kit and music bed (cached; paid only once)
    node capture.mjs storyboards/<id>.json $REELS_WORK/capture/<id>     takes + action logs (see README)
    python3 reels.py build [ids] [--langs en,hi]           plan, render, mix, master, QA for each reel
    python3 reels.py longform [--langs en,hi]              all reels back to back, 16:9
    python3 reels.py pack                                  editor packs next to the finals
    python3 reels.py report [--plan-limit N]               REPORT.md + summary.json: specs, QA, ElevenLabs spend

REELS_WORK (default /tmp/pulse-reels) holds cache/, capture/ and out/<date>/. Heavy steps wait while the 1-minute
load is 3 or more (for at most 5 minutes) and stop when the work disk has less than 10 GB free.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import shutil
import subprocess
import sys
import time
from dataclasses import asdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from reelkit import plan as planmod  # noqa: E402
from reelkit import timeline, words  # noqa: E402

WORK = Path(os.environ.get("REELS_WORK", "/tmp/pulse-reels"))
DATE = os.environ.get("REELS_DATE") or dt.date.today().isoformat()
OUT = WORK / "out" / DATE
FONT = Path(os.environ.get("REELS_FONT", WORK / "fonts" / "Inter.ttf"))
ICON = Path(os.environ.get("REELS_ICON", WORK / "fonts" / "pulse-icon.png"))
LANGS = ["en", "hi"]


def load(p: Path):
    return json.loads(p.read_text(encoding="utf-8"))


def stories(ids: list[str] | None = None) -> list[dict]:
    out = []
    for p in sorted((HERE / "storyboards").glob("*.json")):
        s = load(p)
        if not ids or s["id"] in ids or s["id"][:2] in ids:
            out.append(s)
    return out


def guard(min_free_gb: float = 10.0, max_load: float = 3.0, wait_s: int = 300) -> None:
    """Stop when the disk is low; wait (up to wait_s) while the machine is busy."""
    free = shutil.disk_usage(WORK).free / 1e9
    if free < min_free_gb:
        sys.exit(f"stop: only {free:.1f} GB free on the work disk (need {min_free_gb})")
    t0 = time.time()
    while os.getloadavg()[0] >= max_load and time.time() - t0 < wait_s:
        time.sleep(20)


# ---------------------------------------------------------------------------------------------------- commands
def cmd_lint(_a) -> int:
    bad = 0
    for s in stories():
        for b in s["beats"]:
            for lang, line in b.get("line", {}).items():
                for p in words.check_line(line["say"], line["cap"]):
                    print(f"{s['id']}/{b['id']}/{lang}: {p}")
                    bad += 1
    print("lint ok" if not bad else f"{bad} problem(s)")
    return 1 if bad else 0


def cmd_quota(_a) -> int:
    from reelkit import el

    q = el.quota()
    q["five_percent"] = int(q["limit"] * 0.05)
    print(json.dumps(q))
    return 0


def cast() -> dict:
    return load(HERE / "voices.json")


def cmd_voice(a) -> int:
    from reelkit import el

    c = cast()
    ledger = el.Ledger(WORK / "out" / "ledger.json", budget=a.budget)
    todo = [(s, b, lang) for s in stories(a.ids) for b in s["beats"] for lang in a.langs if b.get("line", {}).get(lang)]
    need = sum(len(b["line"][lang]["say"]) for _, b, lang in todo)
    q = el.quota()
    print(f"lines {len(todo)}, characters if nothing is cached ~{need}; spent so far {ledger.spent}; left on plan {q['left']}")
    for s, b, lang in todo:
        v = c["languages"][lang]
        line = b["line"][lang]
        audio, info = el.tts(line["say"], v["voice_id"], WORK / "cache" / "el", model=c["model"], language_code=v.get("language_code"),
                             settings=c["settings"], ledger=ledger, label=f"{s['id']}/{b['id']}/{lang}")
        al = info.get("alignment") or info.get("normalized_alignment")
        ws = words.line_words(line["say"], line["cap"], al)
        dest = OUT / "voice" / s["id"] / lang
        dest.mkdir(parents=True, exist_ok=True)
        shutil.copy(audio, dest / f"{b['id']}.mp3")
        meta = {"file": str(dest / f"{b['id']}.mp3"), "seconds": ws[-1].end + 0.05, "words": [asdict(w) for w in ws],
                "say": line["say"], "cap": line["cap"], "chars": len(line["say"])}
        (dest / f"{b['id']}.json").write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
        print(f"{s['id']}/{b['id']}/{lang}: {meta['seconds']:.2f}s")
    print(f"spent this run (booked): {ledger.spent} credits")
    return 0


def cmd_sounds(a) -> int:
    from reelkit import el

    kit = load(HERE / "sound-kit.json")
    ledger = el.Ledger(WORK / "out" / "ledger.json", budget=a.budget)
    for name, s in kit["sfx"].items():
        print(name, el.sound(s["prompt"], s["seconds"], WORK / "cache" / "el", ledger=ledger, label=f"sfx:{name}"))
    m = kit["music"]["reel"]
    print("music", el.music(m["prompt"], m["seconds"], WORK / "cache" / "el", ledger=ledger, label="music:reel"))
    return 0


def sound_files() -> tuple[dict, dict[str, Path], Path]:
    """The cached kit by name (no network: the files exist after `sounds`)."""
    from reelkit.el import _hash

    kit = load(HERE / "sound-kit.json")
    cache = WORK / "cache" / "el"
    sfx = {n: cache / f"sfx-{_hash({'text': s['prompt'], 'duration_seconds': s['seconds'], 'prompt_influence': 0.5})}.mp3" for n, s in kit["sfx"].items()}
    m = kit["music"]["reel"]
    music = cache / f"music-{_hash({'prompt': m['prompt'], 'music_length_ms': int(m['seconds'] * 1000), 'force_instrumental': True})}.mp3"
    return kit, sfx, music


def blank_frames(take: Path) -> list[list[int]]:
    """Blank source frames of a take (a white page between routes), cached next to the take."""
    cache = take.with_suffix(".blank.json")
    if cache.exists() and cache.stat().st_mtime >= max(take.stat().st_mtime, Path(planmod.__file__).stat().st_mtime):
        return load(cache)
    import numpy as np

    raw = subprocess.run(["nice", "-n", "19", "ffmpeg", "-loglevel", "error", "-threads", "2", "-i", str(take), "-vf",
                          "scale=24:52,format=gray", "-f", "rawvideo", "-"], check=True, capture_output=True).stdout
    thumbs = np.frombuffer(raw, np.uint8).reshape(-1, 24 * 52).astype(np.float32)
    med = np.median(thumbs, axis=1, keepdims=True)
    flat = (np.abs(thumbs - med) < 6).mean(axis=1)
    ranges = planmod.blank_ranges([float(x) for x in thumbs.std(axis=1)], [float(x) for x in flat])
    cache.write_text(json.dumps(ranges), encoding="utf-8")
    return ranges


def reel_plan(s: dict, lang: str) -> dict:
    logs = {}
    for t in s["takes"]:
        log = load(WORK / "capture" / s["id"] / f"{t['id']}.actions.json")
        log["blank"] = blank_frames(WORK / "capture" / s["id"] / f"{t['id']}.mp4")
        logs[t["id"]] = log
    vdir = OUT / "voice" / s["id"] / lang
    voice = {b["id"]: load(vdir / f"{b['id']}.json") for b in s["beats"] if (vdir / f"{b['id']}.json").exists()}
    return planmod.build(s, logs, voice, lang)


def produce(p: dict, takes: dict[str, Path], layout: str, dest: Path, stem: str, clean: bool = True) -> dict:
    """Render, mix, master and QA one plan. Returns the QA record."""
    from reelkit import audio, qa
    from reelkit.compose import Fonts, Renderer

    kit, sfx, music = sound_files()
    work = WORK / "work" / stem
    work.mkdir(parents=True, exist_ok=True)
    dest.mkdir(parents=True, exist_ok=True)
    (work / "plan.json").write_text(json.dumps(p, ensure_ascii=False), encoding="utf-8")
    fonts = Fonts(FONT)
    guard()
    t = time.time()
    rep = Renderer(p, takes, fonts, layout=layout, icon=ICON).render(work / "video.mp4")
    print(f"{stem}: rendered {p['frames']} frames in {time.time() - t:.0f}s")
    if clean:
        guard()
        Renderer(p, takes, fonts, layout=layout, clean=True, icon=ICON).render(work / "clean.mp4", bitrate="12M")
    stems = audio.mix(p, kit, sfx, music if music.exists() else None, work / "audio")
    audio.loudnorm(stems["premix"], work / "audio" / "master.wav")
    final = dest / f"{stem}.mp4"
    audio.mux(work / "video.mp4", work / "audio" / "master.wav", final)
    size = (1080, 1920) if layout == "reel" else (1920, 1080)
    rec = qa.check(final, p, rep, dest / f"{stem}-contact-sheet.jpg", size)
    (dest / f"{stem}-qa.json").write_text(json.dumps(rec, indent=1), encoding="utf-8")
    cover_f = p["beats"][0]["start"] + 20
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(final), "-vf", f"select=eq(n\\,{cover_f})", "-frames:v", "1", "-q:v", "2",
                    str(dest / f"{stem}-cover.jpg")], check=True)
    print(f"{stem}: QA {'PASS' if rec['pass'] else 'ISSUES ' + '; '.join(rec['issues'])} · {rec['probe']['seconds']}s · "
          f"{rec['scan']['loudness']['integrated_lufs']} LUFS · {rec['probe']['video_kbps']} kbps")
    return rec


def cmd_build(a) -> int:
    for s in stories(a.ids):
        for lang in a.langs:
            p = reel_plan(s, lang)
            takes = {t["id"]: WORK / "capture" / s["id"] / f"{t['id']}.mp4" for t in s["takes"]}
            produce(p, takes, "reel", OUT / "reels", f"{s['id']}-{lang}")
    return 0


def cmd_longform(a) -> int:
    ss = stories(a.ids)
    for lang in a.langs:
        plans = [reel_plan(s, lang) for s in ss]
        titles = [s["title"][lang] if isinstance(s["title"], dict) else s["title"] for s in ss]
        p = planmod.combine(plans, titles, lang, f"pulse-in-a-minute-{lang}")
        takes = {f"{s['id']}/{t['id']}": WORK / "capture" / s["id"] / f"{t['id']}.mp4" for s in ss for t in s["takes"]}
        produce(p, takes, "wide", OUT / "longform", f"pulse-tutorials-wide-{lang}", clean=False)
    return 0


def cmd_pack(a) -> int:
    """Editor packs: per reel and language, clean clips per shot, voice lines, stems, captions, script, cue sheet,
    FCPXML / Premiere XML and the frame-exact plan; per reel, the raw takes, action logs and stills."""
    kit, sfx, music = sound_files()
    for s in stories(a.ids):
        root = OUT / "editor-pack" / s["id"]
        takes = root / "media" / "takes"
        takes.mkdir(parents=True, exist_ok=True)
        stills = root / "media" / "stills"
        stills.mkdir(parents=True, exist_ok=True)
        for t in s["takes"]:
            src = WORK / "capture" / s["id"]
            shutil.copy(src / f"{t['id']}.mp4", takes)
            shutil.copy(src / f"{t['id']}.actions.json", takes)
            log = load(src / f"{t['id']}.actions.json")
            for e in log["events"]:
                if e["type"] in ("tap", "appear") and e.get("mark"):
                    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(src / f"{t['id']}.mp4"), "-vf", f"select=eq(n\\,{e['frame'] + 4})",
                                    "-frames:v", "1", str(stills / f"{t['id']}-{e['frame']:05d}-{e['mark']}.png")], check=True)
        sfx_dir = root / "media" / "sfx"
        sfx_dir.mkdir(parents=True, exist_ok=True)
        for n, f in sfx.items():
            shutil.copy(f, sfx_dir / f"{n}.mp3")
        if music.exists():
            shutil.copy(music, root / "media" / "music-bed.mp3")
        shutil.copy(HERE / "storyboards" / f"{s['id']}.json", root / "storyboard.json")
        for lang in a.langs:
            stem = f"{s['id']}-{lang}"
            work = WORK / "work" / stem
            p = load(work / "plan.json")
            d = root / lang
            clips_dir = d / "media" / "clips"
            clips_dir.mkdir(parents=True, exist_ok=True)
            clips, auds = [], []
            for i, b in enumerate(p["beats"]):
                name = f"{i + 1:02d}-{b['id']}.mp4"
                subprocess.run(["nice", "-n", "19", "ffmpeg", "-loglevel", "error", "-y", "-i", str(work / "clean.mp4"), "-vf",
                                f"trim=start_frame={b['start']}:end_frame={b['start'] + b['frames']},setpts=PTS-STARTPTS", "-an",
                                "-c:v", "libx264", "-crf", "16", "-preset", "medium", "-threads", "2", str(clips_dir / name)], check=True)
                clips.append({"path": f"media/clips/{name}", "start": b["start"], "frames": b["frames"]})
            ends = p["end"]
            subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(OUT / "reels" / f"{stem}.mp4"), "-vf",
                            f"trim=start_frame={ends['start']},setpts=PTS-STARTPTS", "-an", "-c:v", "libx264", "-crf", "16", "-threads", "2",
                            str(clips_dir / f"{len(p['beats']) + 1:02d}-end-card.mp4")], check=True)
            clips.append({"path": f"media/clips/{len(p['beats']) + 1:02d}-end-card.mp4", "start": ends["start"], "frames": ends["frames"]})
            vdir = d / "media" / "voice"
            vdir.mkdir(parents=True, exist_ok=True)
            for v in p["voice"]:
                shutil.copy(v["file"], vdir / f"{v['beat']}.mp3")
                auds.append({"path": f"media/voice/{v['beat']}.mp3", "start": v["f"], "frames": v["frames"] + 3, "lane": -1, "role": "dialogue"})
            for k, sname in enumerate(p["sfx"]):
                auds.append({"path": f"../media/sfx/{sname['name']}.mp3", "start": sname["f"], "frames": 15 if sname["name"] != "chime" else 36, "lane": -2, "role": "effects"})
            stems = d / "media" / "stems"
            stems.mkdir(parents=True, exist_ok=True)
            for n in ("voice", "sfx", "music"):
                shutil.copy(work / "audio" / f"{n}.wav", stems / f"{n}.wav")
            auds.append({"path": "media/stems/music.wav", "start": 0, "frames": p["frames"], "lane": -3, "role": "music"})
            name = f"{s['id']} ({lang})"
            (d / f"{stem}.fcpxml").write_text(timeline.fcpxml(name, (1080, 1920), p["frames"], clips, auds), encoding="utf-8")
            (d / f"{stem}-premiere.xml").write_text(timeline.xmeml(name, (1080, 1920), p["frames"], clips, auds), encoding="utf-8")
            (d / f"{stem}.srt").write_text(timeline.captions_srt(p), encoding="utf-8")
            (d / f"{stem}-words.srt").write_text(timeline.captions_srt(p, words=True), encoding="utf-8")
            (d / f"{stem}-script.md").write_text(timeline.script_md(p, s, lang), encoding="utf-8")
            (d / f"{stem}-cue-sheet.csv").write_text(timeline.cue_sheet(p), encoding="utf-8")
            proj = d / "compositor-project"
            proj.mkdir(exist_ok=True)
            pp = json.loads(json.dumps(p))
            for v in pp["voice"]:
                v["file"] = f"../media/voice/{v['beat']}.mp3"
            (proj / "plan.json").write_text(json.dumps(pp, ensure_ascii=False, indent=1), encoding="utf-8")
            shutil.copy(HERE / "pack" / "COMPOSITOR.md", proj / "README.md")
        shutil.copy(HERE / "pack" / "EDITOR-PACK.md", root / "README.md")
    return 0


def cmd_report(a) -> int:
    """REPORT.md and summary.json next to the finals: every video's spec and QA, and the ElevenLabs spend."""
    rows = []
    for qa_file in sorted(OUT.glob("*/*-qa.json")):
        q = load(qa_file)
        rows.append({"file": f"{qa_file.parent.name}/{q['video']}", "seconds": q["probe"]["seconds"], "frames": q["probe"]["frames"],
                     "size": f"{q['probe']['width']}x{q['probe']['height']}", "video_kbps": q["probe"]["video_kbps"],
                     "lufs": q["scan"]["loudness"]["integrated_lufs"], "true_peak": q["scan"]["loudness"]["true_peak_dbtp"],
                     "cuts": q["cuts"], "pass": q["pass"], "issues": q["issues"]})
    led_path = WORK / "out" / "ledger.json"
    led = load(led_path) if led_path.exists() else {"entries": [], "budget": a.budget}
    tts_chars = sum(e["chars"] for e in led["entries"] if e["kind"] == "tts")
    credits = sum(e["credits"] for e in led["entries"])
    spend = {"credits": credits, "tts_characters": tts_chars, "budget": led.get("budget"),
             "by_kind": {k: sum(e["credits"] for e in led["entries"] if e["kind"] == k) for k in ("tts", "sfx", "music")}}
    if a.plan_limit:
        spend["plan_limit"] = a.plan_limit
        spend["share_of_plan_pct"] = round(100 * credits / a.plan_limit, 2)
    (OUT / "summary.json").write_text(json.dumps({"date": DATE, "videos": rows, "elevenlabs": spend}, indent=1), encoding="utf-8")
    lines = [f"# Pulse reels pilot, {DATE}", "", "All people, companies, messages and amounts on screen are fictional (Brightside Studio demo on pulse-dev).", "",
             "| File | Length | Size | Video | Loudness | True peak | Cuts | QA |", "|---|---|---|---|---|---|---|---|"]
    for r in rows:
        qa_txt = "pass" if r["pass"] else "; ".join(r["issues"])
        lines.append(f"| {r['file']} | {r['seconds']} s | {r['size']} | {r['video_kbps']} kbps | {r['lufs']} LUFS | {r['true_peak']} dBTP | {r['cuts']} | {qa_txt} |")
    share = f" ({spend['share_of_plan_pct']} % of the plan's {a.plan_limit})" if a.plan_limit else ""
    lines += ["", f"ElevenLabs: {credits} credits booked{share}: voice {spend['by_kind']['tts']} ({tts_chars} characters), "
                  f"SFX {spend['by_kind']['sfx']}, music {spend['by_kind']['music']}.", "",
              "Each video has `-contact-sheet.jpg` (the first frame after every cut, labelled with frame and shot), `-qa.json` "
              "(ffprobe spec, black and frozen-frame scan, EBU R128 loudness, caption overflow) and `-cover.jpg`. "
              "`editor-pack/<reel>/` holds the material for a human editor (see its README)."]
    text = "\n".join(lines) + "\n"
    (OUT / "REPORT.md").write_text(text, encoding="utf-8")
    print(text, end="")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("lint", "quota", "voice", "sounds", "build", "longform", "pack", "report"):
        sp = sub.add_parser(name)
        sp.add_argument("ids", nargs="*")
        sp.add_argument("--langs", type=lambda v: v.split(","), default=LANGS)
        sp.add_argument("--budget", type=int, default=7000, help="most credits this pilot may spend in total")
        sp.add_argument("--plan-limit", type=int, default=0, help="report: the plan's character limit, for the share")
    a = ap.parse_args()
    return {"lint": cmd_lint, "quota": cmd_quota, "voice": cmd_voice, "sounds": cmd_sounds, "build": cmd_build,
            "longform": cmd_longform, "pack": cmd_pack, "report": cmd_report}[a.cmd](a)


if __name__ == "__main__":
    raise SystemExit(main())
