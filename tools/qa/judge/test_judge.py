"""tools/qa/judge/judge.py (QA-1 step 2): 1x pictures, slices, changed-region crops, the model flag (default Sonnet), and a
summary on stdout that never carries a picture. The model is a stand-in `claude` on PATH; synthetic pictures only."""
import json
import os
import shutil
import stat
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import judge

pytestmark = pytest.mark.skipif(not (shutil.which("ffmpeg") and shutil.which("ffprobe")), reason="ffmpeg is needed")
TOOL = Path(__file__).resolve().parent / "judge.py"


def png(path: Path, w: int, h: int, box: tuple[int, int, int, int] | None = None) -> Path:
    """A grey picture, with a red box drawn when given."""
    vf = f"drawbox=x={box[0]}:y={box[1]}:w={box[2]}:h={box[3]}:color=red:t=fill" if box else "null"
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", f"color=c=gray:s={w}x{h}",
                    "-frames:v", "1", "-vf", vf, str(path)], check=True)
    return path


def run(*argv, path_dir=None):
    env = dict(os.environ)
    if path_dir:
        env["PATH"] = f"{path_dir}:{env['PATH']}"
    return subprocess.run([sys.executable, str(TOOL), *argv], capture_output=True, text=True, env=env, timeout=120, check=False)


def test_css_width_from_the_name_or_the_picture():
    assert judge.css_width_of("tasks-363-dark.png", 726, None) == (363, 2.0)
    assert judge.css_width_of("home-1440-light.png", 2880, None) == (1440, 2.0)
    assert judge.css_width_of("lead-390-light.png", 1170, None) == (390, 3.0)
    assert judge.css_width_of("shot.png", 1200, None) == (1200, 1.0)
    assert judge.css_width_of("shot.png", 2880, None) == (1440, 2.0)
    assert judge.css_width_of("shot-2024.png", 800, 400) == (400, 2.0)
    assert judge.plan_slices(1500, 800, 4) == [(0, 800), (800, 700)]
    assert len(judge.plan_slices(9000, 800, 4)) == 4


def test_long_2x_phone_capture_becomes_1x_slices(tmp_path):
    png(tmp_path / "tasks-363-light.png", 726, 3000)
    keep = tmp_path / "kept"
    r = run(str(tmp_path / "tasks-363-light.png"), "--dry-run", "--keep", str(keep))
    assert r.returncode == 0, r.stderr
    assert "2 picture(s) at 1x from 1 shot(s)" in r.stdout
    sizes = sorted(judge.probe(f) for f in keep.glob("*.png"))
    assert sizes == [(363, 700), (363, 800)]


def test_only_the_changed_region_is_judged_and_unchanged_pairs_never_reach_a_model(tmp_path):
    old, new = tmp_path / "old", tmp_path / "new"
    old.mkdir(), new.mkdir()
    png(old / "home-1440-light.png", 2880, 1800)
    png(new / "home-1440-light.png", 2880, 1800, box=(1000, 600, 200, 100))
    png(old / "same-1440-dark.png", 2880, 1800)
    png(new / "same-1440-dark.png", 2880, 1800)
    keep = tmp_path / "kept"
    r = run("--before", str(old), "--after", str(new), "--dry-run", "--keep", str(keep), "--margin", "10")
    assert r.returncode == 0, r.stderr
    assert "1 unchanged pair(s) not judged" in r.stdout
    names = sorted(f.name for f in keep.glob("*.png"))
    assert names == ["home-1440-light.after.png", "home-1440-light.before.png"]
    w, h = judge.probe(keep / "home-1440-light.after.png")
    assert 100 <= w <= 125 and 50 <= h <= 75, (w, h)   # the 200x100 box at 2x is 100x50 CSS px, plus a 10 px margin


def test_the_judge_runs_fresh_with_the_model_flag_and_prints_only_a_summary(tmp_path):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    seen = tmp_path / "seen.json"
    fake = bin_dir / "claude"
    fake.write_text(f"""#!{sys.executable}
import json, os, sys
json.dump({{"argv": sys.argv[1:], "cwd": os.getcwd(), "files": sorted(os.listdir("."))}}, open({str(seen)!r}, "w"))
table = "| file | align | spacing | hierarchy | clarity | delight | words | overall | top fix |\\n|---|---|---|---|---|---|---|---|---|\\n"
table += "| a-363-light.png | 9 | 9 | 9 | 9 | 8 | 9 | 9 | none |\\n| b-363-dark.png | 6 | 7 | 6 | 7 | 6 | 8 | 6 | heading too faint |\\nLOWEST: 6"
print(json.dumps({{"result": table, "is_error": False, "total_cost_usd": 0.01,
                  "usage": {{"input_tokens": 900, "output_tokens": 120, "cache_read_input_tokens": 0}}}}))
""")
    fake.chmod(fake.stat().st_mode | stat.S_IXUSR)
    shots = tmp_path / "shots"
    shots.mkdir()
    png(shots / "a-363-light.png", 726, 1200)
    png(shots / "b-363-dark.png", 726, 1200)
    r = run(str(shots), path_dir=bin_dir)
    assert r.returncode == 0, r.stderr
    got = json.loads(seen.read_text())
    argv = got["argv"]
    assert argv[argv.index("--model") + 1] == "sonnet" and "--no-session-persistence" in argv
    assert argv[argv.index("--allowedTools") + 1] == "Read"
    assert got["files"] == ["a-363-light.png", "b-363-dark.png"] and got["cwd"] != str(shots)
    assert "overflow" in argv[-1] and "Do NOT score" in argv[-1]
    lines = r.stdout.strip().splitlines()
    assert any("b-363-dark.png" in line for line in lines) and not any("a-363-light.png |" in line for line in lines)
    assert "LOWEST: 6" in r.stdout and "1,020 tokens" in r.stdout and ", sonnet)" in r.stdout
    assert (shots / "judge.md").read_text().startswith("| file |")
    # --model haiku reaches the model; an unknown model is refused before anything runs.
    assert run(str(shots), "--model", "haiku", "--out", str(tmp_path / "j2.md"), path_dir=bin_dir).returncode == 0
    assert json.loads(seen.read_text())["argv"][1:3] == ["--model", "haiku"]
    assert run(str(shots), "--model", "gpt", path_dir=bin_dir).returncode == 2


def test_summary_keeps_low_rows_and_the_lowest_line():
    table = "| f | a | overall | fix |\n|---|---|---|---|\n| x.png | 9 | 9 | - |\n| y.png | 5 | 7 | pad |\nLOWEST: 7"
    assert judge.summary(table, 8) == ["| y.png | 5 | 7 | pad |", "LOWEST: 7"]
