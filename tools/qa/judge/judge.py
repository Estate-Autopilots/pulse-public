#!/usr/bin/env python3
"""The shared screenshot judge (QA-1 step 2, owner, 18 Nov 2026; QA-SYSTEM-RESEARCH §4.6): a fresh session looks at
small pictures and returns a table, so a working session never reads a PNG itself.

    python3 tools/qa/judge/judge.py [--model sonnet] [--out judge.md] [--scope "..."] SHOTS_DIR_OR_PNG ...
    python3 tools/qa/judge/judge.py --before OLD_DIR --after NEW_DIR [--question "..."] [--out judge.md]
    ... --dry-run   (prepare the pictures and print the plan and the token estimate; no model is called)

  * 1x pictures. A capture made at device scale 2 or 3 is brought back to its CSS width (from --width, else the width in
    the file name, e.g. tasks-363-dark.png or tasks-1440-light.png; else at most 1440 px), so a phone screen costs about
    350 tokens, not 3,100. Long pages are cut into screen-high slices (--slice-height; at most --max-slices each).
  * Crops. With --before/--after (two folders, files paired by name, or --pair OLD NEW) only what changed is judged: the
    box around the changed pixels (plus a margin), from both pictures. A pair with no change never reaches a model.
  * The judge is asked about looks only (alignment, spacing, hierarchy, clarity, words). Overflow, overlap, cut text,
    contrast and tap sizes are measured by the Readability Gate script, exactly and for no tokens; the judge is told not
    to score them.
  * The model: --model (default sonnet; haiku for a first look at diff crops; opus only for a hard root cause). It runs as
    `claude -p` with the Read tool only, in a folder holding just the prepared pictures, with no session kept.
  * Output: the full table goes to --out; stdout gets only the rows under --flag-below, the LOWEST line, and the tokens
    and cost of the run. Exit 0 judged (or dry run), 2 bad arguments or nothing to judge, 3 the judge failed.

Needs ffmpeg and ffprobe (scaling, cropping, the changed-pixel box).
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

WIDTHS = (320, 360, 363, 375, 390, 393, 412, 414, 430, 768, 820, 1024, 1280, 1366, 1440, 1536, 1920)
SCALES = (1.0, 1.5, 2.0, 2.625, 3.0, 3.5, 4.0)
MAX_WIDTH = 1440
TOKENS_PER_PX = 1 / 750          # Anthropic's image-token estimate: width × height / 750
DEFAULT_QUESTION = "Is the AFTER picture at least as clear and tidy as BEFORE? Name anything that got worse."
LOOKS_ONLY = ("Do NOT score or mention overflow, overlap, cut-off text, colour contrast or tap-target sizes: a script measures "
              "those exactly. Judge only what a script cannot: alignment, spacing, hierarchy, clarity and wording.")


@dataclass
class Shot:
    name: str                    # the name the judge sees
    source: Path
    css_width: int
    scale: float                 # source px per CSS px
    box: tuple[int, int, int, int] | None = None   # x, y, w, h in source px (a crop), else the whole picture
    slices: list[tuple[int, int]] = field(default_factory=list)   # (y, h) in CSS px of the (cropped) picture


def probe(path: Path) -> tuple[int, int]:
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
                          "-of", "csv=p=0:s=x", str(path)], capture_output=True, text=True, check=True).stdout.strip()
    w, h = out.split("x")[:2]
    return int(w), int(h)


def css_width_of(name: str, px_width: int, given: int | None) -> tuple[int, float]:
    """The CSS width the page was captured at, and the device scale: --width, else a viewport width in the file name that
    the picture is a whole multiple of, else the picture itself capped at MAX_WIDTH."""
    if given:
        return given, px_width / given
    for token in re.findall(r"(?<!\d)(\d{3,4})(?!\d)", name):
        w = int(token)
        if w in WIDTHS and any(abs(px_width - w * s) <= 2 for s in SCALES):
            return w, px_width / w
    if px_width <= MAX_WIDTH:
        return px_width, 1.0
    return MAX_WIDTH, px_width / MAX_WIDTH


def plan_slices(height_css: int, slice_height: int, max_slices: int) -> list[tuple[int, int]]:
    n = max(1, math.ceil(height_css / slice_height))
    return [(i * slice_height, min(slice_height, height_css - i * slice_height)) for i in range(min(n, max_slices))]


def changed_box(before: Path, after: Path, margin: int) -> tuple[int, int, int, int] | None:
    """The box around the pixels that differ (ffmpeg blend difference + bbox), in source px, with a margin; None when the
    two pictures are the same. Pictures of different sizes count as changed everywhere."""
    (bw, bh), (aw, ah) = probe(before), probe(after)
    if (bw, bh) != (aw, ah):
        return (0, 0, aw, ah)
    r = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", str(before), "-i", str(after), "-filter_complex",
                        "[0:v]format=rgb24[a];[1:v]format=rgb24[b];[a][b]blend=all_mode=difference,format=gray,bbox=min_val=12",
                        "-f", "null", "-"], capture_output=True, text=True, check=True)
    boxes = [tuple(int(v) for v in m) for m in re.findall(r"x1:(\d+) x2:(\d+) y1:(\d+) y2:(\d+)", r.stderr)]
    if not boxes:
        return None
    x1, x2, y1, y2 = boxes[-1]
    x1, y1 = max(0, x1 - margin), max(0, y1 - margin)
    x2, y2 = min(aw - 1, x2 + margin), min(ah - 1, y2 + margin)
    return (x1, y1, x2 - x1 + 1, y2 - y1 + 1)


def render(shot: Shot, out_dir: Path) -> list[Path]:
    """Write the 1x slices of a shot (cropped first when it has a box). Returns the files written."""
    x, y, w, h = shot.box or (0, 0, *probe(shot.source))
    css_w, css_h = round(w / shot.scale), round(h / shot.scale)
    files = []
    stem = Path(shot.name).stem
    for i, (sy, sh) in enumerate(shot.slices or [(0, css_h)]):
        target = out_dir / (f"{stem}.png" if len(shot.slices) <= 1 else f"{stem}-s{i + 1}.png")
        vf = f"crop={w}:{h}:{x}:{y},scale={css_w}:{css_h}:flags=area,crop={css_w}:{sh}:0:{sy}"
        subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(shot.source), "-vf", vf, str(target)],
                       check=True)
        files.append(target)
    return files


def collect(paths: list[str]) -> list[Path]:
    out: list[Path] = []
    for p in map(Path, paths):
        if p.is_dir():
            out.extend(sorted(f for f in p.glob("*.png") if "failure" not in f.name))
        elif p.suffix.lower() == ".png" and p.exists():
            out.append(p)
        else:
            raise SystemExit(f"judge: not a PNG or a folder: {p}")
    return out


def pairs_of(args) -> list[tuple[Path, Path]]:
    pairs = [(Path(a), Path(b)) for a, b in (args.pair or [])]
    if args.before or args.after:
        if not (args.before and args.after):
            raise SystemExit("judge: --before and --after go together")
        old = {f.name: f for f in collect([args.before])}
        pairs += [(old[f.name], f) for f in collect([args.after]) if f.name in old]
    return pairs


def prompt_for(files: list[str], scope: str, diff: bool, question: str) -> str:
    listing = " ".join(files)
    head = ("You are a strict UI judge for a small-business work app (users are busy, not tech-savvy). Data is synthetic. "
            f"Use the Read tool to look at EACH of these pictures in the current folder: {listing}\n"
            "Pictures are at 1x. A file name says the screen, the width (363 or 390 = phone, 1440 = computer) and light or dark "
            "mode; -s2, -s3 are the same page further down.\n")
    if diff:
        body = ("Files come in pairs: NAME.before.png and NAME.after.png are the SAME region of a screen before and after a "
                f"change (only the changed region is shown). For each pair answer: {question}\n"
                "Output ONLY a markdown table: | pair | verdict (better / same / worse) | overall (1-10, the AFTER picture) | "
                "what changed for the worse (or none) | with one row per pair, then a final line 'LOWEST: <the lowest overall score in the table>'.")
    else:
        body = ("Score each file 1-10 on: alignment, spacing, hierarchy, clarity in 2 seconds (can a user tell what this is "
                "and what to do), delight (feels good, calm) and plain words (6th-7th grade). Be honest and specific; do not inflate.\n"
                "Output ONLY a markdown table: | file | align | spacing | hierarchy | clarity | delight | words | overall | top fix | "
                "with one row per file (overall = your overall score, not an average), then a final line 'LOWEST: <the lowest overall score in the table>'.")
    return head + LOOKS_ONLY + "\n" + (scope + "\n" if scope else "") + body


def summary(table: str, flag_below: int) -> list[str]:
    """The rows whose overall score is under flag_below, and the LOWEST line."""
    out = []
    for line in table.splitlines():
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if not line.lstrip().startswith("|") or len(cells) < 3:
            continue
        nums = [c for c in cells if re.fullmatch(r"\d+(\.\d+)?", c)]
        if nums and float(nums[-1]) < flag_below:
            out.append(line.strip()[:220])
    out += [line.strip() for line in table.splitlines() if line.strip().startswith("LOWEST")]
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("shots", nargs="*", help="PNG files or folders of them")
    ap.add_argument("--before", help="folder of the approved pictures (pairs with --after by file name)")
    ap.add_argument("--after", help="folder of the new pictures")
    ap.add_argument("--pair", nargs=2, action="append", metavar=("OLD", "NEW"))
    ap.add_argument("--question", default=DEFAULT_QUESTION, help="the one narrow question for before/after pairs")
    ap.add_argument("--model", default=os.environ.get("JUDGE_MODEL", "sonnet"), help="sonnet (default), haiku or opus")
    ap.add_argument("--out", type=Path, help="where the full table goes (default: judge.md beside the first picture)")
    ap.add_argument("--scope", default=os.environ.get("SCOPE", ""), help="what the screens are and what not to score")
    ap.add_argument("--width", type=int, help="the CSS width every picture was captured at")
    ap.add_argument("--slice-height", type=int, help="CSS px per slice (default 800 on phones, 900 on wider screens)")
    ap.add_argument("--max-slices", type=int, default=4)
    ap.add_argument("--margin", type=int, default=24, help="CSS px around a changed region")
    ap.add_argument("--flag-below", type=int, default=8, help="print rows whose overall score is under this")
    ap.add_argument("--keep", type=Path, help="keep the prepared pictures in this folder")
    ap.add_argument("--dry-run", action="store_true", help="prepare the pictures and print the plan; call no model")
    ap.add_argument("--timeout", type=int, default=1500)
    args = ap.parse_args(argv)
    for tool in ("ffmpeg", "ffprobe"):
        if not shutil.which(tool):
            print(f"judge: {tool} is needed", file=sys.stderr)
            return 2
    if args.model not in ("sonnet", "haiku", "opus") and not args.model.startswith("claude-"):
        print("judge: --model is sonnet, haiku, opus or a claude-* model id", file=sys.stderr)
        return 2

    pairs = pairs_of(args)
    diff = bool(pairs)
    singles = [] if diff else collect(args.shots)
    if not pairs and not singles:
        print("judge: nothing to judge", file=sys.stderr)
        return 2
    work = Path(tempfile.mkdtemp(prefix="judge-"))
    shots: list[Shot] = []
    unchanged: list[str] = []
    try:
        if diff:
            for old, new in pairs:
                w, _h = probe(new)
                css, scale = css_width_of(new.name, w, args.width)
                box = changed_box(old, new, round(args.margin * scale))
                if box is None:
                    unchanged.append(new.name)
                    continue
                for tag, src in (("before", old), ("after", new)):
                    shots.append(Shot(f"{Path(new.name).stem}.{tag}.png", src, css, scale, box))
        else:
            for f in singles:
                w, _h = probe(f)
                css, scale = css_width_of(f.name, w, args.width)
                shots.append(Shot(f.name, f, css, scale))
        files: list[Path] = []
        pixels = 0
        for s in shots:
            _x, _y, bw, bh = s.box or (0, 0, *probe(s.source))
            css_h = round(bh / s.scale)
            sh = args.slice_height or (800 if s.css_width < 768 else 900)
            s.slices = plan_slices(css_h, sh, args.max_slices)
            written = render(s, work)
            files += written
            pixels += sum(round(bw / s.scale) * h for _y, h in s.slices)
        est = round(pixels * TOKENS_PER_PX)
        plan = (f"judge: {len(files)} picture(s) at 1x from {len(shots)} shot(s), about {est:,} image tokens, model {args.model}"
                + (f"; {len(unchanged)} unchanged pair(s) not judged" if unchanged else ""))
        print(plan)
        if args.keep:
            args.keep.mkdir(parents=True, exist_ok=True)
            for f in files:
                shutil.copy2(f, args.keep / f.name)
        if args.dry_run or not files:
            for f in files:
                print(f"  {f.name}")
            return 0
        prompt = prompt_for([f.name for f in files], args.scope, diff, args.question)
        cmd = ["claude", "-p", "--model", args.model, "--output-format", "json", "--no-session-persistence",
               "--allowedTools", "Read", "--disallowedTools", "Bash", "Write", "Edit", "Agent", "Task", "WebFetch", "WebSearch",
               "--permission-mode", "default", prompt]
        try:
            r = subprocess.run(cmd, cwd=work, capture_output=True, text=True, timeout=args.timeout, check=False)
        except subprocess.TimeoutExpired:
            print(f"judge: the model did not answer in {args.timeout} s", file=sys.stderr)
            return 3
        try:
            res = json.loads(r.stdout)
        except json.JSONDecodeError:
            print(f"judge: the model's answer was not JSON (exit {r.returncode}): {(r.stdout or r.stderr)[-400:]}", file=sys.stderr)
            return 3
        table = str(res.get("result") or "")
        out = args.out or ((pairs[0][1] if diff else singles[0]).parent / "judge.md")
        out.write_text(table + ("\n\nUnchanged, not judged: " + ", ".join(unchanged) if unchanged else "") + "\n", encoding="utf-8")
        u = res.get("usage") or {}
        tokens = sum(int(u.get(k) or 0) for k in ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens"))
        for line in summary(table, args.flag_below):
            print(line)
        print(f"judge: {'failed' if res.get('is_error') else 'done'} -> {out} ({tokens:,} tokens, ${float(res.get('total_cost_usd') or 0):.3f}, {args.model})")
        return 3 if res.get("is_error") or r.returncode else 0
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
