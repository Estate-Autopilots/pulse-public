"""QUOTE-LINKS (owner, 22 Nov 2026: "links go to pulse dot estate autopilots … we keep sending spammy links again and
again"): customer links on the brand address, and no repeat sends of the same document within a week unless the seller
chooses Send again, on real PostgreSQL. The routes run through services/api/test/quote-links-runner.mjs with the
production address settings. Synthetic data only; mail goes to the test sink."""
import json
import os
import subprocess
from pathlib import Path

from conftest import dsn
from psycopg.conninfo import conninfo_to_dict
from test_erp_invoice import _seed_erp_world, erp  # noqa: F401  (erp is a fixture)


def test_customer_links_use_the_brand_address_and_nothing_is_sent_twice(worker, owner, api, erp):  # noqa: F811
    w = erp
    _seed_erp_world(worker, w)
    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    env = {**os.environ, "PULSE_CI": "1", "PULSE_PUBLIC_LOGIN_ENABLED": "0", "TEST_API_CONFIG": json.dumps(config),
           "PULSE_PUBLIC_URL": "https://pulse.estateautopilots.com",
           "PULSE_HOST_FAMILIES": json.dumps([{"name": "vitals", "app": "app.vitalsos.ai", "api": "api.vitalsos.ai", "mcp": "mcp.vitalsos.ai", "id": "id.vitalsos.ai"}]),
           "TEST_W": json.dumps({"org": str(w.org), "domain": w.domain})}
    result = subprocess.run(["node", "test/quote-links-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api",
                            env=env, capture_output=True, text=True, timeout=180)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "QUOTE-LINKS runner: all checks passed" in result.stdout
