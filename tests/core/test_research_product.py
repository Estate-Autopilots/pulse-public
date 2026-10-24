"""Research import boundaries: only synthetic rows, source replay and manual corrections."""

import csv
from datetime import date

import psycopg
import pytest
from helpers import build_world
from pulse_sdk.db import set_tenant
from pulse_workers.research_seed import load, rid
from test_company import configure


def outputs(path, root):
    rows = {
        "engagements_clean": [
            {
                "folder_id": root,
                "project_key": "Synthetic Phase 2 Project",
                "client_key": "",
                "segment_class": "plotting",
                "locality": "Poonawale",
                "month": "2026-09",
                "flags": "",
            }
        ],
        "meta_ad_accounts": [
            {
                "account_id": "synthetic-account",
                "name": "Synthetic account",
                "project_key": "Synthetic Phase 2 Project",
                "client_key": "",
                "match": "exact",
                "score": "1",
            }
        ],
        "meta_spend_txn": [
            {
                "txn_key": "synthetic-receipt",
                "account_id": "synthetic-account",
                "kind": "funds",
                "day": "2026-09-01",
                "amount": "100",
                "currency": "INR",
            }
        ],
        "leads_clean": [
            {
                "lead_id": "synthetic-lead",
                "buyer": "synthetic-hash",
                "project_key": "Synthetic Phase 2 Project",
                "created_ist": "2026-09-01T22:30+05:30",
                "kind": "buyer",
                "platform": "fb",
                "creative_type": "hook",
                "creative_no": "1",
                "language": "marathi",
                "budget_lakh": "25",
                "visit_intent": "this_weekend",
                "config_bhk": "2",
                "sheet_id": "synthetic-sheet",
                "touches": "1",
                "outcome": "unreachable",
            }
        ],
        "meta_ad_events": [
            {
                "day": "2026-09-01",
                "event": "ads_paused",
                "n": "1",
                "account_id": "synthetic-account",
            }
        ],
        "make_errors": [
            {"day": "2026-09-01", "project_key": "Synthetic Phase 2 Project"}
        ],
        "privyr_daily": [{"day": "2026-09-01", "fb_permissions_expired": "1"}],
        "invoices_monthly": [{"month": "2026-09", "invoices": "1"}],
        "mail_monthly": [
            {
                "month": "2026-09",
                "outbound_case_study_mails": "2",
                "sales_replies_received": "1",
                "job_applicant_notices": "3",
            }
        ],
    }
    for name, items in rows.items():
        with (path / f"{name}.csv").open("w") as f:
            w = csv.DictWriter(f, fieldnames=items[0])
            w.writeheader()
            w.writerows(items)


def test_clean_snapshot_replay_manual_money_touch_and_tenant(
    worker, owner, api, tmp_path
):
    w = build_world(worker, owner, api)
    configure(worker, w)
    outputs(tmp_path, w.root)
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute(
            "update pulse.project set project_key='synthetic ph2',segment='luxury',locked=array['segment'] where id=%s",
            (w.project,),
        )
        result = load(worker, w.org, tmp_path, date(2026, 10, 5))
        assert result["manual_fields_preserved"] == 1
        assert worker.execute(
            "select segment,location from pulse.project where id=%s", (w.project,)
        ).fetchone() == {"segment": "luxury", "location": "punawale"}
        assert worker.execute("select count(*) n from pulse.lead").fetchone()["n"] == 1
        worker.execute(
            "update pulse.lead_touch set touches=2,outcome='visit_done',manual=true"
        )
        worker.execute("update pulse_priv.ad_account set project_key=null,manual=true")
        load(worker, w.org, tmp_path, date(2026, 10, 5))
        assert (
            worker.execute("select count(*) n from pulse_priv.ad_funding").fetchone()[
                "n"
            ]
            == 1
        )
        assert (
            worker.execute("select outcome from pulse.lead_touch").fetchone()["outcome"]
            == "visit_done"
        )
        assert (
            worker.execute("select project_key from pulse_priv.ad_account").fetchone()[
                "project_key"
            ]
            is None
        )
        assert (
            worker.execute(
                "select count(*) n from pulse.audit_event where resource='research.cleaning'"
            ).fetchone()["n"]
            == 2
        )
    # API never has buyer hash / contact access. Money SELECT has a grant and RLS backstop.
    with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
        set_tenant(api, w.org, w.manager)
        api.execute("select phone_hash from pulse_priv.buyer")
    with api.transaction():
        set_tenant(api, w.org, w.editor)
        assert (
            api.execute("select count(*) n from pulse_priv.ad_funding").fetchone()["n"]
            == 0
        )
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        assert (
            api.execute("select count(*) n from pulse_priv.ad_funding").fetchone()["n"]
            == 1
        )
    other = build_world(worker, owner, api)
    with worker.transaction():
        set_tenant(worker, other.org)
        assert (
            worker.execute("select count(*) n from pulse.lead_answer").fetchone()["n"]
            == 0
        )
    with (tmp_path / "leads_clean.csv").open("a") as f:
        f.write("\n")
    with pytest.raises(ValueError, match="source-row migration"), worker.transaction():
        set_tenant(worker, w.org)
        load(worker, w.org, tmp_path, date(2026, 10, 5))


def test_impossible_lead_date_stays_unknown(worker, owner, api, tmp_path):
    w = build_world(worker, owner, api)
    configure(worker, w)
    outputs(tmp_path, w.root)
    p = tmp_path / "leads_clean.csv"
    p.write_text(p.read_text().replace("2026-09-01T22:30", "2027-09-01T22:30"))
    with worker.transaction():
        set_tenant(worker, w.org)
        load(worker, w.org, tmp_path, date(2026, 10, 5))
        lead = worker.execute(
            "select created_at,buyer_id from pulse.lead where id=%s",
            (rid(w.org, "lead", "synthetic-lead"),),
        ).fetchone()
        assert lead["created_at"] is None
