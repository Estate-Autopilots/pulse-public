"""ORG: one Pulse account per human across organisations (db/migrations/0920_org_accounts.sql, services/api/src/accounts.ts).

The API acceptance (services/api/test/org-runner.mjs): handles, Start your own Pulse with an industry pack, switching
organisation without signing in again, a freelancer in two organisations, a client who starts their own Pulse, an
invitation to a handle, the portable profile and what each organisation may see of it."""
from __future__ import annotations

from test_sop import demo_world, run_runner


def test_org_accounts(worker, owner, api, tmp_path):
    w, p = demo_world(worker, owner, api)
    report = run_runner('org-runner', w, p, tmp_path, timeout=600)
    assert report['checks'] >= 90
