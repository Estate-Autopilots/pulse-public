"""Automatic QA before delivery: ffprobe spec, a contact sheet of the first frame after every cut, black and frozen
frame scans, a loudness report (EBU R128) and the caption overflow check from the render."""

from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


def probe(path: Path) -> dict:
    out = json.loads(subprocess.run(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)],
                                    capture_output=True, text=True, check=True).stdout)
    v = next(s for s in out["streams"] if s["codec_type"] == "video")
    a = next((s for s in out["streams"] if s["codec_type"] == "audio"), {})
    return {"width": v["width"], "height": v["height"], "fps": v["r_frame_rate"], "frames": int(v.get("nb_frames", 0)),
            "video_kbps": round(int(v.get("bit_rate", 0)) / 1000), "audio_kbps": round(int(a.get("bit_rate", 0)) / 1000),
            "audio_hz": a.get("sample_rate"), "seconds": round(float(out["format"]["duration"]), 2),
            "mb": round(int(out["format"]["size"]) / 1e6, 2), "profile": v.get("profile")}


def scan(path: Path) -> dict:
    err = subprocess.run(["nice", "-n", "19", "ffmpeg", "-hide_banner", "-threads", "2", "-i", str(path), "-vf",
                          "blackdetect=d=0.1:pix_th=0.08,freezedetect=n=-60dB:d=1.2", "-af", "ebur128=peak=true",
                          "-f", "null", "-"], capture_output=True, text=True).stderr
    black = [dict(zip(("start", "end", "duration"), map(float, m))) for m in
             re.findall(r"black_start:([\d.]+) black_end:([\d.]+) black_duration:([\d.]+)", err)]
    freezes = [float(x) for x in re.findall(r"freeze_duration: ([\d.]+)", err)]
    starts = [float(x) for x in re.findall(r"freeze_start: ([\d.]+)", err)]
    summary = err[err.rfind("Summary:"):]
    num = lambda k: float(re.search(rf"{k}:\s+(-?[\d.]+)", summary).group(1)) if re.search(rf"{k}:\s+(-?[\d.]+)", summary) else None
    return {"black": black, "freeze": [{"start": s, "duration": d} for s, d in zip(starts, freezes)],
            "loudness": {"integrated_lufs": num("I"), "lra": num("LRA"), "true_peak_dbtp": num("Peak")}}


def contact_sheet(video: Path, frames: list[tuple[int, str]], out: Path, cols: int = 6, thumb_w: int = 270) -> Path:
    """First frame after every cut, labelled with its frame number and beat."""
    thumbs = []
    for f, label in frames:
        png = subprocess.run(["ffmpeg", "-loglevel", "error", "-i", str(video), "-vf", f"select=eq(n\\,{f}),scale={thumb_w}:-1",
                              "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-"], capture_output=True).stdout
        if not png:
            continue
        from io import BytesIO
        im = Image.open(BytesIO(png)).convert("RGB")
        canvas = Image.new("RGB", (im.width, im.height + 34), (20, 18, 34))
        canvas.paste(im, (0, 34))
        ImageDraw.Draw(canvas).text((8, 8), f"{f}  {label}"[:40], fill=(255, 255, 255), font=ImageFont.load_default(16))
        thumbs.append(canvas)
    if not thumbs:
        raise RuntimeError("no frames for the contact sheet")
    w, h = thumbs[0].size
    rows = (len(thumbs) + cols - 1) // cols
    sheet = Image.new("RGB", (w * min(cols, len(thumbs)) + 8 * (min(cols, len(thumbs)) + 1), h * rows + 8 * (rows + 1)), (245, 245, 250))
    for i, t in enumerate(thumbs):
        sheet.paste(t, (8 + (i % cols) * (w + 8), 8 + (i // cols) * (h + 8)))
    sheet.save(out, quality=90)
    return out


def check(video: Path, plan: dict, render_report: dict, sheet: Path, expect: tuple[int, int]) -> dict:
    p = probe(video)
    s = scan(video)
    cuts = [(b["start"], b["id"]) for b in plan["beats"]] + [(plan["end"]["start"], "end card")]
    contact_sheet(video, cuts, sheet)
    lufs = s["loudness"]["integrated_lufs"]
    tp = s["loudness"]["true_peak_dbtp"]
    issues = []
    if (p["width"], p["height"]) != expect:
        issues.append(f"size {p['width']}x{p['height']}")
    if p["fps"] != "30/1":
        issues.append(f"fps {p['fps']}")
    if p["frames"] and abs(p["frames"] - plan["frames"]) > 1:
        issues.append(f"frames {p['frames']} vs plan {plan['frames']}")
    if s["black"]:
        issues.append(f"{len(s['black'])} black stretch(es)")
    if s["freeze"]:
        issues.append(f"{len(s['freeze'])} frozen stretch(es) over 1.2 s")
    if lufs is None or abs(lufs - (-14)) > 1.0:
        issues.append(f"loudness {lufs} LUFS")
    if tp is not None and tp > -0.5:
        issues.append(f"true peak {tp} dBTP")
    if render_report.get("overflow"):
        issues.append(f"{len(render_report['overflow'])} caption overflow(s)")
    return {"video": video.name, "probe": p, "scan": s, "overflow": render_report.get("overflow", []),
            "cuts": len(cuts), "pass": not issues, "issues": issues}
