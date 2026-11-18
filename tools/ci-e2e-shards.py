#!/usr/bin/env python3
"""Hosted Playwright cells by measured time, not by test count (CI-GREEN-6, 18 Nov 2026).

Playwright's --shard=N/7 gives each cell an even number of tests in file order, so tests that are slow and sit
together landed in one cell: layout.spec.ts (15 pages at about 30 s each) and pip-island.spec.ts. playwright-05 ran
9.6-9.9 minutes of tests and took 11.3-15.0 of its 15-minute limit; cells 06 and 07 ran about 1.5 minutes.

Each hosted cell instead:
  1. lists every test (playwright test --list): the same list in every cell, since they build the same tree;
  2. places them longest first onto the cell with the fewest planned seconds (tests/e2e/ci-shards.json; a test with
     no measured time counts as the median, and cell 1 starts with its Google acceptance's seconds). A file that
     runs its tests in order (describe.serial, or describe.configure with mode serial or default) stays whole, as
     Playwright's own sharding keeps it;
  3. runs its own tests with one --grep pattern: each test's exact title, anchored;
  4. first lists what that pattern selects, and stops unless it is exactly its planned tests, so no test is dropped
     or run twice.

  python3 tools/ci-e2e-shards.py plan 5/7 --out <file>    cell 5 of 7: its --grep pattern into <file>, the plan on
                                                         stderr (an empty file: nothing planned for this cell)
  python3 tools/ci-e2e-shards.py measure <job log>... [--write]
      seconds per test from hosted playwright-NN job logs (the list reporter's lines; a retried test counts both
      tries), mapped onto this tree's tests; prints the comparison, --write puts the medians in ci-shards.json
Standard library only: the Playwright cells run it with the runner's python3.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import statistics
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
E2E = ROOT / "tests/e2e"
PLAN = E2E / "ci-shards.json"
PLAYWRIGHT = E2E / "node_modules/.bin/playwright"
# A file whose tests run in order in one worker; Playwright's sharding keeps it (or that describe) in one cell.
SEQUENTIAL = re.compile(r"describe\.serial\b|describe\.configure\(\s*\{[^}]*mode:\s*['\"](?:serial|default)['\"]")
# A list-reporter result line: "  ✓  12 [project] › file.spec.ts:15:7 › describe › title (30.7s)" (hosted lines start
# with a timestamp). Skipped tests have no time.
RESULT = re.compile(r"^(?:\S+Z )?\s*(?:✓|✘|-|°|ok|x)\s+\d+\s+(?:\[([^\]]*)\] › )?(\S+?\.spec\.ts):(\d+):(\d+) › (.*?)"
                    r"(?: \((\d+(?:\.\d+)?)(ms|s|m)\))?\s*$")
UNIT = {"ms": 0.001, "s": 1.0, "m": 60.0}
JS_SPECIAL = set("\\^$.*+?()[]{}|/")


class Test:
    """One listed test. key: how the list reporter names it ("[project] " when the project has a name, then
    "file › describe › title"); grep: the string Playwright matches --grep against."""

    def __init__(self, project: str, file: str, titles: list[str], tags: list[str], line: int, column: int):
        self.project, self.file, self.line, self.column = project, file, line, column
        self.path = " › ".join([file, *titles])
        self.key = (f"[{project}] " if project else "") + self.path
        # Playwright matches "<project> <file> <describe> <title> <own tags>" with leading spaces for the unnamed
        # suites above the file (one in 1.55); pattern() allows any of those. The tags written in titles are
        # already in them.
        base = " ".join([project, file, *titles]).lstrip()
        own = tags[len(re.findall(r"@\S+", base)):]
        self.grep = base + "".join(f" @{t}" for t in own)


def parse_list(report: dict) -> list[Test]:
    tests: list[Test] = []

    def walk(suite: dict, file: str, titles: list[str]) -> None:
        for spec in suite.get("specs", []):
            for t in spec.get("tests", []):
                tests.append(Test(t.get("projectName", ""), file, [*titles, spec["title"]], spec.get("tags", []),
                                  spec.get("line", 0), spec.get("column", 0)))
        for child in suite.get("suites", []):
            walk(child, file, [*titles, child["title"]] if child.get("title") else titles)

    for top in report.get("suites", []):
        walk(top, top.get("file") or top["title"], [])
    return tests


def list_tests(grep: str | None = None) -> tuple[list[Test], bool]:
    """(the tests Playwright lists with this --grep, whether the config runs tests of one file in parallel)."""
    if not PLAYWRIGHT.exists():
        raise SystemExit(f"{PLAYWRIGHT.relative_to(ROOT)} is missing (pnpm install)")
    env = dict(os.environ)
    env.pop("PLAYWRIGHT_JSON_OUTPUT_NAME", None)  # the report must come to stdout
    cmd = [str(PLAYWRIGHT), "test", "--list", "--reporter=json", *(["--grep", grep] if grep is not None else [])]
    done = subprocess.run(cmd, cwd=E2E, env=env, capture_output=True, text=True)
    try:
        report = json.loads(done.stdout)
    except json.JSONDecodeError:
        sys.stderr.write(done.stderr[-4000:])
        raise SystemExit(f"playwright test --list gave no JSON report (exit {done.returncode})")
    if report.get("errors"):
        for error in report["errors"]:
            print(error.get("message", error), file=sys.stderr)
        raise SystemExit("playwright test --list reported errors")
    config = report.get("config", {})
    parallel = bool(config.get("fullyParallel")) or all(p.get("fullyParallel") for p in config.get("projects", [{}]))
    return parse_list(report), parallel


def units(tests: list[Test], parallel: bool) -> list[list[Test]]:
    """What may go to different cells: one test, or a whole file whose tests run in order."""
    whole: set[str] = set()
    for file in {t.file for t in tests}:
        source = E2E / file
        if not parallel or (source.is_file() and SEQUENTIAL.search(source.read_text(errors="replace"))):
            whole.add(file)
    out: dict[str, list[Test]] = defaultdict(list)
    for t in tests:
        out[t.file if t.file in whole else "\0" + t.key].append(t)
    return list(out.values())


def plan(tests: list[Test], cells: int, data: dict, parallel: bool = True) -> tuple[list[list[Test]], list[float], list[str]]:
    """(tests per cell, planned seconds per cell, keys without a measured time). Longest first onto the cell with
    the fewest planned seconds; ties go to the lower cell, then the key, so every cell computes the same plan."""
    seconds = data.get("seconds", {})
    default = statistics.median(seconds.values()) if seconds else 5.0
    unmeasured = sorted(t.key for t in tests if t.key not in seconds)
    cost = lambda unit: sum(seconds.get(t.key, default) for t in unit)
    load = [float(data.get("extra", {}).get(str(n + 1), 0)) for n in range(cells)]
    out: list[list[Test]] = [[] for _ in range(cells)]
    for unit in sorted(units(tests, parallel), key=lambda u: (-cost(u), u[0].key)):
        n = min(range(cells), key=lambda i: (load[i], i))
        out[n].extend(unit)
        load[n] += cost(unit)
    return out, load, unmeasured


def js_escape(text: str) -> str:
    return "".join("\\" + c if c in JS_SPECIAL else c for c in text)


def pattern(tests: list[Test]) -> str:
    """One --grep for these tests: each one's exact title, anchored. Playwright compiles it with flags gi."""
    return "^\\s*(?:" + "|".join(js_escape(t.grep) for t in sorted(tests, key=lambda t: t.key)) + ")$" if tests else ""


def cmd_plan(args: argparse.Namespace) -> int:
    m = re.fullmatch(r"([1-9]\d*)/([1-9]\d*)", args.cell)
    if not m or int(m[1]) > int(m[2]):
        raise SystemExit(f"cell must be N/M with 1 <= N <= M, not {args.cell!r}")
    cell, cells = int(m[1]), int(m[2])
    data = json.loads(PLAN.read_text()) if PLAN.exists() else {}
    tests, parallel = list_tests()
    groups, load, unmeasured = plan(tests, cells, data, parallel)
    mine = groups[cell - 1]
    for n, (group, secs) in enumerate(zip(groups, load), 1):
        print(f"cell {n}/{cells}: {len(group)} tests, {secs / 60:.1f} min planned{'  <- this cell' if n == cell else ''}",
              file=sys.stderr)
    if unmeasured:
        print(f"no measured time yet for {len(unmeasured)} test(s), counted as the median; refresh "
              f"tests/e2e/ci-shards.json (tools/ci-e2e-shards.py measure): " + "; ".join(unmeasured[:10])
              + (" …" if len(unmeasured) > 10 else ""), file=sys.stderr)
    grep = pattern(mine)
    if mine:
        selected, _ = list_tests(grep)
        want, got = sorted(t.key for t in mine), sorted(t.key for t in selected)
        if want != got:
            missing, extra = sorted(set(want) - set(got)), sorted(set(got) - set(want))
            dups = sorted({k for k in got if got.count(k) > 1})
            print(f"the cell's pattern does not select exactly its tests: missing {missing[:5]}, extra {extra[:5]}, "
                  f"twice {dups[:5]}", file=sys.stderr)
            return 1
        print(f"cell {cell}/{cells}: the pattern selects exactly its {len(mine)} planned tests", file=sys.stderr)
    Path(args.out).write_text(grep)
    return 0


def read_logs(paths: list[str]) -> dict[tuple, list[float]]:
    """{(project, file, line, column, title path): [seconds in each log]}; both tries of a retried test count."""
    runs: dict[tuple, list[float]] = defaultdict(list)
    for path in paths:
        mine: dict[tuple, float] = defaultdict(float)
        for line in Path(path).read_text(errors="replace").split("\n"):
            m = RESULT.match(line)
            if m:
                title = re.sub(r" \(retry #\d+\)$", "", m[5])
                mine[(m[1] or "", m[2], int(m[3]), int(m[4]), title)] += float(m[6]) * UNIT[m[7]] if m[6] else 0.0
        for k, v in mine.items():
            runs[k].append(v)
    return runs


def cmd_measure(args: argparse.Namespace) -> int:
    tests, _ = list_tests()
    measured = {k: statistics.median(v) for k, v in read_logs(args.logs).items()}
    by_key = {(k[0], k[1], " › ".join([k[1], k[4]])): s for k, s in measured.items()}
    by_place: dict[tuple, list[float]] = defaultdict(list)
    for k, s in measured.items():
        by_place[k[:4]].append(s)
    seconds: dict[str, float] = {}
    by_location = []
    for t in tests:
        exact = by_key.get((t.project, t.file, t.path))
        if exact is None and len(by_place.get((t.project, t.file, t.line, t.column), [])) == 1:
            # The mirror renames people in titles: the same place in the same file is the same test.
            exact = by_place[(t.project, t.file, t.line, t.column)][0]
            by_location.append(t.key)
        if exact is not None:
            seconds[t.key] = round(exact, 1)
    missing = sorted(t.key for t in tests if t.key not in seconds)
    total = sum(seconds.values())
    print(f"{len(tests)} tests listed; {len(seconds)} measured ({len(by_location)} by file:line:column), "
          f"{total / 60:.1f} min; {len(missing)} without a time")
    for k in missing[:20]:
        print(f"  no time: {k}")
    if args.write:
        data = json.loads(PLAN.read_text()) if PLAN.exists() else {}
        data["seconds"] = dict(sorted(seconds.items()))
        PLAN.write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n")
        print(f"wrote {PLAN.relative_to(ROOT)}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("plan")
    p.add_argument("cell")
    p.add_argument("--out", required=True)
    m = sub.add_parser("measure")
    m.add_argument("logs", nargs="+")
    m.add_argument("--write", action="store_true")
    args = parser.parse_args()
    return cmd_plan(args) if args.command == "plan" else cmd_measure(args)


if __name__ == "__main__":
    sys.exit(main())
