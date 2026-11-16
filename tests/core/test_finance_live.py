"""FIN-LIVE real service-role checks: leadership-only live views, Accountant exclusion, audit and desk guards."""
import psycopg
import pytest
from psycopg.types.json import Jsonb

from pulse_sdk.db import set_tenant
from test_finance_desk import call, finance_world  # noqa: F401 - shared RF1 world with a verified Accountant


def seed_live(worker, org):
    with worker.transaction():
        set_tenant(worker, org)
        worker.execute(
            "insert into pulse_priv.finance_live_record(org_id,kind,key,scope,body,source,hash,confidence) values(%s,'invoice','INV-00000001','mail:sales',%s,%s,%s,'high')",
            (org, Jsonb({"number": "INV-00000001", "total": 118.0}), Jsonb({"type": "mail", "message": "synthetic"}), "a" * 64),
        )
        worker.execute("insert into pulse_priv.finance_live_model(org_id,body) values(%s,%s)", (org, Jsonb({"brief": [{"key": "revenue", "text": "Synthetic"}]})))
        worker.execute("insert into pulse_priv.finance_live_source(org_id,key,body) values(%s,'mail:sales',%s)", (org, Jsonb({"label": "Synthetic invoices", "records": 1})))


def test_leadership_reads_live_finance_and_each_read_is_audited(api, worker, owner, finance_world):
    w, _, _ = finance_world
    seed_live(worker, w.org)
    state = call(api, w, "pulse.finance_live_state()", viewer=w.manager)
    assert state["model"]["brief"][0]["text"] == "Synthetic" and state["sources"][0]["label"] == "Synthetic invoices"
    rows = call(api, w, "pulse.finance_live_records('invoice',0)", viewer=w.manager)
    assert rows["total"] == 1 and rows["rows"][0]["source"]["type"] == "mail"
    with owner.transaction():
        set_tenant(owner, w.org)
        assert owner.execute(
            "select count(*) n from pulse.audit_event where org_id=%s and actor_id=%s and resource='finance.live' and action='restricted_read'",
            (w.org, w.manager),
        ).fetchone()["n"] >= 2


def test_accountant_and_staff_never_read_uncertified_live_views(api, worker, finance_world):
    w, _, verified = finance_world
    seed_live(worker, w.org)
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        call(api, w, "pulse.finance_live_state()", viewer=w.editor, session=verified)
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        call(api, w, "pulse.finance_live_records('invoice',0)", viewer=w.editor, session=verified)
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        call(api, w, "pulse.finance_live_state()", viewer=w.lead)
    with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
        set_tenant(api, w.org, w.manager)
        api.execute("select count(*) from pulse_priv.finance_live_record").fetchone()


def test_desk_live_rows_are_guarded_payroll_totals_only_and_rf1_rows_untouched(api, worker, finance_world):
    w, _, verified = finance_world
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse_priv.finance_desk_record(org_id,kind,key,body,synthetic) values(%s,'purchase','rf1-row',%s,false)", (w.org, Jsonb({"vendor": "RF1 intake"})))
        put = lambda kind, key, body: worker.execute("select pulse.finance_desk_live_put(%s,%s,%s) changed", (kind, key, Jsonb(body))).fetchone()["changed"]  # noqa: E731
        assert put("sales", "INV-00000001", {"origin": "finance-live", "total": 118, "source": {"mailbox": "m", "message": "1", "attachment": "a"}})
        assert not put("sales", "INV-00000001", {"origin": "finance-live", "total": 118, "source": {"mailbox": "m", "message": "1", "attachment": "a"}})
        assert put("payroll", "payout:2026-09", {"origin": "finance-live", "month": "2026-09", "name": "All staff (monthly total)", "amount": 1000})
        with pytest.raises(psycopg.errors.InvalidParameterValue), worker.transaction():
            put("payroll", "payout:2026-08", {"origin": "finance-live", "month": "2026-08", "name": "Project Lead", "amount": 1000})
        with pytest.raises(psycopg.errors.InsufficientPrivilege), worker.transaction():
            put("purchase", "rf1-row", {"origin": "finance-live", "vendor": "Overwrite attempt"})
        assert worker.execute("select pulse.finance_desk_live_prune('purchase',%s) n", ([],)).fetchone()["n"] == 0
        assert worker.execute("select pulse.finance_desk_live_prune('sales',%s) n", ([],)).fetchone()["n"] == 1
    data = call(api, w, "pulse.finance_desk_state(false)", viewer=w.editor, session=verified)
    purchase = next(r for r in data["records"] if r["kind"] == "purchase")
    assert purchase["body"] == {"vendor": "RF1 intake"}
    assert [r["body"]["name"] for r in data["records"] if r["kind"] == "payroll"] == ["All staff (monthly total)"]


def test_sync_store_is_idempotent_prunes_rereads_and_writes_desk_totals(api, worker, finance_world):
    from datetime import date

    from pulse_workers.finance_live import model, sync

    w, _, verified = finance_world

    def result(amount):
        r = sync.Result()
        r.scopes.add("sheet:synthetic")
        r.add("cost_month", "2026-09", {"month": "2026-09", "payroll": amount, "people": 3, "items": {"Office & rent": 100.0}, "confidence": "medium"},
              {"type": "sheet", "fileId": "synthetic", "file": "Synthetic cost sheet", "sheet": "Sep", "rows": 3}, "medium", "sheet:synthetic")
        r.add("invoice", "INV-00003001", {"number": "INV-00003001", "date": "2026-09-01", "due": "2026-09-05", "client": "Synthetic Client", "taxable": 100.0,
              "total": 118.0, "balanceDue": 118.0, "messages": ["m1"]}, {"type": "mail", "mailbox": "m@example.test", "message": "m1", "attachment": "a.pdf",
              "sent": "2026-09-01"}, "high", "mail:sales")
        r.sources["sheet:synthetic"] = {"label": "Synthetic cost sheet", "kind": "sheet", "status": "ok", "records": 1}
        r.ads = [{"txn": "t1", "accountId": "1001", "accountName": "", "kind": "funds", "day": "2026-09-02", "amount": 500.0, "currency": "INR",
                  "mailbox": "m@example.test", "message": "x"}]
        return r

    with worker.transaction():
        set_tenant(worker, w.org)
        first = sync.store(worker, w.org, None, result(1000.0), {})
        assert first == {"inserted": 2, "changed": 0, "pruned": 0}
        assert sync.store_ads(worker, w.org, result(1000.0).ads) == {"accounts": 1, "newReceipts": 1}
        existing = sync.load_existing(worker)
        assert sync.store(worker, w.org, None, result(1000.0), existing) == {"inserted": 0, "changed": 0, "pruned": 0}
        assert sync.store(worker, w.org, None, result(1200.0), existing)["changed"] == 1
        merged = sync.merge(sync.load_existing(worker), result(1200.0))
        records = sync.flat(merged)
        built = model.build(records, date(2026, 10, 10))
        counts = sync.store_desk(worker, sync.desk_rows(records, built))
        assert counts["sales_changed"] == 1 and counts["payroll_changed"] == 1
        assert sync.store_desk(worker, sync.desk_rows(records, built))["sales_same"] == 1
    data = call(api, w, "pulse.finance_desk_state(false)", viewer=w.editor, session=verified)
    payroll = [r["body"] for r in data["records"] if r["kind"] == "payroll"]
    assert payroll == [{"origin": "finance-live", "month": "2026-09", "name": "All staff (monthly total)", "kind": "monthly payout", "amount": 1200.0,
                        "currency": "INR", "components": "3 people", "basis": "Monthly cost sheet: people rows totalled"}]
