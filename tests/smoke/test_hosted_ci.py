"""Hosted splitting must preserve every core file and the fixed consumer contract."""
import importlib.util
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


class HostedGateTests(unittest.TestCase):
    def test_isolated_cells_cover_every_file_once_including_alone_files(self):
        files = sorted(p.name for p in shards.TESTS.glob("test_*.py"))
        assigned = []
        for cell in [*[f"{n:02}" for n in range(1, 11)], "page1"]:
            groups, alone = shards.hosted_plan(files, cell)
            self.assertEqual(len(groups), 1)
            self.assertFalse(alone[1])
            self.assertTrue(groups[0][1])
            assigned.extend(groups[0][1])
        self.assertEqual(sorted(assigned), files)
        # The second page cell runs the same file; the runner splits its pages (PULSE_PAGE_MATRIX_SHARD).
        self.assertEqual(shards.hosted_plan(files, "page2")[0][0][1], ["test_access_matrix.py"])

    def test_invalid_or_empty_matrix_is_rejected(self):
        for cell in ["00", "11", "1", "all"]:
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
        self.assertEqual(jobs["database"]["strategy"]["matrix"]["cell"], [*[f"{n:02}" for n in range(1, 11)], "page1", "page2"])
        self.assertEqual(jobs["playwright"]["strategy"]["matrix"]["include"],
                         [{"cell": f"{n:02}", "shard": f"{n}/6"} for n in range(1, 7)])
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
