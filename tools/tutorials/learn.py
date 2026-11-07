#!/usr/bin/env python3
"""Pulse Learn: the tutorial videos and their YouTube kit, from the same storyboards and engine as the reels.

    python3 learn.py build [ids] [--langs en,hi]   16:9 YouTube cut (phone on the brand stage) + 9:16 reel per tutorial
    python3 learn.py meta [ids] [--langs en,hi]    chapters, captions (SRT + VTT: en, hi, hi-Latn), transcript, cue sheet,
                                                   thumbnail, <id>.json manifest and <id>-<lang>.youtube.txt
    python3 learn.py playlists                     playlists.json: the YouTube playlists (from the Learn page's lists)
    python3 learn.py web [ids] --media DIR         720p web cuts + captions + poster into DIR/<id>/, and
                                                   apps/web/app/lib/learn-media.json (what the Learn page may show)
    python3 learn.py webp SHOTS_DIR                the Learn screenshots (shots.mjs PNGs) to public/learn-shots/<id>/*.webp
    python3 learn.py report                        LEARN.md next to the outputs

A tutorial is a storyboard (storyboards/<id>.json) whose id is a tutorial on the Learn page (apps/web/app/lib/learn.mjs).
Voice: `reels.py voice <ids>` (ElevenLabs, budgeted) first; a tutorial without voice lines for a language is built
silent from its captions (`--silent`): every beat lasts as long as its caption needs to be read, at 2.6 words a second.
Outputs go to $REELS_WORK/out/<date>/learn/. Run on ac like the reels (see README).
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import reels  # noqa: E402
from reelkit import plan as planmod  # noqa: E402
from reelkit import timeline, words  # noqa: E402

ROOT = HERE.parent.parent
LEARN_MJS = ROOT / "apps/web/app/lib/learn.mjs"
MEDIA_JSON = ROOT / "apps/web/app/lib/learn-media.json"
SHOTS_PUBLIC = ROOT / "apps/web/public/learn-shots"
OUT = reels.OUT / "learn"
FPS = planmod.FPS
CHANNEL_NOTE = {
    "en": "Pulse is Estate Autopilots' work app: tasks, chats, clients, quotations, HR and finance in one place. "
          "All people, companies and amounts in this video are made up (the Brightside Studio demo company).",
    "hi": "Pulse, Estate Autopilots ka work app hai: tasks, chats, clients, quotations, HR aur finance ek jagah. "
          "Is video ke sab log, companies aur amounts kaalpanik hain (Brightside Studio demo company).",
}


def catalog() -> dict:
    """TUTORIALS and PLAYLISTS from the Learn page's own module (node prints them as JSON)."""
    js = f"import(process.argv[1]).then(m => console.log(JSON.stringify({{tutorials: m.TUTORIALS, playlists: m.PLAYLISTS}})))"
    r = subprocess.run(["node", "-e", js, LEARN_MJS.as_uri()], check=True, capture_output=True, text=True)
    return json.loads(r.stdout)


def tutorial_stories(ids: list[str] | None) -> list[dict]:
    known = {t["id"] for t in catalog()["tutorials"]}
    return [s for s in reels.stories(ids) if s["id"] in known]


def title(s: dict, lang: str) -> str:
    return s["title"][lang] if isinstance(s["title"], dict) else s["title"]


def silent_voice(s: dict, lang: str) -> None:
    """Caption-only timing for a language with no voice: a fake 'voice' record per beat (no file), words spaced evenly."""
    dest = reels.OUT / "voice" / s["id"] / lang
    dest.mkdir(parents=True, exist_ok=True)
    for b in s["beats"]:
        line = b.get("line", {}).get(lang)
        if not line or (dest / f"{b['id']}.json").exists():
            continue
        cw = words.caption_words(line["cap"])
        per = 1 / 2.6
        ws = [{"text": w, "key": k, "start": round(i * per, 3), "end": round((i + 1) * per - 0.04, 3)} for i, (w, k) in enumerate(cw)]
        meta = {"file": None, "seconds": len(cw) * per + 0.6, "words": ws, "say": line["say"], "cap": line["cap"], "chars": 0, "silent": True}
        (dest / f"{b['id']}.json").write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")


def has_voice(s: dict, lang: str) -> bool:
    vdir = reels.OUT / "voice" / s["id"] / lang
    recs = [vdir / f"{b['id']}.json" for b in s["beats"] if b.get("line", {}).get(lang)]
    return bool(recs) and all(p.exists() and not json.loads(p.read_text(encoding="utf-8")).get("silent") for p in recs)


def wide_plan(s: dict, lang: str) -> dict:
    p = reels.reel_plan(s, lang)
    w = planmod.combine([p], [title(s, lang)], lang, f"{s['id']}-{lang}")
    w["voice"] = [v for v in w["voice"] if v.get("file")]
    return w


def cmd_build(a) -> int:
    for s in tutorial_stories(a.ids):
        takes = {t["id"]: reels.WORK / "capture" / s["id"] / f"{t['id']}.mp4" for t in s["takes"]}
        for lang in a.langs:
            if not has_voice(s, lang):
                if not a.silent:
                    print(f"{s['id']}/{lang}: no voice lines (run reels.py voice, or pass --silent)")
                    continue
                silent_voice(s, lang)
            if "wide" in a.formats:
                w = wide_plan(s, lang)
                reels.produce(w, {f"{s['id']}/{k}": v for k, v in takes.items()}, "wide", OUT / "youtube", f"{s['id']}-{lang}", clean=False)
                (OUT / "youtube" / f"{s['id']}-{lang}.plan.json").write_text(json.dumps(w, ensure_ascii=False), encoding="utf-8")
            if "reel" in a.formats:
                p = reels.reel_plan(s, lang)
                p["voice"] = [v for v in p["voice"] if v.get("file")]
                reels.produce(p, takes, "reel", OUT / "reels", f"{s['id']}-{lang}", clean=False)
    return 0


# ------------------------------------------------------------------------------------------------- captions, meta
def strip_tags(say: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"\[[^\]]*\]", "", say)).strip()


def caption_entries(p: dict, s: dict, lang: str, script: str) -> list[tuple[float, float, str]]:
    """One caption per spoken line: Roman (the caption words) or Devanagari (the voice text, tags removed)."""
    beats = {b["id"]: b for b in s["beats"]}
    by_beat: dict[str, list] = {}
    for c in p["captions"]:
        by_beat.setdefault(c.get("beat", ""), []).append(c)
    out = []
    for bid, cs in by_beat.items():
        raw = bid.split(":")[-1]
        line = beats.get(raw, {}).get("line", {}).get(lang, {})
        text = strip_tags(line.get("say", "")) if script == "native" else " ".join(w["text"] for c in cs for w in c["words"])
        out.append((cs[0]["f0"] / FPS, cs[-1]["f1"] / FPS, words.wrap(text.replace("*", ""))))
    return out


def vtt(entries: list[tuple[float, float, str]]) -> str:
    return "WEBVTT\n\n" + re.sub(r"(\d\d:\d\d:\d\d),(\d\d\d)", r"\1.\2", words.srt(entries))


def chapters(p: dict, s: dict, lang: str, min_len: float = 10.0) -> list[dict]:
    """Chapters from the beats' `chapter` names (the Learn steps), merged so each lasts at least min_len seconds
    (YouTube's rule); the first starts at 0:00."""
    beats = {b["id"]: b for b in s["beats"]}
    raw = []
    for b in p["beats"]:
        name = (beats.get(b["id"].split(":")[-1], {}).get("chapter") or {}).get(lang)
        if name and (not raw or raw[-1]["title"] != name):
            raw.append({"at": b["start"] / FPS, "title": name})
    if not raw:
        return []
    raw[0]["at"] = 0.0
    total = p["frames"] / FPS
    out: list[dict] = []
    for i, c in enumerate(raw):
        if out and c["at"] - out[-1]["at"] < min_len:
            out[-1]["title"] = f"{out[-1]['title']} · {c['title']}"
            continue
        out.append(dict(c))
    if len(out) > 1 and total - out[-1]["at"] < min_len:
        last = out.pop()
        out[-1]["title"] = f"{out[-1]['title']} · {last['title']}"
    return [{"at": round(c["at"], 2), "title": c["title"]} for c in out]


def clock(t: float) -> str:
    t = int(t)
    return f"{t // 60}:{t % 60:02d}"


def thumbnail(video: Path, frame: int, text: str, out: Path) -> None:
    """1280x720 thumbnail: a frame of the video with the title on a brand pill."""
    from PIL import Image, ImageDraw, ImageFont

    tmp = out.with_suffix(".frame.png")
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(video), "-vf", f"select=eq(n\\,{frame}),scale=1280:720", "-frames:v", "1", str(tmp)], check=True)
    img = Image.open(tmp).convert("RGB")
    d = ImageDraw.Draw(img)
    font = ImageFont.truetype(str(reels.FONT), 64) if reels.FONT.exists() else ImageFont.load_default()
    lines, cur = [], ""
    for w in text.split():
        if d.textlength(f"{cur} {w}".strip(), font=font) > 1100 and cur:
            lines.append(cur)
            cur = w
        else:
            cur = f"{cur} {w}".strip()
    lines.append(cur)
    y = 48
    for ln in lines:
        wpx = d.textlength(ln, font=font)
        d.rounded_rectangle([40, y - 6, 40 + wpx + 40, y + 74], radius=18, fill=(91, 69, 214))
        d.text((60, y), ln, font=font, fill=(255, 255, 255))
        y += 84
    img.save(out, quality=90)
    tmp.unlink(missing_ok=True)


def cmd_meta(a) -> int:
    cat = catalog()
    tuts = {t["id"]: t for t in cat["tutorials"]}
    lists = {t: [p for p in cat["playlists"] if t in p["items"] and p.get("youtube")] for t in tuts}
    ydir = OUT / "youtube"
    for s in tutorial_stories(a.ids):
        t = tuts[s["id"]]
        man = {"id": s["id"], "title": {}, "who": t["who"], "summary": t["summary"], "learn_url": f"/learn/{s['id']}", "try_url": t["tryHref"],
               "fictional": "Brightside Studio demo company on pulse-dev; every person, company and amount is made up",
               "playlists": [p["youtube"] for p in lists[s["id"]]], "videos": {}, "reels": {}, "captions": {}, "chapters": {}, "moments": {}, "voice": {}}
        for lang in a.langs:
            pf = ydir / f"{s['id']}-{lang}.plan.json"
            if not pf.exists():
                continue
            p = json.loads(pf.read_text(encoding="utf-8"))
            stem = f"{s['id']}-{lang}"
            man["title"][lang] = title(s, lang)
            man["videos"][lang] = f"youtube/{stem}.mp4"
            if (OUT / "reels" / f"{stem}.mp4").exists():
                man["reels"][lang] = f"reels/{stem}.mp4"
            man["voice"][lang] = has_voice(s, lang)
            caps = {lang if lang == "en" else f"{lang}-Latn": caption_entries(p, s, lang, "roman")}
            if lang != "en":
                caps[lang] = caption_entries(p, s, lang, "native")
            for cl, ent in caps.items():
                (ydir / f"{stem}.{cl}.srt").write_text(words.srt(ent), encoding="utf-8")
                (ydir / f"{stem}.{cl}.vtt").write_text(vtt(ent), encoding="utf-8")
                man["captions"][cl] = {"srt": f"youtube/{stem}.{cl}.srt", "vtt": f"youtube/{stem}.{cl}.vtt"}
            (ydir / f"{stem}.transcript.txt").write_text("\n".join(e[2].replace("\n", " ") for e in caps[lang if lang == "en" else f"{lang}-Latn"]) + "\n", encoding="utf-8")
            (ydir / f"{stem}.cues.csv").write_text(timeline.cue_sheet(p), encoding="utf-8")
            ch = chapters(p, s, lang)
            man["chapters"][lang] = ch
            man["moments"][lang] = chapters(p, s, lang, min_len=0)  # every step, for the Learn page
            man["seconds"] = round(p["frames"] / FPS, 2)
            thumb = ydir / f"{stem}.thumbnail.jpg"
            thumbnail(ydir / f"{stem}.mp4", min(p["frames"] - 1, p["end"]["start"] + 20), title(s, lang), thumb)
            steps = "\n".join(f"{i + 1}. {re.sub(r'[*]{2}', '', st['text'])}" for i, st in enumerate(t["steps"])) if lang == "en" else ""
            desc = [s.get("youtube", {}).get(lang) or t["summary"], ""]
            if ch and len(ch) >= 3:
                desc += ["Chapters"] + [f"{clock(c['at'])} {c['title']}" for c in ch] + [""]
            else:  # too short for YouTube chapters (three of at least 10 s): the moments as plain lines
                moments = chapters(p, s, lang, min_len=0)
                if moments:
                    desc += ["In this video"] + [f"{clock(c['at'])} {c['title']}" for c in moments] + [""]
            if steps:
                desc += ["Steps", steps, ""]
            desc += [f"Who it's for: {t['who']}.", "", CHANNEL_NOTE[lang]]
            tags = ["Pulse", "Estate Autopilots", "work app", "tutorial", *t.get("tags", []), *(["Hinglish", "Hindi"] if lang == "hi" else [])]
            yt = f"TITLE\n{title(s, lang)} | Pulse tutorial\n\nDESCRIPTION\n" + "\n".join(desc).strip() + "\n\nTAGS\n" + ", ".join(dict.fromkeys(tags)) + \
                 "\n\nPLAYLISTS\n" + "\n".join(man["playlists"]) + f"\n\nCAPTIONS\n" + "\n".join(f"{cl}: {v['srt']}" for cl, v in man["captions"].items() if cl.split('-')[0] == lang) + \
                 f"\n\nTHUMBNAIL\nyoutube/{stem}.thumbnail.jpg\n"
            (ydir / f"{stem}.youtube.txt").write_text(yt, encoding="utf-8")
        if man["videos"]:
            (ydir / f"{s['id']}.json").write_text(json.dumps(man, ensure_ascii=False, indent=1), encoding="utf-8")
            print(f"{s['id']}: meta for {', '.join(man['videos'])}")
    return 0


def cmd_playlists(_a) -> int:
    cat = catalog()
    made = {p.stem for p in (OUT / "youtube").glob("*.json")}
    out = []
    for p in cat["playlists"]:
        if not p.get("youtube"):
            continue
        out.append({"id": p["id"], "title": p["youtube"], "description": p["about"], "kind": p["kind"],
                    "videos": [{"tutorial": i, "en": f"youtube/{i}-en.mp4", "hi": f"youtube/{i}-hi.mp4", "made": i in made} for i in p["items"]]})
    (OUT / "playlists.json").write_text(json.dumps({"channel": "to be chosen by the owner (decision card xray-learn-youtube)", "playlists": out}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{len(out)} playlists -> {OUT / 'playlists.json'}")
    return 0


def cmd_web(a) -> int:
    """720p web cuts for the Learn page (small: CRF 30, AAC 96k) and learn-media.json."""
    media = Path(a.media)
    data = json.loads(MEDIA_JSON.read_text(encoding="utf-8")) if MEDIA_JSON.exists() else {}
    data.setdefault("tutorials", {})
    for s in tutorial_stories(a.ids):
        mf = OUT / "youtube" / f"{s['id']}.json"
        if not mf.exists():
            continue
        man = json.loads(mf.read_text(encoding="utf-8"))
        dest = media / s["id"]
        dest.mkdir(parents=True, exist_ok=True)
        rec = {"id": s["id"], "seconds": man.get("seconds"), "chapters": man.get("moments", man["chapters"]).get("en", []), "voice": man["voice"].get("en", False),
               "video": {}, "captions": {}, "youtube": data["tutorials"].get(s["id"], {}).get("youtube", {})}
        for lang, rel in man["videos"].items():
            name = f"{s['id']}-{lang}.mp4"
            reels.guard()
            subprocess.run(["nice", "-n", "19", "ffmpeg", "-loglevel", "error", "-y", "-i", str(OUT / rel), "-vf", "scale=1280:720:flags=lanczos", "-c:v", "libx264",
                            "-preset", "slow", "-crf", "30", "-threads", "2", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", str(dest / name)], check=True)
            rec["video"][lang] = name
        for cl, v in man["captions"].items():
            name = Path(v["vtt"]).name
            shutil.copy(OUT / v["vtt"], dest / name)
            rec["captions"][cl] = name
        thumb = OUT / "youtube" / f"{s['id']}-en.thumbnail.jpg"
        if thumb.exists():
            shutil.copy(thumb, dest / "poster.jpg")
            rec["poster"] = "poster.jpg"
        data["tutorials"][s["id"]] = rec
        print(f"{s['id']}: web cuts in {dest}")
    data["made"] = reels.DATE
    MEDIA_JSON.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    return 0


def cmd_webp(a) -> int:
    src = Path(a.ids[0]) if a.ids else None
    if not src or not src.is_dir():
        print("usage: learn.py webp <shots dir>")
        return 2
    n = 0
    for png in sorted(src.glob("*/[0-9]*.png")):
        dest = SHOTS_PUBLIC / png.parent.name / f"{png.stem}.webp"
        dest.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(["nice", "-n", "19", "ffmpeg", "-loglevel", "error", "-y", "-i", str(png), "-c:v", "libwebp", "-quality", "72", "-compression_level", "6", str(dest)], check=True)
        n += 1
    print(f"{n} screenshots -> {SHOTS_PUBLIC}")
    return 0


def cmd_report(_a) -> int:
    rows = ["| Tutorial | Language | Length | Voice | QA | Files |", "|---|---|---|---|---|---|"]
    for mf in sorted((OUT / "youtube").glob("*.json")):
        if mf.name.endswith(".plan.json"):
            continue
        m = json.loads(mf.read_text(encoding="utf-8"))
        if not isinstance(m, dict) or "videos" not in m:  # plans and QA records share the folder
            continue
        for lang, rel in m["videos"].items():
            qa_f = OUT / "youtube" / f"{m['id']}-{lang}-qa.json"
            q = json.loads(qa_f.read_text()) if qa_f.exists() else {}
            rows.append(f"| {m['id']} | {lang} | {m.get('seconds')} s | {'yes' if m['voice'].get(lang) else 'captions only'} | "
                        f"{'pass' if q.get('pass') else '; '.join(q.get('issues', [])) or 'n/a'} | {rel}, {m['id']}-{lang}.youtube.txt |")
    text = f"# Pulse Learn videos, {reels.DATE}\n\nAll people, companies and amounts on screen are fictional (Brightside Studio on pulse-dev).\n\n" + "\n".join(rows) + "\n"
    (OUT / "LEARN.md").write_text(text, encoding="utf-8")
    print(text)
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("build", "meta", "playlists", "web", "webp", "report"):
        sp = sub.add_parser(name)
        sp.add_argument("ids", nargs="*")
        sp.add_argument("--langs", type=lambda v: v.split(","), default=["en", "hi"])
        sp.add_argument("--formats", type=lambda v: v.split(","), default=["wide", "reel"])
        sp.add_argument("--silent", action="store_true", help="build a language without voice from its captions")
        sp.add_argument("--media", default=str(ROOT / "apps/web/.learn-media"))
    a = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "youtube").mkdir(exist_ok=True)
    return {"build": cmd_build, "meta": cmd_meta, "playlists": cmd_playlists, "web": cmd_web, "webp": cmd_webp, "report": cmd_report}[a.cmd](a)


if __name__ == "__main__":
    raise SystemExit(main())
