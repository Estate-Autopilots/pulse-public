import json
import uuid

import pytest

from pulse_gdrive_changes.connect import google_client, main


def test_google_client_install_status_and_private_paths(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv('PULSE_CONNECTOR_SECRETS_DIR', str(tmp_path))
    org, other = str(uuid.uuid4()), str(uuid.uuid4())
    source = tmp_path / 'source.json'
    source.write_text(json.dumps({'client_id': 'synthetic-client', 'client_secret': 'SyntheticSecretNeverPrinted'}))
    assert google_client(org)['installed'] is False
    assert main(['google-client', '--org-id', org, '--file', str(source)]) == 0
    output = capsys.readouterr().out
    status = json.loads(output)
    assert status['installed'] and len(status['credentialId']) == 12
    assert 'synthetic-client' not in output and 'SyntheticSecretNeverPrinted' not in output
    assert google_client(other)['installed'] is False
    target = tmp_path / org / 'google-sign-in.json'
    assert target.stat().st_mode & 0o777 == 0o600
    target.chmod(0o644)
    assert google_client(org)['installed'] is False
    target.unlink()
    target.symlink_to(source)
    assert google_client(org)['installed'] is False
    with pytest.raises(ValueError, match='Google client refused'):
        google_client(org, source)
    target.unlink()
    (tmp_path / other).symlink_to(tmp_path / org)
    with pytest.raises(ValueError, match='Google client refused'):
        google_client(other, source)
