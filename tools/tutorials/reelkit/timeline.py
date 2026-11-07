"""Editor handoff from a plan: FCPXML (Final Cut, DaVinci Resolve), FCP7 XML (Premiere), a cue sheet, a timecoded
script and SRT captions. Media paths are relative to the pack folder (relink once after copying)."""

from __future__ import annotations

import csv
import io
from pathlib import Path
from xml.sax.saxutils import escape, quoteattr

from .words import srt, wrap

FPS = 30


def tc(f: int) -> str:
    s, fr = divmod(int(f), FPS)
    m, s = divmod(s, 60)
    h, m = divmod(m, 60)
    return f"{h:02}:{m:02}:{s:02}:{fr:02}"


def r(f: int) -> str:
    return f"{int(f)}/{FPS}s"


def fcpxml(name: str, size: tuple[int, int], total: int, clips: list[dict], audio: list[dict]) -> str:
    """clips: [{path, start, frames}] on the spine; audio: [{path, start, frames, lane, role}] connected below."""
    assets, ids = [], {}
    for c in clips + audio:
        if c["path"] in ids:
            continue
        ids[c["path"]] = f"a{len(ids) + 1}"
        has_v = "1" if c in clips else "0"
        assets.append(f'<asset id="{ids[c["path"]]}" name={quoteattr(Path(c["path"]).name)} src={quoteattr(c["path"])} start="0s" '
                      f'duration="{r(c.get("asset_frames", c["frames"]))}" hasVideo="{has_v}" hasAudio="{"0" if has_v == "1" else "1"}" '
                      f'format="r1" audioSources="1" audioChannels="2" audioRate="48000"/>')
    conn = "".join(f'<asset-clip ref="{ids[a["path"]]}" lane="{a["lane"]}" offset="{r(a["start"])}" duration="{r(a["frames"])}" '
                   f'start="0s" name={quoteattr(Path(a["path"]).name)} audioRole="{a.get("role", "dialogue")}"/>' for a in audio)
    spine = []
    for i, c in enumerate(clips):
        inner = conn if i == 0 else ""
        spine.append(f'<asset-clip ref="{ids[c["path"]]}" offset="{r(c["start"])}" duration="{r(c["frames"])}" start="0s" '
                     f'name={quoteattr(Path(c["path"]).name)}>{inner}</asset-clip>')
    w, h = size
    return ('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE fcpxml>\n<fcpxml version="1.10">'
            f'<resources><format id="r1" frameDuration="1/{FPS}s" width="{w}" height="{h}"/>{"".join(assets)}</resources>'
            f'<library><event name={quoteattr(name)}><project name={quoteattr(name)}>'
            f'<sequence format="r1" duration="{r(total)}" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">'
            f'<spine>{"".join(spine)}</spine></sequence></project></event></library></fcpxml>\n')


def xmeml(name: str, size: tuple[int, int], total: int, clips: list[dict], audio: list[dict]) -> str:
    rate = f"<rate><timebase>{FPS}</timebase><ntsc>FALSE</ntsc></rate>"
    files: dict[str, str] = {}

    def file_el(path: str, frames: int, video: bool) -> str:
        if path in files:
            return f'<file id="{files[path]}"/>'
        files[path] = f"file-{len(files) + 1}"
        media = (f"<media><video><samplecharacteristics><width>{size[0]}</width><height>{size[1]}</height></samplecharacteristics></video></media>"
                 if video else "<media><audio><channelcount>2</channelcount></audio></media>")
        return (f'<file id="{files[path]}"><name>{escape(Path(path).name)}</name><pathurl>{escape(path)}</pathurl>{rate}'
                f"<duration>{frames}</duration>{media}</file>")

    def item(c: dict, n: int, video: bool) -> str:
        return (f'<clipitem id="clip-{n}"><name>{escape(Path(c["path"]).name)}</name><duration>{c.get("asset_frames", c["frames"])}</duration>{rate}'
                f'<start>{c["start"]}</start><end>{c["start"] + c["frames"]}</end><in>0</in><out>{c["frames"]}</out>'
                f'{file_el(c["path"], c.get("asset_frames", c["frames"]), video)}</clipitem>')

    n = 0
    vt = []
    for c in clips:
        n += 1
        vt.append(item(c, n, True))
    lanes: dict[int, list[str]] = {}
    for a in audio:
        n += 1
        lanes.setdefault(a["lane"], []).append(item(a, n, False))
    atracks = "".join(f"<track>{''.join(v)}</track>" for _, v in sorted(lanes.items(), reverse=True))
    return ('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n<xmeml version="5"><sequence>'
            f"<name>{escape(name)}</name><duration>{total}</duration>{rate}<media><video><format><samplecharacteristics>"
            f"<width>{size[0]}</width><height>{size[1]}</height>{rate}</samplecharacteristics></format>"
            f"<track>{''.join(vt)}</track></video><audio>{atracks}</audio></media></sequence></xmeml>\n")


def cue_sheet(plan: dict) -> str:
    rows = []
    for b in plan["beats"]:
        rows.append((b["start"], "cut", b["id"], b["transition"]))
        for k in b["camera"]:
            rows.append((b["start"] + k["f"], "zoom", b["id"], f"x={k['cx']:.0f} y={k['cy']:.0f} z={k['z']:.2f}"))
        if b.get("hook"):
            rows.append((b["start"], "hook text", b["id"], b["hook"]))
    for v in plan["voice"]:
        rows.append((v["f"], "voice", v["beat"], Path(v["file"]).name))
    for s in plan["sfx"]:
        rows.append((s["f"], "sfx", s.get("beat", ""), s["name"]))
    for c in plan["captions"]:
        rows.append((c["f0"], "caption", c.get("beat", ""), " ".join(w["text"] for w in c["words"])))
    rows.append((plan["end"]["start"], "end card", "end", plan["end"]["text"]))
    rows.sort(key=lambda x: (x[0], x[1]))
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["timecode", "frame", "type", "beat", "detail"])
    for f, typ, beat, detail in rows:
        w.writerow([tc(f), f, typ, beat, detail])
    return buf.getvalue()


def script_md(plan: dict, story: dict, lang: str) -> str:
    lines = [f"# {plan['title']} ({lang})", "", f"30 fps, {plan['frames']} frames ({plan['frames'] / FPS:.1f} s). Times are where each shot starts.", "",
             "| Timecode | Shot | On screen | Voice (as sent to ElevenLabs) | Caption |", "|---|---|---|---|---|"]
    beats = {b["id"]: b for b in story["beats"]}
    for b in plan["beats"]:
        line = beats[b["id"]].get("line", {}).get(lang, {})
        lines.append(f"| {tc(b['start'])} | {b['id']} | {b.get('hook') or ''} | {line.get('say', '')} | {line.get('cap', '').replace('*', '')} |")
    lines.append(f"| {tc(plan['end']['start'])} | end card | Pulse: {plan['end']['text']} | | |")
    return "\n".join(lines) + "\n"


def captions_srt(plan: dict, words: bool = False) -> str:
    if words:
        entries = [(w["f0"] / FPS, w["f1"] / FPS, w["text"]) for c in plan["captions"] for w in c["words"]]
    else:  # one entry per voice line, wrapped to two lines of 42
        by_beat: dict[str, list] = {}
        for c in plan["captions"]:
            by_beat.setdefault(c.get("beat", ""), []).append(c)
        entries = [(cs[0]["f0"] / FPS, cs[-1]["f1"] / FPS, wrap(" ".join(w["text"] for c in cs for w in c["words"])))
                   for cs in by_beat.values()]
    return srt(entries)
