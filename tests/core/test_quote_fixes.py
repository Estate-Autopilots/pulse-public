"""QUOTE-FIXES (Mac test of production b7110a07, 21 Nov 2026): the quote and document bugs it found, on real PostgreSQL
and tenant row security. The routes run through services/api/test/quote-fixes-runner.mjs. Synthetic people and prices
only; nothing leaves the machine."""
import json
import os
import subprocess
from pathlib import Path

from conftest import dsn
from psycopg.conninfo import conninfo_to_dict
from test_erp_invoice import _seed_erp_world, erp  # noqa: F401  (erp is a fixture)


def run(w, extra=None):
    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    env = {**os.environ, "PULSE_CI": "1", "PULSE_PUBLIC_LOGIN_ENABLED": "0", "TEST_API_CONFIG": json.dumps(config),
           "TEST_W": json.dumps({"org": str(w.org), "finance": str(w.finance), "domain": w.domain, **(extra or {})})}
    result = subprocess.run(["node", "test/quote-fixes-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api",
                            env=env, capture_output=True, text=True, timeout=180)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "QUOTE-FIXES runner: all checks passed" in result.stdout


def test_quote_to_invoice_keeps_gst_and_an_estimate_does_not_block_sending(worker, owner, api, erp):  # noqa: F811
    w = erp
    _seed_erp_world(worker, w)   # Workspace accounts founder@ and finance@ the domain
    run(w)
