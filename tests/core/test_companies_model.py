"""COMPANIES-MODEL (2190): one model for companies, contacts and clients. A company is an organisation in the world with
its people and one main contact; a client is a relationship with a company or with one person; a company may link to
its own Pulse account. Existing clients become companies only on evidence, nothing existing changes count, the way
back restores what changed, and nobody outside real estate is offered real-estate words. Synthetic tenants only."""
import hashlib
import uuid

import psycopg
import pytest
from pulse_sdk.db import set_tenant
from helpers import build_world

RE_KEYS = {("client", "developer"), ("client", "channel_partner"), ("client", "agent"), ("contact", "developer"), ("contact", "channel_partner"), ("contact", "talent")}


def q(conn, w, sql, args=(), viewer=None):
    with conn.transaction():
        set_tenant(conn, w.org, viewer)
        return conn.execute(sql, args).fetchall()


def one(conn, w, sql, args=(), viewer=None):
    rows = q(conn, w, sql, args, viewer)
    return rows[0] if rows else None


def make_admin(worker, w, person):
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'admin','2020-01-01') on conflict do nothing", (w.org, person))


def offered(conn, w):
    return {(r["entity"], r["key"]) for r in q(conn, w, "select entity,key from pulse.record_type where archived_at is null")}


def test_tables_are_forced_with_the_tenant_policy(owner):
    rows = owner.execute("""select c.relname, c.relrowsecurity, c.relforcerowsecurity,
        exists(select 1 from pg_policy p where p.polrelid=c.oid and p.polname='tenant') tenant
        from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='pulse' and c.relname in ('company','company_model_log','company_model_undo')""").fetchall()
    assert len(rows) == 3
    for r in rows:
        assert r["relrowsecurity"] and r["relforcerowsecurity"] and r["tenant"], r
    grants = owner.execute("select has_table_privilege('pulse_api','pulse.company_model_log','select') a, has_table_privilege('pulse_api','pulse.company_model_undo','select') b").fetchone()
    assert grants == {"a": False, "b": False}, "the API never reads the migration's own records"


def test_a_company_is_its_own_companys_only(worker, owner, api):
    a, b = build_world(worker, owner, api), build_world(worker, owner, api)
    make_admin(worker, a, a.manager); make_admin(worker, b, b.manager)
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        with api.transaction():
            set_tenant(api, a.org, a.editor)                                # not an admin: the database refuses too
            api.execute("insert into pulse.company(org_id,name) values(%s,'Synthetic Not Admin')", (a.org,))
    with api.transaction():
        set_tenant(api, a.org, a.manager)
        cid = api.execute("insert into pulse.company(org_id,name,city) values(%s,'Synthetic Lotus Interiors','Pune') returning id", (a.org,)).fetchone()["id"]
    assert one(api, a, "select name from pulse.company where id=%s", (cid,), a.manager)["name"] == "Synthetic Lotus Interiors"
    assert q(api, b, "select id from pulse.company where id=%s", (cid,), b.manager) == [], "another company never sees it"
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        with api.transaction():
            set_tenant(api, b.org, b.manager)
            api.execute("insert into pulse.company(org_id,name) values(%s,'Synthetic Smuggled')", (a.org,))
    with api.transaction():
        set_tenant(api, b.org, b.manager)
        assert api.execute("update pulse.company set name='x' where id=%s", (cid,)).rowcount == 0
    # A client of b cannot point at a's company (the link carries the organisation).
    with pytest.raises(psycopg.errors.ForeignKeyViolation):
        with worker.transaction():
            set_tenant(worker, b.org)
            worker.execute("insert into pulse.client(org_id,display_name,company_id) values(%s,'Synthetic Cross',%s)", (b.org, cid))


def test_no_industry_means_plain_words(worker, owner, api):
    """A freelancer's or any new company with no industry is offered plain business words; a real-estate company gets
    its own; a company already working with real-estate types keeps them; a type a record arrives with still saves."""
    w = build_world(worker, owner, api)
    q(api, w, "select pulse.record_types_defaults()", viewer=w.manager)
    plain = offered(api, w)
    assert {("contact", "customer"), ("contact", "vendor"), ("contact", "partner"), ("client", "business"), ("client", "individual")} <= plain
    assert not (plain & RE_KEYS), plain & RE_KEYS
    # A Drive sync or an older script that gives a record a real-estate type still saves (the type comes on first use).
    with worker.transaction():
        set_tenant(worker, w.org)
        legacy = worker.execute("insert into pulse.client(org_id,display_name,client_type) values(%s,'Synthetic Northstar Developers','developer') returning id", (w.org,)).fetchone()["id"]
    assert ("client", "developer") in offered(api, w)
    assert one(api, w, "select client_type from pulse.client where id=%s", (legacy,))["client_type"] == "developer"
    # ... and a company with real-estate types on its records keeps them when the types are aligned again.
    q(owner, w, "select pulse.record_types_align()")
    assert ("client", "developer") in offered(api, w)

    re = build_world(worker, owner, api)
    with owner.transaction():
        set_tenant(owner, re.org)
        owner.execute("insert into pulse.org_pack(org_id,pack_key) values(%s,'real_estate_marketing') on conflict(org_id) do update set pack_key='real_estate_marketing'", (re.org,))
    q(api, re, "select pulse.record_types_defaults()", viewer=re.manager)
    assert RE_KEYS <= offered(api, re), "real estate gets its own words"


def _seed_clients(worker, w, owner=None):
    """A real-estate agency's and a home-goods seller's kinds of client, all synthetic."""
    ids = {}
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("select pulse.record_types_defaults()")
        for k, label in (("home_customer", "Home customer"), ("business_customer", "Business customer"), ("family_business", "Family business")):
            owner.execute("insert into pulse.record_type(org_id,entity,key,label) values(%s,'client',%s,%s) on conflict do nothing", (w.org, k, label))
    with worker.transaction():
        set_tenant(worker, w.org)
        rows = {
            "dev_a": ("Synthetic Skyline Project", "developer", "Synthetic Skyline Developers"),
            "dev_b": ("Synthetic Skyline Phase 2", "developer", "Synthetic Skyline Developers"),   # same company twice: one company
            "named": ("Synthetic Orbit Infra Pvt Ltd", "other", None),                             # a company's name
            "plain": ("Synthetic Meera", "other", None),                                           # no evidence: left alone
            "home": ("Synthetic Ravi Home", "home_customer", None),                                # one person
            "biz": ("Synthetic Acme Stores", "business_customer", None),                           # a type meaning a business
            "billed": ("Synthetic Kedab", "other", None),                                          # a GSTIN on a bill
            "own": ("Our own work", "internal", None),
            "na": ("Synthetic Asha", "other", "NA"),                                              # a placeholder company name
            "fam": ("Synthetic Rao Family", "family_business", None),                             # a label saying both: no evidence
        }
        for k, (name, typ, company) in rows.items():
            ids[k] = worker.execute("insert into pulse.client(org_id,display_name,client_type,company_name,city,created_at) values(%s,%s,%s,%s,'Pune',now()) returning id",
                                    (w.org, name, typ, company)).fetchone()["id"]
        # People: a contact at the developer (primary), a second one, and the plain client's own person.
        for k, name in (("p1", "Synthetic Adas Kalah"), ("p2", "Synthetic Sara Iyer"), ("p3", "Synthetic Meera")):
            ids[k] = worker.execute("insert into pulse.person(org_id,display_name,side) values(%s,%s,'client') returning id", (w.org, name)).fetchone()["id"]
            worker.execute("insert into pulse.contact_profile(org_id,person_id,contact_type) values(%s,%s,'customer')", (w.org, ids[k]))
        worker.execute("insert into pulse.client_contact(org_id,client_id,person_id,is_primary) values(%s,%s,%s,true),(%s,%s,%s,false),(%s,%s,%s,true)",
                       (w.org, ids["dev_a"], ids["p1"], w.org, ids["dev_a"], ids["p2"], w.org, ids["plain"], ids["p3"]))
        worker.execute("update pulse.client set primary_contact_id=%s where id=%s", (ids["p1"], ids["dev_a"]))
    return ids


def _undo_company_links(owner, w):
    """Put the world back as it was before 2190 (the migration ran before these rows existed)."""
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("update pulse.contact_profile set company_id=null where org_id=%s", (w.org,))
        owner.execute("update pulse.client set company_id=null where org_id=%s", (w.org,))
        owner.execute("delete from pulse.company where org_id=%s", (w.org,))


def test_existing_clients_become_companies_on_evidence_only(worker, owner, api):
    w = build_world(worker, owner, api)
    ids = _seed_clients(worker, w, owner)
    # The new-client trigger already did its part; replay the migration from a clean start, as on production.
    _undo_company_links(owner, w)
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("""insert into pulse.erp_document(org_id,doc_type,client_id,buyer) values(%s,'quotation',%s,'{"name":"Synthetic Kedab","gstin":"27AABCS5678K1ZS"}')""",
                      (w.org, ids["billed"]))
    before = one(owner, w, "select pulse.company_model_counts() c")["c"]
    r = one(owner, w, "select pulse.company_model_backfill() r")["r"]
    after = r["after"]
    for k in ("clients", "contacts", "clientContacts", "projects", "documents"):
        assert after[k] == before[k], k
    rows = {x["id"]: x for x in q(owner, w, "select c.id,c.company_id,c.entity_kind,co.name,co.primary_contact_id,co.gstin,co.city from pulse.client c left join pulse.company co on co.id=c.company_id")}
    assert rows[ids["dev_a"]]["company_id"] and rows[ids["dev_a"]]["company_id"] == rows[ids["dev_b"]]["company_id"], "same company name: one company"
    assert rows[ids["dev_a"]]["name"] == "Synthetic Skyline Developers" and rows[ids["dev_a"]]["city"] == "Pune"
    assert rows[ids["dev_a"]]["primary_contact_id"] == ids["p1"], "the client's primary contact is the company's main contact"
    assert rows[ids["named"]]["name"] == "Synthetic Orbit Infra Pvt Ltd"
    assert rows[ids["biz"]]["company_id"], "a type that means a business"
    assert rows[ids["billed"]]["company_id"] and rows[ids["billed"]]["gstin"] == "27AABCS5678K1ZS", "a GSTIN on a bill"
    assert rows[ids["plain"]]["company_id"] is None and rows[ids["plain"]]["entity_kind"] == "unknown", "no evidence: nothing guessed"
    assert rows[ids["home"]]["company_id"] is None and rows[ids["home"]]["entity_kind"] == "person", "a home customer is a person client"
    assert rows[ids["own"]]["company_id"] is None and rows[ids["own"]]["entity_kind"] == "unknown"
    assert rows[ids["na"]]["company_id"] is None, "a placeholder company name is no company"
    assert rows[ids["fam"]]["company_id"] is None and rows[ids["fam"]]["entity_kind"] == "unknown", "a label that says both is no evidence"
    at = {x["person_id"]: x["company_id"] for x in q(owner, w, "select person_id,company_id from pulse.contact_profile")}
    assert at[ids["p1"]] == at[ids["p2"]] == rows[ids["dev_a"]]["company_id"], "the client's people work at the company"
    assert at[ids["p3"]] is None
    assert r["companyClients"] == 5 and r["personClients"] == 1 and after["companies"] == 4
    assert after["unsortedClients"] == 3
    log = q(owner, w, "select before,after,made from pulse.company_model_log")
    assert len(log) == 1 and log[0]["after"]["companies"] == 4
    undo = q(owner, w, "select kind,ref,before from pulse.company_model_undo where kind='entity_kind'")
    assert undo == [{"kind": "entity_kind", "ref": str(ids["home"]), "before": "unknown"}]
    # Running it again makes nothing twice.
    again = one(owner, w, "select pulse.company_model_backfill() r")["r"]
    assert again["after"]["companies"] == 4 and again["companyClients"] == 0 and again["personClients"] == 0


def test_a_new_client_with_a_company_name_gets_its_company(worker, owner, api):
    w = build_world(worker, owner, api)
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("select pulse.record_types_defaults()")
        made = worker.execute("insert into pulse.client(org_id,display_name,client_type,company_name) values(%s,'Synthetic Brightline','business','Synthetic Brightline LLP') returning id", (w.org,)).fetchone()["id"]
        again = worker.execute("insert into pulse.client(org_id,display_name,client_type) values(%s,'Synthetic Brightline Two','other') returning id", (w.org,)).fetchone()["id"]
        worker.execute("update pulse.client set company_name='Synthetic Brightline LLP' where id=%s", (again,))
    c = {x["id"]: x["company_id"] for x in q(owner, w, "select id,company_id from pulse.client")}
    assert c[made] and c[made] == c[again], "found by name, not made twice"
    assert one(owner, w, "select count(*) n from pulse.company")["n"] == 1


def test_a_company_links_to_its_pulse_account_when_it_joins(worker, owner, api):
    a, b = build_world(worker, owner, api), build_world(worker, owner, api)
    make_admin(worker, a, a.editor)
    token = uuid.uuid4().hex + uuid.uuid4().hex
    digest = hashlib.sha256(token.encode()).hexdigest()
    with api.transaction():
        set_tenant(api, a.org, a.editor)
        inv = api.execute("select pulse.directory_invite_make(%s,%s,null,'general',null,%s) i", ("Synthetic Lotus Interiors", "owner@lotus.example", digest)).fetchone()["i"]
        cid = api.execute("insert into pulse.company(org_id,name,directory_invite_id) values(%s,'Synthetic Lotus Interiors',%s) returning id", (a.org, inv["id"])).fetchone()["id"]
        state = api.execute("select pulse.company_invite_state(%s) s", (inv["id"],)).fetchone()["s"]
    assert state["status"] == "pending" and "token" not in str(state)
    with api.transaction():
        set_tenant(api, b.org, b.manager)
        assert api.execute("select pulse.company_invite_state(%s) s", (inv["id"],)).fetchone()["s"] is None, "another company cannot read it"
        api.execute("select pulse.directory_invite_claim(%s)", (digest,))
    row = one(api, a, "select pulse_org_id from pulse.company where id=%s", (cid,), a.editor)
    assert row["pulse_org_id"] == b.org, "the record now points at the company's own Pulse account"
    card = one(api, a, "select pulse.company_pulse_card(%s) c", (b.org,), a.editor)["c"]
    assert card["id"] == str(b.org) and set(card) == {"id", "handle", "name"}


def test_the_book_through_the_api(worker, owner, api, tmp_path):
    """services/api/test/companies-runner.mjs against the built API: add contact -> make client -> company -> quote."""
    import json
    import os
    import subprocess
    from pathlib import Path
    from conftest import dsn
    from psycopg.conninfo import conninfo_to_dict
    w = build_world(worker, owner, api)
    roles = {r: uuid.uuid4() for r in ["person", "hr", "admin"]}
    with worker.transaction():
        set_tenant(worker, w.org)
        for role, pid in roles.items():
            worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,%s,'staff')", (pid, w.org, "Synthetic " + role))
            worker.execute("insert into pulse.people_profile(org_id,person_id,role,pod,evidence,username,email) values(%s,%s,%s,'Pod 1','{}',%s,%s)",
                           (w.org, pid, role, "synthetic.book." + role, role + "@delivery.example"))
            worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')", (w.org, role + "@book.example", pid))
            if role in ("hr", "admin"):
                worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,%s,'2020-01-01')", (w.org, pid, role))
    config = conninfo_to_dict(dsn("api")); config["database"] = config.pop("dbname")
    wc = conninfo_to_dict(dsn("migrate")); wc["database"] = wc.pop("dbname")
    env = {**os.environ, "TEST_API_CONFIG": json.dumps(config), "TEST_OWNER_CONFIG": json.dumps(wc), "PULSE_ORG_ID": str(w.org),
           "TEST_ROLES": json.dumps({r: str(p) for r, p in roles.items()}), "PULSE_CI": "1"}
    result = subprocess.run(["node", "test/companies-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api", env=env, text=True, capture_output=True, timeout=240)
    assert result.returncode == 0, result.stdout + "\n" + result.stderr
    assert json.loads(result.stdout.strip().splitlines()[-1])["checks"] >= 30


@pytest.mark.skipif(__import__("os").environ.get("PULSE_COMPANIES_BROWSER") != "1", reason="the browser walk runs with PULSE_COMPANIES_BROWSER=1")
def test_the_book_in_the_browser(worker, owner, api, tmp_path):
    """services/api/test/companies-browser-runner.mjs: a freelancer, a real-estate agency, an STP / ATP plants company and a
    sales team add a person at a new company whose company is a client, open the company, the clients and a quote."""
    import json
    import os
    import subprocess
    from pathlib import Path
    from conftest import dsn
    from psycopg.conninfo import conninfo_to_dict
    kinds = [("freelancer", None, "Studio", "Designer", False), ("agency", "real_estate_marketing", "Estates", "Architect", True),
             ("plants", "water_plants", "Aqua", "Consultant", False), ("sales", None, "Sales", "Distributor", False)]
    orgs, worlds = [], []
    for key, pack, word, new_type, real_estate in kinds:
        w = build_world(worker, owner, api)
        pid = uuid.uuid4()
        email = f"walker@{key}-{w.code.lower()}.example"
        with owner.transaction():
            set_tenant(owner, w.org)
            owner.execute("update pulse.org set name=%s where id=%s", (f"Synthetic {word} {key}", w.org))
        with worker.transaction():
            set_tenant(worker, w.org)
            worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,'Synthetic Walker','staff')", (pid, w.org))
            worker.execute("insert into pulse.people_profile(org_id,person_id,role,pod,evidence,username,email) values(%s,%s,'admin','Pod 1','{}',%s,%s)",
                           (w.org, pid, "synthetic.walker." + key, email))
            worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')", (w.org, email, pid))
            for role in ("admin", "leadership"):
                worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,%s,'2020-01-01')", (w.org, pid, role))
        if pack:
            with owner.transaction():
                set_tenant(owner, w.org)
                owner.execute("insert into pulse.org_pack(org_id,pack_key) values(%s,%s) on conflict(org_id) do update set pack_key=excluded.pack_key", (w.org, pack))
        if key == "sales":   # a sales team with its own contact type, as Atlas Crest has
            with owner.transaction():
                set_tenant(owner, w.org)
                owner.execute("select pulse.record_types_defaults()")
                owner.execute("insert into pulse.record_type(org_id,entity,key,label) values(%s,'contact','relationship_contact','Relationship contact') on conflict do nothing", (w.org,))
        orgs.append({"key": key, "email": email, "word": word, "newType": new_type, "realEstate": real_estate, "billing": key in ("freelancer", "agency")})
        worlds.append(w)
    config = conninfo_to_dict(dsn("api")); config["database"] = config.pop("dbname")
    failed = []
    # The API serves the install's company (pulse.install, read once per process): each company gets its own run.
    schema_owner = owner.execute("select pg_get_userbyid(nspowner) o from pg_namespace where nspname='pulse'").fetchone()["o"]
    for org, w in zip(orgs, worlds):
        if os.environ.get("PULSE_CM_ONLY") and org["key"] not in os.environ["PULSE_CM_ONLY"].split(","):
            continue
        with owner.transaction():
            owner.execute(f'set local role "{schema_owner}"')
            owner.execute("delete from pulse.install")
            owner.execute("insert into pulse.install(org_id,initialised_by) values(%s,'test:synthetic')", (w.org,))
        env = {**os.environ, "TEST_API_CONFIG": json.dumps(config), "TEST_ORGS": json.dumps([org]), "PULSE_CI": "1"}
        env.pop("PULSE_CM_ONLY", None)
        result = subprocess.run(["node", "test/companies-browser-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api", env=env, text=True, capture_output=True, timeout=2700)
        print(org["key"], result.returncode, result.stdout[-1500:])
        if result.returncode != 0:
            failed.append(org["key"] + ": " + result.stdout[-2500:] + "\n" + result.stderr[-2500:])
    assert not failed, "\n\n".join(failed)


def test_a_type_archived_for_the_industry_comes_back_with_a_record(worker, owner, api):
    """A company with no industry stops being offered Developer, but a Drive sync that brings a developer still saves."""
    w = build_world(worker, owner, api)
    with owner.transaction():
        set_tenant(owner, w.org)
        # As production has it: the old real-estate defaults (0213), untouched, no record using them.
        for e, k, l in (("client", "developer", "Developer"), ("client", "other", "Other"), ("contact", "developer", "Developer"), ("contact", "other", "Other")):
            owner.execute("insert into pulse.record_type(org_id,entity,key,label,system) values(%s,%s,%s,%s,%s) on conflict do nothing", (w.org, e, k, l, k == "other"))
        r = owner.execute("select pulse.company_model_backfill() r").fetchone()["r"]
    assert ("client", "developer") not in offered(api, w), r
    undo = {(x["kind"], x["ref"]) for x in q(owner, w, "select kind,ref from pulse.company_model_undo")}
    assert ("type_archived", "client:developer") in undo and ("type_added", "client:business") in undo
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.client(org_id,display_name,client_type) values(%s,'Synthetic Skyline','developer')", (w.org,))
    assert ("client", "developer") in offered(api, w), "the sync's record saved and the type is back"


def test_staff_is_never_a_companys_main_contact(worker, owner, api):
    w = build_world(worker, owner, api)
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("select pulse.record_types_defaults()")
        cl = worker.execute("insert into pulse.client(org_id,display_name,client_type,company_name,primary_contact_id) values(%s,'Synthetic Pine','business','Synthetic Pine LLP',%s) returning id",
                            (w.org, w.manager)).fetchone()["id"]
    row = one(owner, w, "select co.primary_contact_id from pulse.client c join pulse.company co on co.id=c.company_id where c.id=%s", (cl,))
    assert row["primary_contact_id"] is None, "a member of staff named on the client is not the company's contact"


def test_zz_the_way_back_and_forward_again(worker, owner, api):
    """2190's down step, then its up step again, in one transaction that is rolled back: clients, contacts and their links
    keep their counts, a person client is 'unknown' again after down, the types come back, and up makes the same
    companies again. Companies people added stop the down step; here they are removed first (inside the rollback)."""
    from pathlib import Path
    w = build_world(worker, owner, api)
    ids = _seed_clients(worker, w, owner)
    _undo_company_links(owner, w)
    sql = (Path(__file__).resolve().parents[2] / "db/migrations/2190_companies_model.sql").read_text()
    up, down = sql.split("-- migrate:down")
    up = up.replace("-- migrate:up", "")
    with owner.transaction() as tx:
        # As the migration runs: the schema owner (functions it makes are the owner's, as in production).
        schema_owner = owner.execute("select pg_get_userbyid(nspowner) o from pg_namespace where nspname='pulse'").fetchone()["o"]
        owner.execute(f'set local role "{schema_owner}"')
        set_tenant(owner, w.org)
        owner.execute("select pulse.company_model_backfill()")
        made_first = owner.execute("select count(*) n from pulse.company").fetchone()["n"]
        before = owner.execute("select (select count(*) from pulse.client) c, (select count(*) from pulse.contact_profile) p, (select count(*) from pulse.client_contact) cc").fetchone()
        assert owner.execute("select entity_kind from pulse.client where id=%s", (ids["home"],)).fetchone()["entity_kind"] == "person"
        # A company someone added stops the way back.
        owner.execute("insert into pulse.company(org_id,name,source) values(%s,'Synthetic Hand Made','manual')", (w.org,))
        owner.execute("savepoint s")
        with pytest.raises(psycopg.errors.RaiseException):
            owner.execute(down)
        owner.execute("rollback to savepoint s")
        orgs = [r["id"] for r in owner.execute("select id from pulse.org").fetchall()]
        for o in orgs:
            set_tenant(owner, o)
            owner.execute("delete from pulse.company where source <> 'client' or updated_at > coalesce((select max(at) from pulse.company_model_log where org_id=%s), '-infinity')", (o,))
        owner.execute(down)
        set_tenant(owner, w.org)
        after = owner.execute("select (select count(*) from pulse.client) c, (select count(*) from pulse.contact_profile) p, (select count(*) from pulse.client_contact) cc").fetchone()
        assert after == before, (before, after)
        assert owner.execute("select entity_kind from pulse.client where id=%s", (ids["home"],)).fetchone()["entity_kind"] == "unknown"
        assert owner.execute("select to_regclass('pulse.company') t").fetchone()["t"] is None
        # Down dropped client.company_id and contact_profile.company_id and up adds them again, all in this one
        # transaction, after their triggers already ran in it (the backfill, down's own updates). PL/pgSQL keeps a
        # trigger's simple expressions for the whole transaction, so merge_redirect's jsonb_populate_record(new, j)
        # still holds client's row shape from before the drop, and PostgreSQL 17.12 refuses it ("using outdated tuple
        # descriptor when deforming row type"; 17.11 read the row with the old shape without a word). In production down
        # and up are separate migrations in separate transactions, which start fresh. Here the rehearsal recompiles
        # those triggers' functions unchanged (CREATE OR REPLACE with their own definition) before up.
        for f in owner.execute(
            "select distinct t.tgfoid::regprocedure::text f from pg_trigger t join pg_proc p on p.oid = t.tgfoid"
            " join pg_language l on l.oid = p.prolang"
            " where t.tgrelid in ('pulse.client'::regclass, 'pulse.contact_profile'::regclass) and not t.tgisinternal"
            " and l.lanname = 'plpgsql' order by 1").fetchall():
            owner.execute(owner.execute("select pg_get_functiondef(%s::regprocedure) d", (f["f"],)).fetchone()["d"])
        owner.execute(up)
        set_tenant(owner, w.org)
        again = owner.execute("select count(*) n from pulse.company").fetchone()["n"]
        assert again == made_first == 3, (made_first, again)
        raise psycopg.Rollback(tx)   # nothing of the rehearsal stays
