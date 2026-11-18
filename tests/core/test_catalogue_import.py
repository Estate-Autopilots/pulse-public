"""GROWTH-LOOP slice 5 (1896): importing a price list into Billing's catalogue. Import batches and their changes are the
company's own (forced row security, a tenant policy) and only Billing's full seat (leadership, Finance) writes or reads
them: a salesperson's seat, which writes only its own items, does not import. An item's category is part of its
version history like every other field. Synthetic tenants, people and items only."""
import psycopg
import pytest
from psycopg.types.json import Jsonb

from test_erp_invoice import as_, erp, one, person  # noqa: F401  (erp is a fixture)

TABLES = ["erp_import_batch", "erp_import_change"]


def test_tables_force_row_security_with_a_tenant_and_a_full_seat_policy(worker):
    rows = worker.execute("""select c.relname, c.relrowsecurity r, c.relforcerowsecurity f,
        exists(select 1 from pg_policy p where p.polrelid=c.oid and p.polname='tenant_isolation') t,
        exists(select 1 from pg_policy p where p.polrelid=c.oid and p.polname='erp_import_full_seat' and not p.polpermissive) seat
      from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='pulse' and c.relname = any(%s) order by 1""", (TABLES,)).fetchall()
    assert [(r["relname"], r["r"], r["f"], r["t"], r["seat"]) for r in rows] == [(t, True, True, True, True) for t in TABLES]


def test_finance_imports_a_salesperson_does_not(api, worker, erp):  # noqa: F811
    w = erp
    seller = person(worker, w, "Synthetic Seller", "sales")
    batch = one(api, w, w.finance, """insert into pulse.erp_import_batch(org_id,file_name,created_by,created_count)
        values(pulse.current_org(),'Synthetic price list.csv',pulse.current_viewer(),1) returning id""")["id"]
    item = one(api, w, w.finance, """insert into pulse.erp_item(org_id,kind,name,unit,price,gst_rate,category,status,source,created_by,updated_by)
        values(pulse.current_org(),'service','Synthetic reel edit','per video',450000,18,'Video','active',%s,pulse.current_viewer(),pulse.current_viewer()) returning id""",
        (Jsonb({"type": "import", "batch": str(batch)}),))["id"]
    one(api, w, w.finance, """insert into pulse.erp_import_change(org_id,batch_id,item_id,action,before,after)
        values(pulse.current_org(),%s,%s,'created',null,%s) returning id""", (batch, item, Jsonb({"name": "Synthetic reel edit"})))
    assert [r["file_name"] for r in as_(api, w, w.finance, "select file_name from pulse.erp_import_batch")] == ["Synthetic price list.csv"]
    # The salesperson sees no batch and cannot make one; a member cannot either.
    assert as_(api, w, seller, "select id from pulse.erp_import_batch") == []
    for who in (seller, w.member):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            as_(api, w, who, "insert into pulse.erp_import_batch(org_id,created_by) values(pulse.current_org(),pulse.current_viewer())")
    # Only the undo columns of a batch change; a change record is never rewritten.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.finance, "update pulse.erp_import_batch set created_count=99 where id=%s", (batch,))
    as_(api, w, w.finance, "update pulse.erp_import_batch set undone_at=now(), undone_by=pulse.current_viewer() where id=%s", (batch,))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.finance, "update pulse.erp_import_change set after='{}' where batch_id=%s", (batch,))
    # A change needs its before values exactly when it changed an item.
    with pytest.raises(psycopg.errors.CheckViolation):
        as_(api, w, w.finance, "insert into pulse.erp_import_change(org_id,batch_id,item_id,action,before,after) values(pulse.current_org(),%s,%s,'updated',null,'{}')", (batch, item))


def test_a_category_change_is_a_new_version(api, erp):  # noqa: F811
    w = erp
    item = one(api, w, w.finance, """insert into pulse.erp_item(org_id,kind,name,unit,price,gst_rate,status,created_by,updated_by)
        values(pulse.current_org(),'service','Synthetic site visit','per visit',250000,18,'active',pulse.current_viewer(),pulse.current_viewer()) returning id""")["id"]
    as_(api, w, w.finance, "update pulse.erp_item set category='Design' where id=%s", (item,))
    got = one(api, w, w.finance, "select version, category from pulse.erp_item where id=%s", (item,))
    assert (got["version"], got["category"]) == (2, "Design")
    snap = one(api, w, w.finance, "select snapshot from pulse.erp_item_version where item_id=%s and version=2", (item,))["snapshot"]
    assert snap["category"] == "Design"
    with pytest.raises(psycopg.errors.CheckViolation):
        as_(api, w, w.finance, "update pulse.erp_item set category=%s where id=%s", ("x" * 61, item))


def test_an_imported_stock_count_switches_tracking_on_and_undo_puts_it_back(api, erp):  # noqa: F811
    """WL-ONBOARD-FIX (17 Nov 2026): the price list's Stock column, as services/api/src/catalog-import.ts applies it for the
    Finance seat: tracking on, then the count set (one adjustment); its Undo sets the count back and tracking off again."""
    w = erp
    item = one(api, w, w.finance, """insert into pulse.erp_item(org_id,kind,name,unit,price,gst_rate,status,created_by,updated_by)
        values(pulse.current_org(),'product','TEST Synthetic battery','nos',3619038,5,'active',pulse.current_viewer(),pulse.current_viewer()) returning id""")["id"]
    assert one(api, w, w.finance, "select track_stock, pulse.erp_on_hand(id) n from pulse.erp_item where id=%s", (item,)) == {"track_stock": False, "n": 0}
    as_(api, w, w.finance, "update pulse.erp_settings set inventory_enabled=true")
    as_(api, w, w.finance, "update pulse.erp_item set track_stock = true where id = %s and not track_stock", (item,))
    as_(api, w, w.finance, "select pulse.erp_stock_set(%s, 12, null, 'Stock from the price list import (Synthetic.csv)')", (item,))
    got = one(api, w, w.finance, "select pulse.erp_on_hand(%s) n, (select count(*) from pulse.erp_stock_move where item_id=%s and kind='adjust') moves", (item, item))
    assert (int(got["n"]), got["moves"]) == (12, 1)
    # Undo: the count back to what it was, tracking off again.
    as_(api, w, w.finance, "select pulse.erp_stock_set(%s, 0, null, 'Price list import undone')", (item,))
    as_(api, w, w.finance, "update pulse.erp_item set track_stock = false, reorder_level = null where id = %s", (item,))
    assert one(api, w, w.finance, "select track_stock, pulse.erp_on_hand(id) n from pulse.erp_item where id=%s", (item,)) == {"track_stock": False, "n": 0}
