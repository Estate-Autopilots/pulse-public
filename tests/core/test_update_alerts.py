"""Updates fan out through R27 under forced RLS; providers use the existing sink."""
import json
import os
import subprocess
from pathlib import Path

from conftest import GROUPS, dsn
from psycopg.conninfo import conninfo_to_dict
from test_tasks_rt1 import team  # noqa: F401


def test_update_alerts_outbox_acceptance(api, worker, owner, team):  # noqa: F811
    w = team
    configs = {}
    for role in ('api', 'worker'):
        config = conninfo_to_dict(dsn(role))
        config['database'] = config.pop('dbname')
        configs[role] = config
    configs['owner'] = conninfo_to_dict(owner.info.dsn)
    configs['owner']['database'] = configs['owner'].pop('dbname')
    env = {**os.environ, 'TEST_CONFIGS': json.dumps(configs),
           'TEST_PEOPLE': json.dumps({
               'a': {'id': str(w.editor), 'email': w.editor_handle},
               'b': {'id': str(w.editor2), 'email': f'editor2@{w.domain}'},
               'sender': {'id': str(w.lead), 'email': 'hr@estateautopilots.com'},
               'outside': {'id': str(w.manager), 'email': 'admin@estateautopilots.com'}}),
           'TEST_ORG': str(w.org), 'TEST_OWNER_ROLE': GROUPS['owner'], 'PULSE_NOTIFICATION_MODE': 'sink',
           'PULSE_OPERATOR_TOKEN': 'synthetic-update-alerts-' + '0' * 32}
    result = subprocess.run(['node', 'test/update-alerts-runner.mjs'],
                            cwd=Path(__file__).resolve().parents[2] / 'services/api',
                            env=env, capture_output=True, text=True, timeout=90, check=False)
    assert result.returncode == 0, result.stdout + result.stderr
