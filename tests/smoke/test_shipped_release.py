"""FIN-LIVE fix (Nov 2026): release jobs run from the clean checkout of the commit production runs.

From 1 Nov 2026 production was shipped with pulse_local_deploy.py while train.json still named an older release, so
the finance sync and the Drive import refused every run. The checkout now follows deploy-production.json and is
created (a detached worktree with its virtualenv) when no clean one exists.
"""
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
sys.path.insert(0, str(ROOT / 'tools'))
import shipped_release  # noqa: E402

SPEC = importlib.util.spec_from_file_location('finance_sync_run_pin', ROOT / 'tools/finance-sync-run.py')
finance = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(finance)


def git(*args, cwd=None):
    return subprocess.run(['git', '-c', 'user.name=t', '-c', 'user.email=t@example.test', *args], cwd=cwd, check=True,
                          capture_output=True, text=True).stdout.strip()


class ShippedCheckoutTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        self.strike, self.origin = base / 'strike', base / 'pulse.git'
        self.workspace, self.state, self.deploy = base / 'work', base / 'state', base / 'deploy-production.json'
        self.workspace.mkdir()
        self.strike.mkdir()
        git('init', '-q', cwd=self.strike)
        (self.strike / '.gitignore').write_text('.venv/\n')
        self.shas = []
        for n in range(3):
            (self.strike / 'runner.py').write_text('release %d\n' % n)
            git('add', '.', cwd=self.strike)
            git('commit', '-qm', 'release %d' % n, cwd=self.strike)
            self.shas.append(git('rev-parse', 'HEAD', cwd=self.strike))
        git('clone', '-q', '--bare', str(self.strike), str(self.origin))
        self.builds = []
        self.stamp = 1_800_000_000

    def tearDown(self):
        self.tmp.cleanup()

    def ship(self, sha, healthy=True):
        self.deploy.write_text(json.dumps({'sha': sha, 'healthy': healthy, 'env': 'production'}))

    def build(self, checkout):
        self.builds.append(checkout.name)
        (checkout / '.venv/bin').mkdir(parents=True, exist_ok=True)
        (checkout / '.venv/bin/python').write_text('')

    def pin(self, build=None):
        path, sha = shipped_release.shipped_checkout(self.workspace, 'finance sync', deploy_state=self.deploy,
                                                     origin=self.origin, strike=self.strike, state=self.state,
                                                     build=build or self.build)
        if path.name.startswith('shipped-'):  # creation order, for the retention tests (one second apart)
            self.stamp += 1
            os.utime(path / '.git', (self.stamp, self.stamp))
        return path, sha

    def train_checkout(self, name, sha, venv=True):
        path = self.workspace / name
        git('--git-dir', str(self.origin), 'worktree', 'add', '-q', '--detach', str(path), sha)
        if venv:
            self.build(path)
            self.builds.clear()
        return path

    def test_a_clean_release_train_checkout_at_the_production_commit_is_used(self):
        train = self.train_checkout('release-train-20990101T000000Z', self.shas[1])
        self.ship(self.shas[1])
        self.assertEqual(self.pin(), (train, self.shas[1]))
        self.assertEqual(self.builds, [])
        self.assertEqual(list(self.workspace.glob('shipped-*')), [])

    def test_production_decides_not_train_json_and_only_when_healthy(self):
        self.ship(self.shas[1], healthy=False)
        with self.assertRaisesRegex(RuntimeError, 'Production release is not healthy'):
            self.pin()
        self.deploy.write_text(json.dumps({'healthy': True}))
        with self.assertRaisesRegex(RuntimeError, 'Production release is not healthy'):
            self.pin()
        self.deploy.write_text(json.dumps({'sha': 'eba44c5c', 'healthy': True}))  # not a full commit id
        with self.assertRaisesRegex(RuntimeError, 'Production release is not healthy'):
            self.pin()
        self.deploy.unlink()
        with self.assertRaisesRegex(RuntimeError, 'deploy state unreadable'):
            self.pin()
        self.assertEqual(self.builds, [])

    def test_a_missing_checkout_is_created_detached_with_its_virtualenv_once(self):
        self.train_checkout('release-train-20990101T000000Z', self.shas[0])  # the train's last release, now behind
        self.ship(self.shas[2])
        path, sha = self.pin()
        self.assertEqual(path, self.workspace / ('shipped-' + self.shas[2][:12]))
        self.assertEqual(sha, self.shas[2])
        self.assertEqual(git('rev-parse', 'HEAD', cwd=path), self.shas[2])
        self.assertEqual(subprocess.run(['git', '-C', str(path), 'symbolic-ref', '-q', 'HEAD']).returncode, 1)  # detached
        self.assertIn(str(path), git('--git-dir', str(self.origin), 'worktree', 'list'))  # from the bare repository
        self.assertEqual((path / shipped_release.READY).read_text().strip(), self.shas[2])
        self.assertEqual(self.builds, [path.name])
        self.assertEqual(self.pin()[0], path)
        self.assertEqual(self.builds, [path.name])  # ready: never rebuilt

    def test_a_checkout_with_local_edits_is_never_used(self):
        train = self.train_checkout('release-train-20990101T000000Z', self.shas[1])
        (train / 'runner.py').write_text('edited\n')
        self.ship(self.shas[1])
        path, _ = self.pin()
        self.assertEqual(path.name, 'shipped-' + self.shas[1][:12])  # a fresh clean one instead
        (path / 'runner.py').write_text('edited\n')
        with self.assertRaisesRegex(RuntimeError, 'Shipped finance sync has local edits'):
            self.pin()

    def test_a_failed_virtualenv_build_is_never_marked_ready_and_is_retried(self):
        self.ship(self.shas[1])

        def broken(checkout):
            (checkout / '.venv/bin').mkdir(parents=True)
            (checkout / '.venv/bin/python').write_text('')  # uv makes the interpreter before installing anything
            raise RuntimeError('Shipped checkout virtualenv build failed (uv exit 2)')

        with self.assertRaisesRegex(RuntimeError, 'uv exit 2'):
            self.pin(build=broken)
        target = self.workspace / ('shipped-' + self.shas[1][:12])
        self.assertFalse((target / shipped_release.READY).exists())
        self.assertEqual(self.pin()[0], target)
        self.assertEqual(self.builds, [target.name])

    def test_strike_supplies_a_commit_the_bare_repository_lacks(self):
        (self.strike / 'runner.py').write_text('direct ship\n')
        git('commit', '-qam', 'direct ship', cwd=self.strike)
        sha = git('rev-parse', 'HEAD', cwd=self.strike)
        self.ship(sha)
        path, _ = self.pin()
        self.assertEqual(git('rev-parse', 'HEAD', cwd=path), sha)
        self.assertIn(str(path), git('worktree', 'list', cwd=self.strike))

    def test_a_commit_in_neither_repository_refuses(self):
        self.ship('f' * 40)
        with self.assertRaisesRegex(RuntimeError, 'is not in the repository'):
            self.pin()
        self.assertEqual(list(self.workspace.iterdir()), [])

    def test_older_shipped_checkouts_are_pruned_keeping_the_last_two_and_any_with_changes(self):
        names = ['shipped-' + sha[:12] for sha in self.shas]
        for sha in self.shas:
            self.ship(sha)
            self.pin()
        self.assertEqual(sorted(p.name for p in self.workspace.glob('shipped-*')), sorted(names[1:]))
        self.assertNotIn(names[0], git('--git-dir', str(self.origin), 'worktree', 'list'))  # unregistered too
        (self.workspace / names[1] / 'notes.txt').write_text('a person\'s work\n')  # untracked: never removed
        (self.strike / 'runner.py').write_text('release 3\n')
        git('commit', '-qam', 'release 3', cwd=self.strike)
        git('push', '-q', str(self.origin), 'HEAD:refs/heads/main', cwd=self.strike)
        newest = git('rev-parse', 'HEAD', cwd=self.strike)
        self.ship(newest)
        self.pin()
        self.assertEqual(sorted(p.name for p in self.workspace.glob('shipped-*')),
                         sorted([names[1], names[2], 'shipped-' + newest[:12]]))
        train = self.train_checkout('release-train-20990101T000000Z', self.shas[0])
        self.ship(self.shas[0])
        self.assertEqual(self.pin()[0], train)  # a release-train checkout is the train's to retire, never pruned here


class ErrorTextTests(unittest.TestCase):
    def test_keeps_the_first_line_short_without_credentials(self):
        self.assertEqual(shipped_release.error_text(RuntimeError('Production release is not healthy')),
                         'Production release is not healthy')
        text = shipped_release.error_text(RuntimeError(
            'connect https://db.example.test:5432/pulse?user=pulse failed password=hunter2x token: abc '
            'key Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy\nsecond line'))
        self.assertNotIn('example.test', text)
        self.assertNotIn('hunter2x', text)
        self.assertNotIn('abc', text)
        self.assertNotIn('Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy', text)
        self.assertNotIn('second line', text)
        self.assertEqual(text, 'connect <url> failed password=<redacted> token: <redacted> key <redacted>')
        self.assertEqual(len(shipped_release.error_text(ValueError('x' * 500))), 120)
        self.assertEqual(shipped_release.error_text(KeyError()), '')
        sha = 'eba44c5cd62f576a2dbaee6b280933126102234d'
        self.assertIn(sha[:12], shipped_release.error_text(RuntimeError('commit ' + sha[:12] + ' missing')))


class FinanceReceiptTests(unittest.TestCase):
    def test_a_failed_pin_records_the_error_class_and_message(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            with mock.patch.object(finance.Path, 'home', return_value=home), \
                    mock.patch.object(finance, 'shipped_checkout',
                                      side_effect=RuntimeError('Shipped finance sync has local edits')), \
                    mock.patch.object(finance.subprocess, 'run') as run:
                self.assertEqual(finance.main(), 1)
            receipt = json.loads(next((home / '.local/state/pulse-release/finance-sync').glob('*.json')).read_text())
            self.assertFalse(receipt['ok'])
            self.assertEqual(receipt['error'], 'RuntimeError')
            self.assertEqual(receipt['error_message'], 'Shipped finance sync has local edits')
            self.assertEqual(run.call_args_list[-1][0][0][0], 'ea-notify')


if __name__ == '__main__':
    unittest.main()
