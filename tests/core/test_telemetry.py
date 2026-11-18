"""TELEMETRY: app movements and timings (db/migrations/0983_app_telemetry.sql, services/api/src/telemetry.ts).

The API acceptance (services/api/test/telemetry-runner.mjs): a member's browser batch is stored as that member in their
company with ids, e-mails and content removed; the API times its own requests (request id, person, role, database
time); only leadership reads the overview and a session's timeline, joined by request id; floods and oversized
batches are refused; telemetry_maintain() rolls up by day, version, platform and role and applies retention."""
from __future__ import annotations

from test_sop import demo_world, run_runner


def test_telemetry(worker, owner, api, tmp_path):
    w, p = demo_world(worker, owner, api)
    report = run_runner('telemetry-runner', w, p, tmp_path, timeout=300)
    assert report['ok'] and report['checks'] >= 45
