"""CONNECT: client connections between organisations (db/migrations/0953_connect_clients.sql, services/api/src/connect.ts).

The API acceptance (services/api/test/connect-runner.mjs): a leader sends a pre-filled client request, the client opens
the link signed out, makes a Pulse account and sets up their organisation from it; both organisations see the
connection and the referral; a group and a task cross through explicit shared objects only; the client replies and
finishes the task from their seat; the client gives a task back; the seat sees nothing else of the organisation."""
from __future__ import annotations

from test_sop import demo_world, run_runner


def test_connect_clients(worker, owner, api, tmp_path):
    w, p = demo_world(worker, owner, api)
    report = run_runner('connect-runner', w, p, tmp_path, timeout=600)
    assert report['ok'] and report['checks'] >= 50
