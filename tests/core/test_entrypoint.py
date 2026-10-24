"""The image entry point keeps migration credentials out of PID 1 and its four service processes."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

START = Path(__file__).resolve().parents[2] / "infra" / "docker" / "start.sh"
SECRET_VARS = ("PULSE_DATABASE_URL_MIGRATE", "MIGRATE_DATABASE_URL")


def stub(path: Path, body: str) -> None:
    path.write_text("#!/bin/sh\n" + body)
    path.chmod(0o755)


def test_services_and_their_parent_never_hold_the_migration_credentials(tmp_path):
    bin_dir, out = tmp_path / "bin", tmp_path / "out"
    bin_dir.mkdir()
    out.mkdir()
    stub(bin_dir / "pulse-migrate", f'tr "\\0" "\\n" < /proc/$$/environ > {out}/migrate.env\n')
    stub(bin_dir / "node", f'''case "$1" in
  apps/web/server.js) label=web ;;
  services/api/dist/server.js) label=api ;;
  *) exit 127 ;;
esac
printf '%s\\n' "$*" > "{out}/$label.args"
tr "\\0" "\\n" < /proc/$$/environ > "{out}/$label.env"
sleep 3
''')
    stub(bin_dir / "pulse-worker", f'tr "\\0" "\\n" < /proc/$$/environ > {out}/worker.env\n'
         f'tr "\\0" "\\n" < /proc/$PPID/environ > {out}/parent.env\nsleep 3\n')
    stub(bin_dir / "pulse-ingest", f'tr "\\0" "\\n" < /proc/$$/environ > {out}/ingest.env\nsleep 1\n')
    stub(bin_dir / "pulse-ea-bootstrap", f'tr "\\0" "\\n" < /proc/$$/environ > {out}/backfill.env\nsleep 3\n')
    env = {"PATH": f"{bin_dir}:/usr/bin:/bin", "PULSE_DATABASE_URL_MIGRATE": "postgresql://owner@db/x",
           "MIGRATE_DATABASE_URL": "postgresql://owner@db/y", "PULSE_DATABASE_URL_WORKER": "postgresql://w@db/x",
           "PULSE_BOOTSTRAP_ENABLED": "1"}
    proc = subprocess.run(["sh", str(START)], env=env, capture_output=True, timeout=30)
    assert proc.returncode == 1                      # a service stopped, so the container stops as a whole
    migrate_env = (out / "migrate.env").read_text()
    assert all(v in migrate_env for v in SECRET_VARS)
    for name in ("worker.env", "ingest.env", "parent.env", "web.env", "api.env", "backfill.env"):
        text = (out / name).read_text()
        assert not any(f"{v}=" in text for v in SECRET_VARS), name
        assert "PULSE_DATABASE_URL_WORKER=" in text
    assert "PORT=8080" in (out / "web.env").read_text()
    assert "HOSTNAME=0.0.0.0" in (out / "web.env").read_text()
    assert "HOST=127.0.0.1" in (out / "api.env").read_text()
    assert "PORT=8081" in (out / "api.env").read_text()
    assert "HOST=127.0.0.1" in (out / "ingest.env").read_text()
    assert "PORT=8082" in (out / "ingest.env").read_text()
    assert "apps/web/server.js" in (out / "web.args").read_text()
    assert "services/api/dist/server.js" in (out / "api.args").read_text()
    assert os.access(START, os.X_OK)


def test_bootstrap_and_derived_drive_backfill_are_opt_in():
    source = START.read_text()
    assert '${PULSE_BOOTSTRAP_ENABLED:-0}' in source
    assert '${PULSE_DRIVE_BACKFILL_ENABLED:-${PULSE_BOOTSTRAP_ENABLED:-0}}' in source
    assert '${PULSE_DRIVE_CHANGES:-0}' in source
    assert '${PULSE_DRIVE_EXTRACT:-0}' in source
