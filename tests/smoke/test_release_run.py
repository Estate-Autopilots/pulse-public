"""POLISH-2: release jobs run the shipped release checkout's own script, never a stale installed copy (OPS-DATA)."""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
LAUNCHER = ROOT / 'tools/release-run.py'
SPEC = importlib.util.spec_from_file_location('finance_sync_run', ROOT / 'tools/finance-sync-run.py')
finance = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(finance)


def git(path, *args):
    subprocess.run(['git', '-C', str(path), '-c', 'user.name=t', '-c', 'user.email=t@example.test', *args], check=True,
                   capture_output=True)


class ReleaseRunTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        self.state, self.workspace = base / 'state', base / 'work'
        self.state.mkdir()
        self.release = self.checkout('release-train-20990102T000000Z', 'the shipped runner')
        self.older = self.checkout('release-train-20990101T000000Z', 'an older runner')
        sha = subprocess.run(['git', '-C', str(self.release), 'rev-parse', 'HEAD'], capture_output=True, text=True).stdout.strip()
        (self.state / 'train.json').write_text(json.dumps({'release_sha': sha}))

    def tearDown(self):
        self.tmp.cleanup()

    def checkout(self, name, says):
        path = self.workspace / name
        (path / 'tools').mkdir(parents=True)
        (path / '.venv/bin').mkdir(parents=True)
        (path / '.venv/bin/python').write_text('')
        (path / 'tools/finance-sync-run.py').write_text(
            'import os, sys\nprint(' + repr(says) + ', sys.argv[1:], os.path.basename(os.environ.get("PULSE_RELEASE_RUNNER", "")))\n')
        (path / '.gitignore').write_text('.venv/\n')
        git(path, 'init', '-q')
        git(path, 'add', '.')
        git(path, 'commit', '-qm', says)
        return path

    def launch(self, *args):
        env = {**os.environ, 'PULSE_RELEASE_STATE': str(self.state), 'PULSE_RELEASE_WORKSPACE': str(self.workspace)}
        return subprocess.run([sys.executable, str(LAUNCHER), *args], capture_output=True, text=True, env=env, timeout=60)

    def test_runs_the_recorded_release_checkouts_own_script(self):
        run = self.launch('finance-sync-run.py', '--dry-run')
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(run.stdout.strip(), "the shipped runner ['--dry-run'] release-train-20990102T000000Z")

    def test_only_known_runners_start(self):
        self.assertEqual(self.launch('pulse-train.py').returncode, 2)
        self.assertEqual(self.launch('../../bin/sh').returncode, 2)

    def test_nothing_runs_without_a_clean_shipped_checkout(self):
        (self.release / 'tools/finance-sync-run.py').write_text('print("edited")\n')
        run = self.launch('finance-sync-run.py')
        self.assertEqual(run.returncode, 1)
        self.assertNotIn('edited', run.stdout)
        (self.state / 'train.json').unlink()
        self.assertEqual(self.launch('finance-sync-run.py').returncode, 1)

    def test_a_copy_of_the_runner_hands_over_to_the_release_runner(self):
        """An installed copy (or the previous release's runner) execs the pinned release's own runner."""
        execs = []
        home = Path(self.tmp.name) / 'home'
        (home / '.local/state').mkdir(parents=True)
        os.symlink(self.state, home / '.local/state/pulse-release')

        class Exec(BaseException):
            pass

        def fake_exec(program, argv):
            execs.append(argv)
            raise Exec

        with mock.patch.object(finance.Path, 'home', return_value=home), \
                mock.patch.object(finance, 'shipped_checkout', return_value=self.release), \
                mock.patch.object(finance.os, 'execv', side_effect=fake_exec), \
                mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop('PULSE_RELEASE_HANDOVER', None)
            with self.assertRaises(Exec):
                finance.main()
        self.assertEqual(execs[0][1], str(self.release / 'tools/finance-sync-run.py'))


if __name__ == '__main__':
    unittest.main()
