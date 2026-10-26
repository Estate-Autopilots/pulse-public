import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

SPEC = importlib.util.spec_from_file_location('drive_refresh', Path(__file__).resolve().parents[2] /
                                           'tools/drive-refresh-run.py')
refresh = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(refresh)


class DriveRefreshRunnerTests(unittest.TestCase):
    def test_index_environment_never_replaces_production_worker_connection(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'index.env'
            path.write_text('DATABASE_URL="synthetic-index"\n')
            env = {'DATABASE_URL': 'synthetic-production'}
            refresh.load_index_env(env, path)
            self.assertEqual(env, {'DATABASE_URL': 'synthetic-production', 'EA_INDEX_DATABASE_URL': 'synthetic-index'})

    def test_failed_import_keeps_receipt_and_alerts_without_logging_provider_output(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            state = home / '.local/state/pulse-release'
            state.mkdir(parents=True)
            (state / 'train.json').write_text(json.dumps({'release_sha': 'a' * 40}))
            calls = []

            def run(args, **kwargs):
                calls.append((args, kwargs))
                return SimpleNamespace(returncode=1, stdout='private unstructured provider response', stderr='private error')

            with mock.patch.object(refresh.Path, 'home', return_value=home), \
                    mock.patch.object(refresh, 'shipped_checkout', return_value=home), \
                    mock.patch.object(refresh, 'load_index_env'), \
                    mock.patch.object(refresh.subprocess, 'run', side_effect=run), \
                    mock.patch.dict(os.environ, {'PULSE_DATABASE_URL_MIGRATE': 'synthetic-secret'}):
                self.assertEqual(refresh.main(), 1)
            receipt = json.loads(next((state / 'drive-refresh').glob('*.json')).read_text())
            self.assertFalse(receipt['ok'])
            self.assertIn('finished_at', receipt)
            self.assertNotIn('private', json.dumps(receipt))
            self.assertEqual(calls[0][0][0], '/usr/local/bin/ea-heavy')
            self.assertNotIn('PULSE_DATABASE_URL_MIGRATE', calls[0][1]['env'])
            self.assertEqual(calls[1][0][0], 'ea-notify')


if __name__ == '__main__':
    unittest.main()
