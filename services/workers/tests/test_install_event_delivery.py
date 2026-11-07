"""The existing minute scheduler owns delivery; no background process or secret-bearing output."""
import subprocess
from unittest.mock import patch

from pulse_workers.__main__ import _run_install_event_delivery


def test_existing_tick_uses_bounded_node_bridge_and_masks_output():
    with patch('pulse_workers.__main__.subprocess.run') as run:
        run.return_value.returncode = 0
        _run_install_event_delivery()
        args, kw = run.call_args
        assert args[0][0] == 'node'
        assert args[0][1].endswith('/services/api/dist/install-event-delivery.js')
        assert kw == {'timeout': 32, 'stdout': subprocess.DEVNULL, 'stderr': subprocess.DEVNULL, 'check': False}
    with patch('pulse_workers.__main__.subprocess.run', side_effect=subprocess.TimeoutExpired('node', 32)):
        _run_install_event_delivery()  # the next minute retries; an expired lease preserves bounded state
