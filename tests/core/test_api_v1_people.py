"""EST-2811: Sign in with Pulse (OAuth) and the people/admin operations over API v1 and MCP, on real tenant RLS."""
import json
import os
import subprocess
from pathlib import Path

from conftest import dsn
from test_site_visit_settings import _config
from test_hr_suite import ADMIN, HR
from test_tasks_rt1 import team  # noqa: F401


def test_oauth_people_operations(team):  # noqa: F811
    w = team
    env = {**os.environ, 'PULSE_CI': '1', 'PULSE_PUBLIC_LOGIN_ENABLED': '0', 'PULSE_PUBLIC_URL': 'https://pulse.synthetic.example',
           'TEST_API_CONFIG': _config(dsn('api')),
           'TEST_W': json.dumps({'org': str(w.org), 'hr': str(w.lead), 'admin': str(w.manager), 'editor': str(w.editor), 'editor2': str(w.editor2),
                                 'hrEmail': HR, 'adminEmail': ADMIN, 'editorEmail': w.editor_handle})}
    # The HTTP/MCP matrix, then the maintained MCP SDK client signing in through the web handlers (end to end).
    for runner in ('test/people-oauth-runner.mjs', 'test/mcp-oauth-sdk-runner.mjs'):
        p = subprocess.run(['node', runner], cwd=Path(__file__).resolve().parents[2] / 'services/api',
                           env=env, text=True, capture_output=True, timeout=240)
        assert p.returncode == 0, runner + ': ' + (p.stdout + p.stderr)[-6000:]
