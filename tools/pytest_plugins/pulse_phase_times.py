"""pytest plugin: one JSON line per test phase (setup, call, teardown) with its seconds (EST-1575).

tools/ci-db-shards.py loads it in every shard (`-p pulse_phase_times`, this directory on PYTHONPATH) and sets
PULSE_CI_PHASES_OUT to a per-shard file; it then reports the slowest individual tests with their fixture cost (setup,
teardown) apart from the test body (call). JUnit's time is the three added together. Without PULSE_CI_PHASES_OUT the
plugin does nothing. A browser test retried in place (tests/core/conftest.py) reports its last attempt only. The file
is opened at the first report; when it cannot be opened or written the plugin says so once and stops, and the tests
and their exit code go on unchanged.
"""
from __future__ import annotations

import json
import os

_CONFIG = None
_PATH: str | None = None
_OUT = None


def pytest_configure(config):
    global _CONFIG, _PATH
    _CONFIG, _PATH = config, os.environ.get("PULSE_CI_PHASES_OUT") or None


def _off(error: Exception) -> None:
    global _PATH, _OUT
    out, _OUT, _PATH = _OUT, None, None
    if out is not None:
        try:
            out.close()
        except (OSError, ValueError):
            pass
    reporter = _CONFIG.pluginmanager.get_plugin("terminalreporter") if _CONFIG is not None else None
    if reporter is not None:
        reporter.write_line(f"pulse_phase_times: phase times off for this shard ({type(error).__name__}: {error})",
                            yellow=True)


def pytest_runtest_logreport(report):
    global _OUT
    if _PATH is None:
        return
    try:
        if _OUT is None:
            _OUT = open(_PATH, "a", encoding="utf-8")  # noqa: SIM115 (closed in pytest_unconfigure)
        _OUT.write(json.dumps({"nodeid": report.nodeid, "when": report.when, "seconds": round(report.duration, 3),
                               "outcome": report.outcome}) + "\n")
        _OUT.flush()
    except (OSError, ValueError) as error:
        _off(error)


def pytest_unconfigure(config):
    global _OUT
    out, _OUT = _OUT, None
    if out is not None:
        try:
            out.close()
        except (OSError, ValueError) as error:
            _off(error)
