"""Lab gate integration cannot rewrite product source, refs, or the real index."""
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("lab_source", ROOT / "tools/ci-lab-source.py")
lab = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lab)


class LabSourceTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(prefix="lab-source-test-")
        self.addCleanup(self.scratch.cleanup)
        self.repo = Path(self.scratch.name)
        self.git("init", "-q")
        self.git("config", "user.name", "Synthetic Builder")
        self.git("config", "user.email", "builder@example.invalid")
        for path in (*lab.GATE_FILES, "apps/web/app/page.tsx", "db/migrations/0001.sql"):
            file = self.repo / path
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text("lab version\n")
        self.source = self.commit("lab")
        for path in (*lab.GATE_FILES, "apps/web/app/page.tsx"):
            (self.repo / path).write_text("gate donor version\n")
        (self.repo / "tools/ci.sh").chmod(0o755)
        self.donor = self.commit("reviewed gate")

    def git(self, *args):
        return subprocess.run(["git", "-C", str(self.repo), *args],
                              capture_output=True, text=True, check=True).stdout.strip()

    def commit(self, message):
        self.git("add", "-A")
        self.git("commit", "-qm", message)
        return self.git("rev-parse", "HEAD")

    def test_exact_gate_blobs_and_only_lab_parent_preserve_all_other_source(self):
        report = lab.prepare(self.repo, self.source, self.donor)
        source = report["replacement_source_sha"]
        self.assertNotIn(source, (self.source, self.donor))
        self.assertEqual(self.git("show", "-s", "--format=%P", source), self.source)
        self.assertEqual(set(report["changed_paths"]), set(lab.GATE_FILES))
        self.assertEqual(self.git("show", source + ":apps/web/app/page.tsx"), "lab version")
        self.assertEqual(self.git("show", source + ":db/migrations/0001.sql"), "lab version")
        for path in lab.GATE_FILES:
            self.assertEqual(self.git("ls-tree", source, path), self.git("ls-tree", self.donor, path))
        message = self.git("show", "-s", "--format=%B", source)
        self.assertIn("Lab-Source: " + self.source, message)
        self.assertIn("Gate-Source: " + self.donor, message)
        self.assertTrue(message.endswith("Co-Authored-By: Paperclip <noreply@org-e6af7d.example>"))
        self.assertFalse(report["published"])
        self.assertIsNone(report["hosted_receipt"])

    def test_refs_dirty_worktree_and_staged_index_remain_untouched(self):
        file = self.repo / "apps/web/app/page.tsx"
        file.write_text("staged work\n")
        self.git("add", str(file))
        file.write_text("unstaged work\n")
        before = (self.git("show-ref"), self.git("write-tree"), self.git("diff"), file.read_bytes())
        first = lab.prepare(self.repo, self.source, self.donor)
        second = lab.prepare(self.repo, self.source, self.donor)
        after = (self.git("show-ref"), self.git("write-tree"), self.git("diff"), file.read_bytes())
        self.assertEqual(before, after)
        self.assertEqual(first, second)

    def test_missing_gate_file_is_rejected_without_moving_a_ref(self):
        self.git("rm", lab.GATE_FILES[0])
        donor = self.commit("incomplete donor")
        with self.assertRaisesRegex(ValueError, "missing"):
            lab.prepare(self.repo, self.source, donor)
        self.assertEqual(self.git("rev-parse", "HEAD"), donor)

    def test_symlink_gate_file_is_rejected(self):
        file = self.repo / lab.GATE_FILES[0]
        file.unlink()
        file.symlink_to("../../outside-gate")
        donor = self.commit("unsafe donor")
        with self.assertRaisesRegex(ValueError, "regular"):
            lab.prepare(self.repo, self.source, donor)

    def test_refs_short_shas_trees_and_identical_sources_are_rejected(self):
        for source, donor in [("HEAD", self.donor), (self.source[:12], self.donor),
                              (self.source, "main"), (self.source, self.source)]:
            with self.subTest(source=source, donor=donor), self.assertRaises(ValueError):
                lab.prepare(self.repo, source, donor)
        with self.assertRaises((ValueError, subprocess.CalledProcessError)):
            lab.prepare(self.repo, self.git("rev-parse", "HEAD^{tree}"), self.donor)


if __name__ == "__main__":
    unittest.main()
