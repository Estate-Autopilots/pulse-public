"""R55 money on the map and the geocode review queue, in the database. Invoice parties link to clients only on clear
evidence (decisions kept); money by place is for leadership with finance grants (audited); places their own evidence
contradicts become suggestions only an individual admin decides, and accepting moves pins with their history.
Synthetic tenants, names, places and figures only."""
import uuid

import psycopg
import pytest
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from test_tasks_rt1 import as_, one, team  # noqa: F401  (team is a fixture)

H = "a" * 64


def money_world(worker, w):
    """Three clients and their projects (one on the map), five invoices from four parties, FIN-LIVE's collections."""
    ids = {k: uuid.uuid4() for k in ("north", "lake", "lake_old", "river", "hill", "hillp", "loc", "locality")}
    with worker.transaction():
        set_tenant(worker, w.org)
        no = worker.execute("select coalesce(max(registry_no),0)+1 n from pulse.project").fetchone()["n"]
        for key, name in (("north", "Northstar Homes"), ("river", "Mr. Ravi Kale"), ("hill", "Mr. Hari Putig")):
            worker.execute("insert into pulse.client(id,org_id,display_name) values(%s,%s,%s)", (ids[key], w.org, name))
        for i, (key, client, name, title, month) in enumerate((
                ("lake", "north", "#3 - Lakeview | Northstar | Riverside | Aug 2026 | R", "Lakeview", "2026-08-01"),
                ("lake_old", "north", "#9 - Lakeview | Riverside | Jan 2025 | R", "Lakeview", "2025-01-01"),
                ("hillp", "hill", "#4 - Hillcrest | Mr. Hari Putig | Hill Road | Jul 2026 | P", "Hillcrest", "2026-07-01"))):
            worker.execute("insert into pulse.project(id,org_id,registry_no,name,title,client_id,start_month,location) values(%s,%s,%s,%s,%s,%s,%s,'Riverside')",
                           (ids[key], w.org, no + i, name, title, ids[client], month))
        worker.execute("insert into pulse.locality(id,org_id,name,city,lat,lng,precision) values(%s,%s,'Riverside','Pune',18.60,73.80,'locality')", (ids["locality"], w.org))
        worker.execute("insert into pulse.project_location(id,org_id,geo_key,name,locality,city,lat,lng,precision) values(%s,%s,'lakeview','Lakeview','Riverside','Pune',18.60,73.80,'locality')",
                       (ids["loc"], w.org))
        worker.execute("insert into pulse.project_location_member(org_id,project_id,location_id) values(%s,%s,%s)", (w.org, ids["lake"], ids["loc"]))
        invoices = [("INV-1", "Northstar Homes", "2026-09-10", 100000, "unpaid", 40), ("INV-2", "Northstar Homes LLP", "2026-09-25", 50000, "unconfirmed", 0),
                    ("INV-3", "Kalebridge Constructions LLP", "2026-09-12", 70000, "paid", 0), ("INV-4", "Putig Lakeview Ventures", "2026-08-01", 30000, "unconfirmed", 0),
                    ("INV-5", "Unknown Buyer", "2026-07-01", 20000, "unconfirmed", 0)]
        for number, client, day, taxable, status, overdue in invoices:
            worker.execute("insert into pulse_priv.finance_live_record(org_id,kind,key,scope,body,source,hash,confidence) values(%s,'invoice',%s,'zoho',%s,%s,%s,'high')",
                           (w.org, number, Jsonb({"number": number, "client": client, "date": day, "taxable": taxable}), Jsonb({"type": "mail"}), H))
        worker.execute("insert into pulse_priv.finance_live_model(org_id,body) values(%s,%s)", (w.org, Jsonb({
            "asOf": "2026-10-11", "collections": {"evidenceEnd": "2026-09-30", "invoices": [
                {"number": n, "client": c, "date": d, "due": d, "taxable": t, "total": t, "status": s, "overdueDays": o, "paidBasis": "synthetic"} for n, c, d, t, s, o in invoices]},
            "activeClients": {"names": ["Lakeview", "Nowhere Towers"]}})))
        # A shoot sheet writes the developer beside the project: "Hillcrest | Kalebridge Constructions".
        worker.execute("""insert into pulse.talent_shoot(org_id,source_key,alias,month,client_label,project_id,project_basis,project_confidence,place_basis,sources,source)
                          values(%s,'sd:synthetic:1','asha','2026-07-01','Hillcrest | Kalebridge Constructions',%s,'client_name',0.9,'none','{shoot_sheet}','{"type":"sheet"}')""", (w.org, ids["hillp"]))
    return ids


def leader(worker, w):
    pid = uuid.uuid4()
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,'Founder','staff')", (pid, w.org))
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'leadership','2026-01-01')", (w.org, pid))
    return pid


def test_invoice_parties_link_on_evidence_and_money_is_on_the_map_for_finance_only(api, worker, team):
    w = team
    ids = money_world(worker, w)
    with worker.transaction():
        set_tenant(worker, w.org)
        assert worker.execute("select pulse.money_party_refresh() n").fetchone()["n"] == 4
        parties = {r["party_key"]: r for r in worker.execute("select party_key,party,client_id,project_id,basis,status from pulse_priv.money_party").fetchall()}
    # The client's own name (both spellings are one party); the developer the shoot sheet writes beside a project; a name
    # whose words no single client's projects hold; a stranger.
    assert parties["northstar"]["client_id"] == ids["north"] and parties["northstar"]["basis"] == "exact"
    assert parties["kalebridge"]["client_id"] == ids["hill"] and parties["kalebridge"]["basis"] == "words"
    assert parties["putig lakeview"]["status"] == "none"
    assert parties["unknown buyer"]["status"] == "none" and parties["unknown buyer"]["client_id"] is None
    founder = leader(worker, w)
    for who in (w.editor, w.manager):     # a member, and an admin without finance grants
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            as_(api, w, who, "select pulse.money_map()")
    m = one(api, w, founder, "select pulse.money_map() m")["m"]
    by = {i["number"]: i for i in m["invoices"]}
    # The invoice goes to the engagement that had started by its month, so its place is the August project's.
    assert by["INV-1"]["projectId"] == str(ids["lake"]) and by["INV-1"]["locationId"] == str(ids["loc"]) and by["INV-1"]["overdueDays"] == 40
    assert by["INV-3"]["projectId"] == str(ids["hillp"]) and by["INV-3"]["locationId"] is None     # its project has no place yet
    assert by["INV-5"]["clientId"] is None
    assert {a["name"]: a["locationId"] for a in m["active"]} == {"Lakeview": str(ids["loc"]), "Nowhere Towers": None}
    assert m["evidenceEnd"] == "2026-09-30"
    assert m["packages"] == []
    # A package value leadership records on a project shows with the project's place.
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse_priv.client_project_value(org_id,project_id,amount) values(%s,%s,150000)", (w.org, ids["lake"]))
    packages = one(api, w, founder, "select pulse.money_map() m")["m"]["packages"]
    assert [(p["projectId"], p["locationId"], float(p["amount"])) for p in packages] == [(str(ids["lake"]), str(ids["loc"]), 150000.0)]
    with worker.transaction():
        set_tenant(worker, w.org)
        assert worker.execute("select count(*) n from pulse.audit_event where resource='finance.map'").fetchone()["n"] >= 1
    # Leadership links the stranger; the decision survives the next refresh.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor, "select pulse.money_party_decide('unknown buyer',%s)", (ids["river"],))
    as_(api, w, founder, "select pulse.money_party_decide('unknown buyer',%s)", (ids["river"],))
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("select pulse.money_party_refresh()")
        row = worker.execute("select client_id,status,basis,decided_by from pulse_priv.money_party where party_key='unknown buyer'").fetchone()
    assert row == {"client_id": ids["river"], "status": "confirmed", "basis": "manual", "decided_by": founder}
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        as_(api, w, founder, "select pulse.money_party_decide('unknown buyer',%s,%s)", (ids["river"], ids["lake"]))   # not the client's project


def test_places_their_evidence_contradicts_wait_for_an_admin_and_move_with_history(api, worker, team):
    w = team
    pune, near, far, loc_a, loc_b, project = (uuid.uuid4() for _ in range(6))
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.locality(id,org_id,name,city,lat,lng,precision,source) values(%s,%s,'','Pune',18.52,73.85,'city','test')", (pune, w.org))
        worker.execute("insert into pulse.locality(id,org_id,name,city,lat,lng,precision,source) values(%s,%s,'Riverside','Pune',18.60,73.80,'locality','test')", (near, w.org))
        # A same-named village 58 km away: every project of this micro-market sits there.
        worker.execute("insert into pulse.locality(id,org_id,name,city,lat,lng,precision,source) values(%s,%s,'Hillside','Pune',19.03,73.95,'locality','nominatim:https://www.openstreetmap.org/relation/1')", (far, w.org))
        for lid, name in ((loc_a, "Hill A"), (loc_b, "Hill B")):
            worker.execute("insert into pulse.project_location(id,org_id,geo_key,name,locality,city,lat,lng,precision) values(%s,%s,%s,%s,'Hillside','Pune',19.03,73.95,'locality')", (lid, w.org, name, name))
        # A project whose folder says Riverside but is pinned in Hillside.
        no = worker.execute("select coalesce(max(registry_no),0)+1 n from pulse.project").fetchone()["n"]
        worker.execute("insert into pulse.project(id,org_id,registry_no,name,title,location) values(%s,%s,%s,'#1 - Lakeview | Riverside','Lakeview','Riverside')", (project, w.org, no))
        worker.execute("insert into pulse.project_location_member(org_id,project_id,location_id) values(%s,%s,%s)", (w.org, project, loc_a))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor, "select pulse.geo_review_scan()")
    assert one(api, w, w.manager, "select pulse.geo_review_scan() n")["n"] == 2
    items = {r["proposed"]["rule"]: r for r in as_(api, w, w.manager, "select id,entity_type,entity_id,proposed,title from pulse.review_item where kind='geocode' and status='pending'")}
    centre, folder = items["locality_centre"], items["folder_place"]
    assert centre["entity_id"] == far and centre["proposed"]["projects"] == 2 and centre["proposed"]["lat"] is None     # both projects sit at it
    assert folder["entity_id"] == loc_a and folder["proposed"]["place"] == "Riverside, Pune" and "the folder says Riverside" in folder["title"]
    # Only an individual admin decides; accepting the folder rule moves the pin to Riverside's centre, with history.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.lead, "select pulse.geo_review_decide(%s,true)", (folder["id"],))
    assert one(api, w, w.manager, "select pulse.geo_review_decide(%s,true) n", (folder["id"],))["n"] == 1
    moved = one(api, w, w.manager, "select lat,lng,precision,pinned_by from pulse.project_location where id=%s", (loc_a,))
    assert (moved["lat"], moved["lng"], moved["precision"], moved["pinned_by"]) == (18.6, 73.8, "locality", w.manager)
    hist = one(api, w, w.manager, "select old_lat,new_lat,changed_by,note from pulse.project_location_change where location_id=%s", (loc_a,))
    assert hist["old_lat"] == 19.03 and hist["new_lat"] == 18.6 and hist["changed_by"] == w.manager and hist["note"].startswith("Review data:")
    # The micro-market centre needs a point: without one it is refused; with one, it moves with the project left there.
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        as_(api, w, w.manager, "select pulse.geo_review_decide(%s,true)", (centre["id"],))
    assert one(api, w, w.manager, "select pulse.geo_review_decide(%s,true,18.45,73.86) n", (centre["id"],))["n"] == 1
    assert one(api, w, w.manager, "select lat,lng,source from pulse.locality where id=%s", (far,)) == {"lat": 18.45, "lng": 73.86, "source": "pulse_review:centre of Hillside placed by a person"}
    assert one(api, w, w.manager, "select lat from pulse.project_location where id=%s", (loc_b,))["lat"] == 18.45
    # Fixed places are not proposed again.
    assert one(api, w, w.manager, "select pulse.geo_review_scan() n")["n"] == 0
    assert one(api, w, w.manager, "select count(*) n from pulse.review_item where kind='geocode' and status='pending'")["n"] == 0
