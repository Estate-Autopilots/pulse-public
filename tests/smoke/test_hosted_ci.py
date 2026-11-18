"""Hosted splitting must preserve every core file and the fixed consumer contract."""
import importlib.util
import json
import re
import tempfile
from importlib.machinery import SourceFileLoader
from contextlib import redirect_stdout
from io import StringIO
from types import SimpleNamespace
from unittest.mock import Mock, patch
from pathlib import Path
import unittest

import yaml

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("db_shards", ROOT / "tools/ci-db-shards.py")
shards = importlib.util.module_from_spec(spec)
spec.loader.exec_module(shards)
e2e_spec = importlib.util.spec_from_file_location("e2e_shards", ROOT / "tools/ci-e2e-shards.py")
e2e_shards = importlib.util.module_from_spec(e2e_spec)
e2e_spec.loader.exec_module(e2e_shards)


def measured_e2e_tests():
    """The tests tests/e2e/ci-shards.json knows, as the planner sees them (no Playwright needed)."""
    data = json.loads(e2e_shards.PLAN.read_text())
    tests = []
    for key in data["seconds"]:
        file, *titles = key.split(" › ")
        tests.append(e2e_shards.Test("", file, titles, [], 1, 1))
    return tests, data


class E2ECellTests(unittest.TestCase):
    """CI-GREEN-6: the Playwright cells are planned by measured time and must still run every test exactly once."""

    def test_every_test_is_in_exactly_one_cell_and_the_cells_are_even(self):
        tests, data = measured_e2e_tests()
        cells, load, unmeasured = e2e_shards.plan(tests, 7, data)
        self.assertEqual(unmeasured, [])
        keys = [t.key for cell in cells for t in cell]
        self.assertEqual(sorted(keys), sorted(t.key for t in tests))
        self.assertEqual(len(keys), len(set(keys)))
        # Count-based shards put 9.6-9.9 of 24 minutes in one cell; by time the cells differ by at most the longest
        # unit (a test, or a file that runs in order).
        longest = max(sum(data["seconds"][t.key] for t in u) for u in e2e_shards.units(tests, True))
        self.assertLessEqual(max(load) - min(load), longest)
        self.assertGreaterEqual(load[0], data["extra"]["1"])  # cell 1 also runs the Google acceptance
        self.assertEqual(e2e_shards.plan(list(reversed(tests)), 7, data)[1], load)  # every cell computes the same plan

    def test_each_cell_pattern_selects_exactly_its_tests(self):
        tests, data = measured_e2e_tests()
        tests.append(e2e_shards.Test("", "odd.spec.ts", ["a (b) [c] {d} $e ^f | g? h* i+ j. k\\l /m"], [], 1, 1))
        tests.append(e2e_shards.Test("", "odd.spec.ts", ["a (b) [c] {d} $e ^f | g? h* i+ j. k\\l /m and more"], [], 2, 1))
        tests.append(e2e_shards.Test("", "tags.spec.ts", ["mail admin@x.example"], ["x.example", "slow"], 3, 1))
        cells, _, _ = e2e_shards.plan(tests, 7, data)
        # What Playwright 1.55 matches: one leading space for the unnamed project, then file, titles and own tags.
        self.assertEqual(tests[-1].grep, "tags.spec.ts mail admin@x.example @slow")
        for n, cell in enumerate(cells):
            # The escapes are the same in JavaScript and Python; Playwright compiles the pattern with flags gi.
            matcher = re.compile(e2e_shards.pattern(cell), re.IGNORECASE)
            chosen = sorted(t.key for t in tests if matcher.search(" " + t.grep))
            self.assertEqual(chosen, sorted(t.key for t in cell), f"cell {n + 1}")

    def test_files_that_run_in_order_stay_in_one_cell(self):
        tests = [e2e_shards.Test("", "groups-hub.spec.ts", [f"step {n}"], [], n, 1) for n in range(9)]
        tests += [e2e_shards.Test("", "layout.spec.ts", [f"page {n}"], [], 15, 7) for n in range(9)]
        data = {"seconds": {t.key: 30.0 for t in tests}}
        cells, _, _ = e2e_shards.plan(tests, 7, data)
        self.assertEqual(sum(any(t.file == "groups-hub.spec.ts" for t in cell) for cell in cells), 1)
        self.assertGreater(sum(any(t.file == "layout.spec.ts" for t in cell) for cell in cells), 1)
        # A config that does not run a file's tests in parallel keeps every file whole.
        cells, _, _ = e2e_shards.plan(tests, 7, data, parallel=False)
        self.assertEqual(sorted(len(c) for c in cells if c), [9, 9])

    def test_hosted_job_log_lines_give_each_test_its_seconds(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        log = Path(tmp.name) / "playwright-05.log"
        log.write_text("\n".join([
            "2026-11-18T12:23:24.6590015Z   ✓   1 layout.spec.ts:15:7 › nothing covered, cut off or out of reach: /hr (30.7s)",
            "2026-11-18T12:23:25.1Z   ✘   2 a.spec.ts:3:5 › box › opens (2.0s)",
            "2026-11-18T12:23:27.1Z   ✓   3 a.spec.ts:3:5 › box › opens (retry #1) (1.5s)",
            "2026-11-18T12:23:27.2Z   -   4 b.spec.ts:9:1 › needs a live Pulse",
            "  ✓  5 c.spec.ts:1:1 › local run (850ms)",
        ]))
        runs = e2e_shards.read_logs([str(log)])
        self.assertEqual(runs[("", "layout.spec.ts", 15, 7, "nothing covered, cut off or out of reach: /hr")], [30.7])
        self.assertEqual(runs[("", "a.spec.ts", 3, 5, "box › opens")], [3.5])  # both tries
        self.assertEqual(runs[("", "b.spec.ts", 9, 1, "needs a live Pulse")], [0.0])
        self.assertEqual(runs[("", "c.spec.ts", 1, 1, "local run")], [0.85])

    def test_hosted_cells_use_the_plan_and_cell_one_keeps_the_google_acceptance(self):
        ci = (ROOT / "tools/ci.sh").read_text()
        self.assertIn('python3 tools/ci-e2e-shards.py plan "$PULSE_CI_E2E_SHARD"', ci)
        self.assertNotIn("--shard=$PULSE_CI_E2E_SHARD", ci)
        self.assertIn("e2e=(exec playwright test)", ci)
        self.assertIn('$PULSE_CI_E2E_SHARD == 1/*', ci)
        for bad in ["0/7", "8/7", "5", "a/7"]:
            with self.assertRaises(SystemExit):
                e2e_shards.cmd_plan(SimpleNamespace(cell=bad, out="/dev/null"))


class HostedGateTests(unittest.TestCase):
    def test_isolated_cells_cover_every_file_once_including_alone_files(self):
        files = sorted(p.name for p in shards.TESTS.glob("test_*.py"))
        assigned = []
        for cell in [*[f"{n:02}" for n in range(1, shards.DB_CELLS + 1)], "page1"]:
            groups, alone = shards.hosted_plan(files, cell)
            self.assertEqual(len(groups), 1)
            self.assertFalse(alone[1])
            self.assertTrue(groups[0][1])
            assigned.extend(groups[0][1])
        self.assertEqual(sorted(assigned), files)
        # The other page cells run the same file; the runner splits its pages (PULSE_PAGE_MATRIX_SHARD).
        for cell in ("page2", "page3", "page4"):
            self.assertEqual(shards.hosted_plan(files, cell)[0][0][1], ["test_access_matrix.py"])

    def test_invalid_or_empty_matrix_is_rejected(self):
        for cell in ["00", "13", "1", "all"]:
            with self.assertRaises(ValueError):
                shards.hosted_plan([], cell)
        with self.assertRaises(ValueError):
            shards.hosted_plan(["test_access_matrix.py"], "01")

    def test_local_alone_phase_is_preserved(self):
        files = sorted(p.name for p in shards.TESTS.glob("test_*.py"))
        groups, alone = shards.plan(files, 2)
        self.assertLessEqual(len(groups), 2)
        self.assertTrue(alone[1])
        self.assertEqual(sorted([f for _, members in groups for f in members] + alone[1]), files)

    def test_consumer_names_and_aggregate_cannot_drop_a_matrix(self):
        jobs = yaml.safe_load((ROOT / ".github/workflows/ci.yml").read_text())["jobs"]
        self.assertEqual(jobs["language"]["strategy"]["matrix"]["group"], ["python", "schemas", "rust"])
        self.assertEqual(jobs["database"]["strategy"]["matrix"]["cell"], [*[f"{n:02}" for n in range(1, 13)], "page1", "page2", "page3", "page4"])
        self.assertEqual(jobs["playwright"]["strategy"]["matrix"]["include"],
                         [{"cell": f"{n:02}", "shard": f"{n}/7"} for n in range(1, 8)])
        self.assertEqual(set(jobs["ci"]["needs"]), set(jobs) - {"ci", "staging"})
        self.assertEqual(jobs["ci"]["if"], "always()")
        for name in ("language", "database", "playwright"):
            self.assertFalse(jobs[name]["strategy"]["fail-fast"])

    def test_web_build_artifact_survives_a_failed_jobs_rerun(self):
        # "Re-run failed jobs" skips web_build, so the consumers must not look for an attempt-scoped name.
        jobs = yaml.safe_load((ROOT / ".github/workflows/ci.yml").read_text())["jobs"]
        steps = yaml.safe_load((ROOT / ".github/actions/ci-setup/action.yml").read_text())["runs"]["steps"]
        upload = next(s["with"] for s in jobs["web_build"]["steps"] if s.get("uses", "").startswith("actions/upload-artifact"))
        download = next(s["with"] for s in steps if s.get("uses", "").startswith("actions/download-artifact"))
        self.assertEqual(upload["name"], "web-${{ github.run_id }}")
        self.assertEqual(download["name"], upload["name"])
        self.assertIs(upload["overwrite"], True)
        for name in ("database", "playwright"):
            self.assertEqual(jobs[name]["needs"], "web_build")

    def test_lane_uses_fresh_exact_head_and_preserves_pending_and_failure(self):
        lane_spec = importlib.util.spec_from_loader("hosted_lane", SourceFileLoader("hosted_lane", str(ROOT / "tools/lane")))
        lane = importlib.util.module_from_spec(lane_spec)
        lane_spec.loader.exec_module(lane)
        branch, head = "task/qa/EST-1582-hosted-test-gate", "a" * 40
        for hosted, code, message in [(True, 0, None), (True, 75, "still running"),
                                      (True, 1, "required job failed"), (False, 0, None)]:
            runner = Mock(return_value=SimpleNamespace(returncode=code, stdout='{"summary":"required job failed"}'))
            local = Mock(return_value=0)
            with self.subTest(hosted=hosted, code=code), patch.multiple(
                lane, task_branch_here=lambda: (branch, "qa", "EST-1582"), ensure_clean=Mock(), fetch=Mock(),
                remote_heads=lambda: {branch: head}, git_out=lambda *args: head,
                count=lambda value: int(value == "origin/main..HEAD"),
                Path=lambda value: SimpleNamespace(exists=lambda: hosted),
                subprocess=SimpleNamespace(run=runner, call=local)
            ), redirect_stdout(StringIO()):
                if message:
                    with self.assertRaisesRegex(lane.LaneError, message):
                        lane.cmd_ready(SimpleNamespace(ci=True))
                else:
                    self.assertEqual(lane.cmd_ready(SimpleNamespace(ci=True)), 0)
                if hosted:
                    runner.assert_called_once_with(
                        ['python3', '/opt/ea-watchdog/hosted_ci.py', '--fresh', '--source-sha', head,
                         '--repository', '.'], capture_output=True, text=True)
                    local.assert_not_called()
                else:
                    runner.assert_not_called()
                    local.assert_called_once_with(['bash', 'tools/ci.sh'])
