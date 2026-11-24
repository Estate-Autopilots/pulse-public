"""QUOTE-BUILDER-4 (2498; Kazuk's 19 Nov test, VTI task 1514f831; owner order 20 Nov ~23:10 IST): a quantity in two
numbers ("6 users × 6 months", never "× 36"), the prepaid discount by months from the item's rate card, a package opened
into its phase parts by the AI's create_quotation, and only active catalogue items on quotations. On real PostgreSQL
and tenant row security; the routes run through services/api/test/quote-two-numbers-runner.mjs. Synthetic data only."""
import json
import os
import subprocess
import uuid
from pathlib import Path

import psycopg
import pytest
from conftest import dsn
from psycopg.conninfo import conninfo_to_dict
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from test_erp_invoice import _seed_erp_world, as_, erp, one  # noqa: F401  (erp is a fixture)
from test_quote_lines import draft

SIX_BY_SIX = [{"n": 6, "unit": "user"}, {"n": 6, "unit": "month"}]


def test_a_lines_numbers_make_its_quantity(api, erp):  # noqa: F811
    w = erp
    did = draft(api, w, w.finance, [("Synthetic seats", 189900, None, False, False)])
    as_(api, w, w.finance, "update pulse.erp_line set qty=36,qty_dims=%s where document_id=%s", (Jsonb(SIX_BY_SIX), did))
    assert one(api, w, w.finance, "select qty_dims from pulse.erp_line where document_id=%s", (did,))["qty_dims"] == SIX_BY_SIX
    # Numbers that do not make the quantity, one number alone, a nought or a missing word are refused.
    for dims, qty in ((SIX_BY_SIX, 3), ([{"n": 36, "unit": "user"}], 36), ([{"n": 0, "unit": "user"}, {"n": 6, "unit": "month"}], 0.001),
                      ([{"n": 6, "unit": ""}, {"n": 6, "unit": "month"}], 36), ([{"n": 6}, {"n": 6, "unit": "month"}], 36)):
        with pytest.raises(psycopg.errors.CheckViolation):
            as_(api, w, w.finance, "update pulse.erp_line set qty=%s,qty_dims=%s where document_id=%s", (qty, Jsonb(dims), did))
    # Kazuk's "36 jumped to 3": the quantity cannot move away from its numbers.
    with pytest.raises(psycopg.errors.CheckViolation):
        as_(api, w, w.finance, "update pulse.erp_line set qty=3 where document_id=%s", (did,))
    as_(api, w, w.finance, "update pulse.erp_line set qty=3,qty_dims=null where document_id=%s", (did,))


def _seed_neeti(owner, w):
    """Synthetic phases, seats sold per user per month (Pro with a rate card, AI without), a package of parts and a draft.
    Set up as the owner (migration) role, as production's admin tooling would."""
    worker = owner
    ids = {k: uuid.uuid4() for k in ("seatsPro", "seatsAi", "study", "video", "videoLux", "ads", "kit", "growth", "draftFilm", "card")}
    phases = [{"key": "p1-plan", "name": "Phase 1: Synthetic plan", "groups": []}, {"key": "p2-make", "name": "Phase 2: Synthetic make", "groups": []},
              {"key": "p3-run", "name": "Phase 3: Synthetic run", "groups": []}, {"key": "p4-sales", "name": "Phase 4: Synthetic sales system", "groups": []}]
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.erp_settings set phases=%s where org_id=%s", (Jsonb(phases), w.org))
        for key, name, unit, price, phase, status in (("seatsPro", "Synthetic seats (pro)", "user/month", 119900, "p4-sales", "active"),
                                                      ("seatsAi", "Synthetic seats (AI)", "user/month", 189900, "p4-sales", "active"),
                                                      ("study", "Synthetic market study", "nos", 420008, "p1-plan", "active"),
                                                      ("video", "Synthetic video ad (standard)", "nos", 3350550, "p2-make", "active"),
                                                      ("videoLux", "Synthetic video ad (luxury)", "nos", 6125000, "p2-make", "active"),
                                                      ("ads", "Synthetic ads and nurturing", "month", 700000, "p3-run", "active"),
                                                      ("kit", "Synthetic partner kit", "nos", 1000000, None, "active"),
                                                      ("draftFilm", "Synthetic brand film (old draft)", "nos", 10000000, "p2-make", "draft")):
            worker.execute("insert into pulse.erp_item(id,org_id,kind,name,unit,price,gst_rate,status,phase) values(%s,%s,'service',%s,%s,%s,18,%s,%s)",
                           (ids[key], w.org, name, unit, price, status, phase))
        worker.execute("""insert into pulse.erp_item(id,org_id,kind,name,description,unit,price,gst_rate,status) values(%s,%s,'package','Synthetic Growth Package',
            '4-month term. Synthetic research, two videos, ads and the sales system','package',0,18,'active')""", (ids["growth"], w.org))
        for pos, (key, qty, unit, price) in enumerate((("study", 1, "nos", 420008), ("video", 2, "nos", 3350550), ("ads", 4, "month", 700000),
                                                       ("seatsPro", 20, "user/month", 113905), ("kit", 1, "nos", 0))):
            label = worker.execute("select name from pulse.erp_item where id=%s", (ids[key],)).fetchone()["name"]
            worker.execute("insert into pulse.erp_package_part(org_id,package_id,position,item_id,label,quantity,unit,price) values(%s,%s,%s,%s,%s,%s,%s,%s)",
                           (w.org, ids["growth"], pos, ids[key], label, qty, unit, price))
        # Kazuk's Neeti card: ₹200 × users × tier × months × the prepaid factor (3–5 months 5 %, 6–9 10 %, 12 15 %).
        worker.execute("""insert into pulse.erp_rate_card(id,org_id,item_id,name,base,x_label,x_min,x_max,talents,periods) values(%s,%s,%s,
            'Phase 4: Synthetic sales system — Seats',20000,'Users',1,50,%s,%s)""",
                       (ids["card"], w.org, ids["seatsPro"], Jsonb([{"key": "standard", "label": "Pro", "factor": 5.995}]),
                        Jsonb([{"key": "m2", "label": "2 months", "factor": 1, "months": 2}, {"key": "q", "label": "3 months (5% prepaid)", "factor": 0.95, "months": 3},
                               {"key": "m4", "label": "4 months (5% prepaid)", "factor": 0.95, "months": 4}, {"key": "m6", "label": "6 months (10% prepaid)", "factor": 0.9, "months": 6},
                               {"key": "m12", "label": "12 months (15% prepaid)", "factor": 0.85, "months": 12}])))
    return ids


def test_the_prepaid_tiers_come_from_the_rate_card_of_the_item_or_of_its_kind(owner, api, erp):  # noqa: F811
    w = erp
    ids = _seed_neeti(owner, w)
    tiers = [{"months": 2, "percent": 0}, {"months": 3, "percent": 5}, {"months": 4, "percent": 5}, {"months": 6, "percent": 10}, {"months": 12, "percent": 15}]
    for key in ("seatsPro", "seatsAi"):
        assert one(api, w, w.finance, "select pulse.erp_item_term_tiers(%s) t", (ids[key],))["t"] == tiers, key
    # An item sold in another unit, or in no phase, takes none; nor does anyone outside Billing.
    assert one(api, w, w.finance, "select pulse.erp_item_term_tiers(%s) t", (ids["study"],))["t"] == []
    assert one(api, w, w.member, "select pulse.erp_item_term_tiers(%s) t", (ids["seatsAi"],))["t"] == []
    # An archived card prices nothing.
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("update pulse.erp_rate_card set status='archived' where id=%s", (ids["card"],))
    assert one(api, w, w.finance, "select pulse.erp_item_term_tiers(%s) t", (ids["seatsAi"],))["t"] == []


def test_ketans_four_gaps_through_the_routes(worker, owner, api, erp):  # noqa: F811
    w = erp
    _seed_erp_world(worker, w)   # Workspace accounts founder@ and finance@ the domain
    ids = _seed_neeti(owner, w)
    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    env = {**os.environ, "PULSE_CI": "1", "PULSE_PUBLIC_LOGIN_ENABLED": "0", "TEST_API_CONFIG": json.dumps(config),
           "TEST_W": json.dumps({"org": str(w.org), "finance": str(w.finance), "domain": w.domain, **{k: str(v) for k, v in ids.items()}})}
    result = subprocess.run(["node", "test/quote-two-numbers-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api",
                            env=env, capture_output=True, text=True, timeout=120)
    assert result.returncode == 0, result.stdout + result.stderr
