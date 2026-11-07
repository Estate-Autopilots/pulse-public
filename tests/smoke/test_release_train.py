import contextlib
import importlib.util
import json
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("pulse_train", ROOT / "tools" / "pulse-train.py")
train = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(train)

DESIGN, RELEASE, LANE_MERGE = "d" * 40, "r" * 40, "m" * 40
# No test may reach the real train state (~/.local/state/pulse-release) or the watchdog's CI results: everything the
# module writes points at a throwaway directory unless a test patches it somewhere else (OPS-2, 15 Oct: an unpatched
# call overwrote the real train.json).
_ISOLATED = tempfile.TemporaryDirectory()
train.state = Path(_ISOLATED.name)
train.last_path = train.state / "train.json"
train.CI_RESULTS = train.state / "ci"


class Started(BaseException):
    """Stops the fake train at its first release step, the checkout (BaseException: skips the failure notice)."""


def fake_git(snapshot, main, at_checkout, calls):
    """The train's run(): design/home and main answer, the worktree checkout calls at_checkout(args)."""
    def fake_run(*args, **kwargs):
        calls.append(args)
        if "worktree" in args:
            at_checkout(args)
        if args[0] == "ea-notify":
            return SimpleNamespace(stdout="")
        out = {"design/home": snapshot, "refs/heads/main": main}.get(args[-1], "")
        return SimpleNamespace(stdout=out + "\n")
    return fake_run


class TrainState:
    """A temporary train state dir and local CI results dir, patched into the train module."""

    def __init__(self, last, ci=None):
        self.temporary = tempfile.TemporaryDirectory()
        self.dir = Path(self.temporary.name)
        (self.dir / "ci").mkdir()
        (self.dir / "train.json").write_text(json.dumps(last))
        for sha, status in (ci or {}).items():
            self.ci(sha, status)
        self.patches = [mock.patch.object(train, "state", self.dir),
                        mock.patch.object(train, "last_path", self.dir / "train.json"),
                        mock.patch.object(train, "CI_RESULTS", self.dir / "ci")]

    def ci(self, sha, status):
        (self.dir / "ci" / (sha + ".json")).write_text(json.dumps({"sha": sha, "status": status}))

    def saved(self):
        return json.loads((self.dir / "train.json").read_text())

    def __enter__(self):
        for patch in self.patches:
            patch.start()
        return self

    def __exit__(self, *exc):
        for patch in self.patches:
            patch.stop()
        self.temporary.cleanup()


def ago(hours):
    return time.strftime("%FT%TZ", time.gmtime(time.time() - hours * 3600))


class ReleaseTrainTriggerTests(unittest.TestCase):
    def run_train(self, snapshot, main, last=None, ci=None, state=None):
        calls = []

        def started(args):
            raise Started

        context = contextlib.nullcontext(state) if state else TrainState(last, ci)
        with context as st, mock.patch.object(train, "run", fake_git(snapshot, main, started, calls)):
            try:
                train.main()
            except Started:
                return True, calls
            except SystemExit as stop:
                self.assertIn(stop.code, (0, None))
                return False, calls
            finally:
                self.state = st.saved()
        self.fail("the train neither started nor stopped")

    def test_nothing_new_keeps_the_train_idle(self):
        started, calls = self.run_train(DESIGN, RELEASE, {"design_sha": DESIGN, "release_sha": RELEASE})
        self.assertFalse(started)
        self.assertFalse(any(call[:2] == ("git", "push") for call in calls))

    def test_a_lane_merge_starts_the_train_once_main_is_green(self):
        last = {"design_sha": DESIGN, "release_sha": RELEASE}
        self.assertTrue(self.run_train(DESIGN, LANE_MERGE, last, {LANE_MERGE: "pass"})[0])

    def test_a_lane_merge_waits_while_main_is_untested_or_red(self):
        last = {"design_sha": DESIGN, "release_sha": RELEASE}
        with TrainState(last) as st:
            self.assertFalse(self.run_train(DESIGN, LANE_MERGE, state=st)[0])
            self.assertEqual(json.loads((st.dir / "main-seen.json").read_text())["sha"], LANE_MERGE)  # wait counts from here
            self.assertEqual(st.saved(), last)  # train.json keeps only what the train records
        self.assertFalse(self.run_train(DESIGN, LANE_MERGE, last, {LANE_MERGE: "running"})[0])
        self.assertFalse(self.run_train(DESIGN, LANE_MERGE, last, {LANE_MERGE: "fail"})[0])

    def test_main_without_a_ci_verdict_for_two_hours_lets_the_trains_own_ci_decide(self):
        last = {"design_sha": DESIGN, "release_sha": RELEASE}
        for hours, started in ((1.5, False), (2.1, True)):
            with TrainState(last) as st:
                (st.dir / "main-seen.json").write_text(json.dumps({"sha": LANE_MERGE, "at": ago(hours)}))
                self.assertEqual(self.run_train(DESIGN, LANE_MERGE, state=st)[0], started)
        with TrainState(last, {LANE_MERGE: "fail"}) as st:
            (st.dir / "main-seen.json").write_text(json.dumps({"sha": LANE_MERGE, "at": ago(3)}))
            self.assertFalse(self.run_train(DESIGN, LANE_MERGE, state=st)[0])  # red is red

    def test_a_new_workbench_snapshot_starts_without_waiting_for_ci(self):
        started, _ = self.run_train("e" * 40, RELEASE, {"design_sha": DESIGN, "release_sha": RELEASE})
        self.assertTrue(started)

    def test_first_run_without_state_starts_the_train(self):
        with TrainState({}):
            self.assertEqual(train.due(DESIGN, RELEASE, {}), "release")

    def test_force_skips_the_green_wait_once(self):
        with TrainState({}) as st:
            last = {"design_sha": DESIGN, "release_sha": RELEASE}
            (st.dir / "force").touch()
            self.assertEqual(train.due(DESIGN, LANE_MERGE, last), "staging")
            self.assertIsNone(train.due(DESIGN, LANE_MERGE, last))

    def test_a_failed_pair_waits_for_a_new_main_or_workbench(self):
        last = {"design_sha": DESIGN, "release_sha": RELEASE,
                "failed": {"design_sha": "e" * 40, "main": LANE_MERGE, "kind": "code", "at": ago(5)}}
        self.assertFalse(self.run_train("e" * 40, LANE_MERGE, last)[0])
        self.assertTrue(self.run_train("e" * 40, "n" * 40, last)[0])
        self.assertTrue(self.run_train("f" * 40, LANE_MERGE, last)[0])


class ReleaseTrainFailureTests(unittest.TestCase):
    """A failed run is remembered; the fix landing starts the next attempt at once; one plain heads-up per run of
    failures; a failure outside the code is retried once after an hour (OPS-2)."""

    def run_failing(self, st, snapshot, main):
        calls = []

        def broken(args):
            raise subprocess.CalledProcessError(1, args)

        with mock.patch.object(train, "run", fake_git(snapshot, main, broken, calls)):
            try:
                train.main()
            except subprocess.CalledProcessError:
                outcome = "failed"
            except SystemExit:
                outcome = "idle"
            else:
                outcome = "released"
        return outcome, [c for c in calls if c[0] == "ea-notify"]

    def test_one_headsup_per_run_of_failures_and_no_back_off(self):
        with TrainState({"design_sha": DESIGN, "release_sha": RELEASE, "version": "v0.3.60"}) as st:
            outcome, notices = self.run_failing(st, "e" * 40, LANE_MERGE)
            self.assertEqual((outcome, len(notices)), ("failed", 1))
            args = notices[0]
            self.assertEqual(args[args.index("-k") + 1], "train:stopped")
            self.assertEqual(args[args.index("-t") + 1], "Pulse release train stopped")
            text = args[-1]
            self.assertIn("preparing a fresh copy of the code", text)
            self.assertIn("Production is unchanged (v0.3.60)", text)
            self.assertNotRegex(text, r"/home|journalctl|[0-9a-f]{7,}")
            self.assertEqual(self.run_failing(st, "e" * 40, LANE_MERGE), ("idle", []))  # the same pair waits
            for n, main in enumerate(("n" * 40, "p" * 40), 2):  # fixes landing: run at once, no new heads-up
                st.ci(main, "pass")
                self.assertEqual(self.run_failing(st, "e" * 40, main), ("failed", []))
                self.assertEqual(st.saved()["failures"], n)

    def test_an_infra_failure_is_retried_once_after_an_hour(self):
        last = {"design_sha": DESIGN, "release_sha": RELEASE, "failures": 1,
                "failed": {"design_sha": DESIGN, "main": LANE_MERGE, "kind": "infra", "at": ago(0.5)}}
        with TrainState(last, {LANE_MERGE: "pass"}) as st:
            self.assertIsNone(train.due(DESIGN, LANE_MERGE, st.saved()))
            last["failed"]["at"] = ago(1.1)
            st.dir.joinpath("train.json").write_text(json.dumps(last))
            self.assertEqual(self.run_failing(st, DESIGN, LANE_MERGE), ("failed", []))
            self.assertTrue(st.saved()["failed"]["retried"])
            self.assertIsNone(train.due(DESIGN, LANE_MERGE, st.saved()))  # once only

    def test_failure_kinds(self):
        error = subprocess.CalledProcessError(1, "ci")
        self.assertEqual(train.failure_kind("ci", error), "code")
        self.assertEqual(train.failure_kind("merge", RuntimeError("Workbench conflicts with main")), "code")
        self.assertEqual(train.failure_kind("ci", subprocess.CalledProcessError(75, "ci")), "infra")  # disk reserve
        self.assertEqual(train.failure_kind("staging-smoke", RuntimeError()), "infra")
        self.assertEqual(train.failure_kind("production-migrate", RuntimeError()), "production")

    def test_failure_words_come_from_the_receipts(self):
        with tempfile.TemporaryDirectory() as temporary:
            report = Path(temporary)
            (report / "ci.log").write_text("...\nCI result: FAIL (2 failed: db: migrations and tests, e2e: Playwright; "
                                           "30 passed, 0 skipped, 0 warning(s))\n")
            self.assertEqual(train.failure_words("ci", RuntimeError(), report),
                             "the automated tests failed (db: migrations and tests, e2e: Playwright)")
            (report / "staging-public-check.json").write_text(json.dumps(
                {"passed": False, "checks": [{}] * 665, "error": "AssertionError: anonymous GET /api/v0/brand HTTP 200"}))
            words = train.failure_words("staging-smoke", RuntimeError(), report)
            self.assertEqual(words, "the checks on staging: one failed after 665 passed (anonymous GET HTTP 200)")
            self.assertIn("refused heavy work",
                          train.failure_words("checkout", subprocess.CalledProcessError(75, "git"), report))


def git(cwd, *args):
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


class WorkbenchBaseTests(unittest.TestCase):
    """A squash-merged resolution plus tools/train-workbench-base lets the train merge only newer workbench work."""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.repo = Path(self.temporary.name)
        git(self.repo, "init", "-q", "-b", "main")
        git(self.repo, "config", "user.name", "Synthetic")
        git(self.repo, "config", "user.email", "synthetic@example.test")
        self.write("routes.txt", "a\nb\nc\nd\ne\nf\ng\n")
        self.commit("base")
        git(self.repo, "checkout", "-q", "-b", "workbench")
        self.write("routes.txt", "a\nb-workbench\nc\nd\ne\nf\ng\n")
        self.integrated = self.commit("workbench round")
        self.write("routes.txt", "a\nb-workbench\nc\nd\ne\nf\ng-next-round\n")
        self.write("next.txt", "next round\n")
        self.snapshot = self.commit("next round")
        git(self.repo, "checkout", "-q", "main")
        self.write("routes.txt", "a\nb-lane\nc\nd\ne\nf\ng\n")
        self.commit("lane change")

    def tearDown(self):
        self.temporary.cleanup()

    def write(self, name, text):
        (self.repo / name).parent.mkdir(parents=True, exist_ok=True)
        (self.repo / name).write_text(text)

    def commit(self, message):
        git(self.repo, "add", "-A")
        git(self.repo, "commit", "-q", "-m", message)
        return git(self.repo, "rev-parse", "HEAD")

    def squash_resolution(self, base):
        self.write("routes.txt", "a\nb-lane+workbench\nc\nd\ne\nf\ng\n")
        self.write(train.WORKBENCH_BASE, "# synthetic\n" + base + "\n")
        return self.commit("squash-merged lane resolution")

    def assert_held(self):
        head = git(self.repo, "rev-parse", "HEAD")
        self.assertFalse(train.merge_workbench(self.repo, self.snapshot))
        self.assertEqual(git(self.repo, "rev-parse", "HEAD"), head)  # main ships alone (EST-328)
        self.assertEqual(git(self.repo, "status", "--porcelain"), "")

    def test_without_a_base_the_old_conflict_holds_the_workbench(self):
        self.assert_held()

    def test_a_non_conflict_failure_still_raises(self):
        with self.assertRaises(subprocess.CalledProcessError):
            train.merge_workbench(self.repo, "f" * 40)

    def test_a_workbench_already_on_main_is_a_no_op(self):
        head = git(self.repo, "rev-parse", "HEAD")
        self.assertTrue(train.merge_workbench(self.repo, head))
        self.assertEqual(git(self.repo, "rev-parse", "HEAD"), head)

    def test_a_conflict_after_the_base_holds_the_workbench(self):
        self.squash_resolution(self.integrated)
        self.write("routes.txt", "a\nb-lane+workbench\nc\nd\ne\nf\ng-lane\n")
        self.commit("lane change on the next round's line")
        self.assert_held()

    def test_the_base_merges_only_newer_work_and_records_the_snapshot(self):
        resolution = self.squash_resolution(self.integrated)
        self.assertTrue(train.merge_workbench(self.repo, self.snapshot))
        self.assertEqual((self.repo / "routes.txt").read_text(), "a\nb-lane+workbench\nc\nd\ne\nf\ng-next-round\n")
        self.assertEqual((self.repo / "next.txt").read_text(), "next round\n")
        self.assertEqual(git(self.repo, "rev-parse", "HEAD^1", "HEAD^2").split(), [resolution, self.snapshot])
        self.assertIsNone(train.workbench_base(self.repo, self.snapshot))  # now in main's history: inert

    def test_reconciled_workbench_uses_current_main_instead_of_stale_squash_base(self):
        self.squash_resolution(self.integrated)
        git(self.repo, "checkout", "-q", "workbench")
        subprocess.run(["git", "merge", "--no-commit", "main"], cwd=self.repo, capture_output=True)
        self.write("routes.txt", "a\nb-lane+workbench\nc\nd\ne\nf\ng-next-round\n")
        self.snapshot = self.commit("reconcile current main")
        git(self.repo, "checkout", "-q", "main")
        self.assertIsNone(train.workbench_base(self.repo, self.snapshot))
        self.assertTrue(train.merge_workbench(self.repo, self.snapshot))
        self.assertEqual((self.repo / "next.txt").read_text(), "next round\n")
        self.assertIn("g-next-round", (self.repo / "routes.txt").read_text())

    def test_a_base_outside_design_home_stops_the_train(self):
        self.squash_resolution(git(self.repo, "commit-tree", "HEAD^{tree}", "-m", "not on design/home"))
        with self.assertRaises(RuntimeError):
            train.merge_workbench(self.repo, self.snapshot)


class StagingMoveTests(unittest.TestCase):
    """The bare repo refuses non-fast-forward pushes, forced or not: a staging rewind moves the ref itself, and only
    from the staging sha the run observed (EST-787, EST-1268)."""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        self.origin, self.checkout = root / "pulse.git", root / "checkout"
        git(root, "init", "-q", "--bare", str(self.origin))
        git(self.origin, "config", "receive.denyNonFastForwards", "true")  # as /home/eadev/git/pulse.git
        git(self.origin, "config", "core.logAllRefUpdates", "true")
        seed = root / "seed"
        git(root, "init", "-q", "-b", "main", str(seed))
        git(seed, "config", "user.name", "Synthetic")
        git(seed, "config", "user.email", "synthetic@example.test")
        git(seed, "commit", "-q", "--allow-empty", "-m", "base")
        git(seed, "push", "-q", str(self.origin), "HEAD:refs/heads/main")
        git(root, "--git-dir", str(self.origin), "worktree", "add", "-q", "--detach", str(self.checkout), "refs/heads/main")
        git(self.checkout, "config", "user.name", "Synthetic")
        git(self.checkout, "config", "user.email", "synthetic@example.test")
        self.base = git(self.checkout, "rev-parse", "HEAD")
        self.lane = self.commit("lane merge staging ran")
        git(self.checkout, "push", "-q", str(self.origin), "HEAD:refs/heads/staging")
        git(self.checkout, "checkout", "-q", "--detach", self.base)
        self.release = self.commit("workbench snapshot without the lane merge")
        self.origin_patch = mock.patch.object(train, "ORIGIN", str(self.origin))
        self.origin_patch.start()

    def tearDown(self):
        self.origin_patch.stop()
        self.temporary.cleanup()

    def commit(self, message):
        git(self.checkout, "commit", "-q", "--allow-empty", "-m", message)
        return git(self.checkout, "rev-parse", "HEAD")

    def staging(self):
        return git(self.origin, "rev-parse", "refs/heads/staging")

    def test_a_forced_push_is_refused_by_the_bare_repo(self):
        refused = subprocess.run(["git", "push", "--force-with-lease=staging:" + self.lane, str(self.origin), "HEAD:staging"],
                                 cwd=self.checkout, capture_output=True, text=True)
        self.assertNotEqual(refused.returncode, 0)
        self.assertIn("non-fast-forward", refused.stderr)
        self.assertEqual(self.staging(), self.lane)

    def test_a_rewind_moves_staging_from_the_observed_sha(self):
        self.assertFalse(train.ancestor(self.checkout, self.lane, "HEAD"))
        train.move_staging(self.checkout, self.release, self.lane, True)
        self.assertEqual(self.staging(), self.release)
        self.assertIn("staging rewind", git(self.origin, "reflog", "-1", "--format=%gs", "refs/heads/staging"))

    def test_a_rewind_from_another_sha_changes_nothing(self):
        with self.assertRaises(subprocess.CalledProcessError):
            train.move_staging(self.checkout, self.release, self.base, True)  # staging moved since the run looked
        self.assertEqual(self.staging(), self.lane)

    def test_a_fast_forward_is_a_plain_push(self):
        git(self.checkout, "checkout", "-q", "--detach", self.lane)
        ahead = self.commit("next lane merge")
        train.move_staging(self.checkout, ahead, self.lane, False)
        self.assertEqual(self.staging(), ahead)


class MigrationCollisionTests(unittest.TestCase):
    """Two migrations with one version merge cleanly in git but stop the migrator: hold the workbench (EST-404)."""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.repo = Path(self.temporary.name)
        git(self.repo, "init", "-q", "-b", "main")
        git(self.repo, "config", "user.name", "Synthetic")
        git(self.repo, "config", "user.email", "synthetic@example.test")
        self.commit("db/migrations/0104_base.sql", "base")
        git(self.repo, "branch", "workbench")
        self.commit("db/migrations/0105_main_backfill.sql", "main migration")

    def tearDown(self):
        self.temporary.cleanup()

    def commit(self, name, message):
        (self.repo / name).parent.mkdir(parents=True, exist_ok=True)
        (self.repo / name).write_text("select 1;\n")
        git(self.repo, "add", "-A")
        git(self.repo, "commit", "-q", "-m", message)
        return git(self.repo, "rev-parse", "HEAD")

    def workbench(self, name):
        git(self.repo, "checkout", "-q", "workbench")
        snapshot = self.commit("db/migrations/" + name, "workbench migration")
        git(self.repo, "checkout", "-q", "main")
        return snapshot

    def test_a_duplicate_version_holds_the_workbench(self):
        snapshot = self.workbench("0105_workbench_index.sql")
        head = git(self.repo, "rev-parse", "HEAD")
        self.assertFalse(train.merge_workbench(self.repo, snapshot))
        self.assertEqual(git(self.repo, "rev-parse", "HEAD"), head)  # main ships alone
        self.assertEqual(git(self.repo, "status", "--porcelain"), "")

    def test_a_disjoint_version_merges(self):
        snapshot = self.workbench("01051_workbench_index.sql")
        self.assertTrue(train.merge_workbench(self.repo, snapshot))
        self.assertEqual(git(self.repo, "rev-parse", "HEAD^2"), snapshot)
        self.assertEqual({path.name for path in (self.repo / "db/migrations").glob("*.sql")},
                         {"0104_base.sql", "0105_main_backfill.sql", "01051_workbench_index.sql"})


if __name__ == "__main__":
    unittest.main()
