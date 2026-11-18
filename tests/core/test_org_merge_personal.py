"""PERSONAL-MERGE (2181): an organisation one person made for themselves is merged into that person's personal space.

pulse.org_merge_into_personal moves every row (ids kept), rewrites the person's old seat to their personal seat and the
old organisation's id to the personal space's, keeps the rows the personal space already has its own copy of with the
old organisation, carries module switches (Focus), writes one audit note per moved kind of record, archives the emptied
organisation (out of every switcher; old links say where it went) and can be put back with pulse.org_merge_undo.
Real companies (other people, clients, other staff) are refused. Synthetic organisations and people only.

SAKOBE-MERGE (2182): a freelancer's own organisation has clients of its own. Only with p_with_clients (the owner's word,
the tool's --with-clients) are they merged too, with everything that points at them; every other refusal stays."""
import uuid

import psycopg
import pytest
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from helpers import build_world, new_code
from test_my_day import _account
from test_tasks_rt1 import one

WHO, WORDS = "Synthetic Owner (owner)", "synthetic words: merge my own space"
UNFORCED = """select count(*) n from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname in ('pulse','pulse_priv','privacy','memory') and c.relrowsecurity and not c.relforcerowsecurity
          and exists (select 1 from pg_attribute a where a.attrelid=c.oid and a.attname='org_id')"""


def _solo(worker, owner):
    """A one-person company: its founder (admin), a contact, a project, two tasks, a goal-like record, Focus switched on."""
    org, me, contact, project = uuid.uuid4(), uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    code = new_code()
    with worker.transaction():
        set_tenant(worker, org)
        worker.execute("insert into pulse.org(id,slug,name,code,handle) values(%s,%s,'Synthetic Solo HQ',%s,%s)", (org, f"solo-{org}", code, f"solo{code.lower()}"))
        worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,'Synthetic Founder','staff')", (me, org))
        worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,'Synthetic Contact','other')", (contact, org))
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'admin','2020-01-01')", (org, me))
        worker.execute("insert into pulse.project(id,org_id,registry_no,name,lead_person_id) values(%s,%s,7,'Synthetic plan',%s)", (project, org, me))
        for n in range(2):
            worker.execute("""insert into pulse.task(org_id,source_key,title,status,source,project_id,assignee_person_id,owner_id)
                              values(%s,%s,%s,'open','pulse',%s,%s,%s)""", (org, f"solo-{n}", f"Synthetic step {n} for {me}", project, me, me))
        worker.execute("insert into pulse.tenant_config(org_id,doc_kind,doc_key,version,body,is_active) values(%s,'tenant','modules',1,%s,true)",
                       (org, Jsonb({"on": ["focus"], "off": []})))
    with owner.transaction():
        set_tenant(owner, org)
        owner.execute("insert into pulse.org_module(org_id,module,enabled) values(%s,'chats',true) on conflict (org_id,module) do update set enabled=true", (org,))
        owner.execute("insert into pulse.focus_settings(org_id) values(%s) on conflict do nothing", (org,))
    account = _account(owner, (org, me))
    return type("Solo", (), {"org": org, "me": me, "contact": contact, "project": project, "account": account, "handle": f"solo{code.lower()}"})()


def _merge(owner, org, account, with_clients=None):
    with owner.transaction():
        if with_clients is None:
            return owner.execute("select pulse.org_merge_into_personal(%s,%s,%s,%s) r", (org, account, WHO, WORDS)).fetchone()["r"]
        return owner.execute("select pulse.org_merge_into_personal(%s,%s,%s,%s,%s) r", (org, account, WHO, WORDS, with_clients)).fetchone()["r"]


def _as(conn, org, who, sql, args=()):
    with conn.transaction():
        set_tenant(conn, org, who)
        return conn.execute(sql, args).fetchall()


def test_new_table_keeps_tenant_rules(worker):
    r = worker.execute("select relrowsecurity r, relforcerowsecurity f from pg_class where oid='pulse_priv.org_merge'::regclass").fetchone()
    assert (r["r"], r["f"]) == (True, True)
    grants = worker.execute("select count(*) n from information_schema.role_table_grants where table_schema='pulse_priv' and table_name='org_merge' and grantee in ('pulse_api','pulse_worker')").fetchone()["n"]
    assert grants == 0


def test_a_one_person_company_moves_into_the_personal_space_whole(owner, worker, api):
    s = _solo(worker, owner)
    other = build_world(worker, owner, api)
    with owner.transaction():
        set_tenant(owner, other.org)
        other_tasks = owner.execute("select count(*) n from pulse.task where org_id=%s", (other.org,)).fetchone()["n"]
    unforced = worker.execute(UNFORCED).fetchone()["n"]
    r = _merge(owner, s.org, s.account)
    mine, me2 = r["to"], r["toPerson"]
    assert r["from"] == str(s.org) and r["fromPerson"] == str(s.me)
    assert r["moved"]["pulse.task"] == 2 and r["moved"]["pulse.project"] == 1
    assert r["kept"]["pulse.person"] == 1, "the founder's old seat stays; their personal seat takes its place"
    # Everything is in the personal space with the same ids, and points at the personal seat.
    tasks = _as(api, mine, me2, "select title, assignee_person_id a, owner_id o, project_id p from pulse.task order by title")
    assert [(t["a"], t["o"], t["p"]) for t in tasks] == [(uuid.UUID(me2), uuid.UUID(me2), s.project)] * 2
    assert all(str(s.me) not in t["title"] and me2 in t["title"] for t in tasks), "ids in text are rewritten too"
    assert _as(api, mine, me2, "select lead_person_id l from pulse.project where id=%s", (s.project,))[0]["l"] == uuid.UUID(me2)
    assert _as(api, mine, me2, "select display_name from pulse.person where id=%s", (s.contact,))[0]["display_name"] == "Synthetic Contact"
    # Focus (switched on there) is on in the personal space, and so is whatever module was on.
    # From another company of the person, Focus opens on the personal space (account_module_home skips the current one).
    with owner.transaction():
        owner.execute("insert into pulse_priv.account_member(account_id,member_org,person_id,kind) values(%s,%s,%s,'staff')", (s.account, other.org, other.editor))
    assert one(api, other, other.editor, "select pulse.account_module_home('focus') h")["h"]["id"] == mine
    with owner.transaction():
        set_tenant(owner, mine)
        assert owner.execute("select enabled from pulse.org_module where org_id=%s and module='chats'", (mine,)).fetchone()["enabled"] is True
        notes = owner.execute("select resource, (changes->>'rows')::int n from pulse.audit_event where org_id=%s and action='org_merge.moved'", (mine,)).fetchall()
        assert {x["resource"]: x["n"] for x in notes}["pulse.task"] == 2, "one audit note per kind of record"
        set_tenant(owner, s.org)
        o = owner.execute("select status, merged_into from pulse.org where id=%s", (s.org,)).fetchone()
        assert owner.execute("select count(*) n from pulse.task where org_id=%s", (s.org,)).fetchone()["n"] == 0
        set_tenant(owner, other.org)
        assert owner.execute("select count(*) n from pulse.task where org_id=%s", (other.org,)).fetchone()["n"] == other_tasks
    assert (o["status"], o["merged_into"]) == ("archived", uuid.UUID(mine))
    # Row security is back on every table, as it was before.
    assert worker.execute(UNFORCED).fetchone()["n"] == unforced
    # The switcher no longer lists it; an old link says where it went; other companies' people see none of it.
    me = _as(api, mine, me2, "select pulse.account_me() a")[0]["a"]
    assert str(s.org) not in [x["id"] for x in me["orgs"]] and mine in [x["id"] for x in me["orgs"]]
    for ref in (s.handle, str(s.org)):
        assert _as(api, mine, me2, "select pulse.account_org_redirect(%s) r", (ref,))[0]["r"]["org"] == mine
    assert _as(api, other.org, other.lead, "select pulse.account_org_redirect(%s) r", (s.handle,))[0]["r"] is None
    assert _as(api, other.org, other.lead, "select count(*) n from pulse.task where title like 'Synthetic step%%'")[0]["n"] == 0


def test_undo_puts_it_back(owner, worker, api):
    s = _solo(worker, owner)
    r = _merge(owner, s.org, s.account)
    with owner.transaction():
        back = owner.execute("select pulse.org_merge_undo(%s,%s,%s) r", (r["merge"], WHO, "synthetic words: put it back")).fetchone()["r"]
    assert back["back"]["pulse.task"] == 2
    with owner.transaction():
        set_tenant(owner, s.org)
        o = owner.execute("select status, merged_into from pulse.org where id=%s", (s.org,)).fetchone()
        rows = owner.execute("select assignee_person_id a, title from pulse.task where org_id=%s", (s.org,)).fetchall()
    assert (o["status"], o["merged_into"]) == ("active", None)
    assert [x["a"] for x in rows] == [s.me, s.me] and all(str(s.me) in x["title"] for x in rows)
    with owner.transaction(), pytest.raises(psycopg.errors.InvalidParameterValue):
        owner.execute("select pulse.org_merge_undo(%s,%s,%s)", (r["merge"], WHO, "synthetic words: again"))


def test_real_companies_and_strangers_are_refused(owner, worker, api):
    w = build_world(worker, owner, api)   # four staff: a company
    account = _account(owner, (w.org, w.editor))
    with owner.transaction(), pytest.raises(psycopg.errors.InsufficientPrivilege):
        owner.execute("select pulse.org_merge_into_personal(%s,%s,%s,%s)", (w.org, account, WHO, WORDS))
    s = _solo(worker, owner)
    stranger = _account(owner, (w.org, w.lead))
    with owner.transaction(), pytest.raises(psycopg.errors.InsufficientPrivilege):
        owner.execute("select pulse.org_merge_into_personal(%s,%s,%s,%s)", (s.org, stranger, WHO, WORDS))
    with owner.transaction(), pytest.raises(psycopg.errors.InvalidParameterValue):
        owner.execute("select pulse.org_merge_into_personal(%s,%s,%s,%s)", (s.org, s.account, WHO, ""))
    # Nobody but the platform's tools may run it.
    with api.transaction(), pytest.raises(psycopg.errors.InsufficientPrivilege):
        set_tenant(api, s.org, s.me)
        api.execute("select pulse.org_merge_into_personal(%s,%s,%s,%s)", (s.org, s.account, WHO, WORDS))


def _tool(*argv, hosts=None, words=WORDS):
    import os, socket, subprocess, sys
    from pathlib import Path
    tool = Path(__file__).resolve().parents[2] / "tools/admin/org-merge-personal.py"
    env = {**os.environ, "PULSE_ADMIN_TOOL_HOSTS": hosts if hosts is not None else socket.gethostname()}
    return subprocess.run([sys.executable, str(tool), "--database", os.environ["PULSE_CI_DATABASE_URL"], "--approver", WHO, "--words", words, *argv],
                          capture_output=True, text=True, check=False, timeout=300, env=env)


def test_the_admin_tool_dry_runs_then_applies_and_refuses_elsewhere(owner, worker):
    from pathlib import Path
    s = _solo(worker, owner)
    with owner.transaction():
        handle = owner.execute("select handle from pulse_priv.pulse_account where id=%s", (s.account,)).fetchone()["handle"]
    assert _tool("--org", s.handle, "--account", handle, hosts="not-this-host").returncode == 2
    assert _tool("--org", s.handle, "--account", handle, words="").returncode == 2
    dry = _tool("--org", s.handle, "--account", handle)
    assert dry.returncode == 0 and "DRY RUN" in dry.stdout, dry.stderr
    with owner.transaction():
        set_tenant(owner, s.org)
        assert owner.execute("select status from pulse.org where id=%s", (s.org,)).fetchone()["status"] == "active"
    done = _tool("--org", s.handle, "--account", handle, "--apply")
    assert done.returncode == 0 and "APPLIED" in done.stdout, done.stderr
    with owner.transaction():
        set_tenant(owner, s.org)
        assert owner.execute("select status from pulse.org where id=%s", (s.org,)).fetchone()["status"] == "archived"
    # There is no web route for it: the API never calls the merge or its undo.
    src = "\n".join(p.read_text() for p in (Path(__file__).resolve().parents[2] / "services/api/src").rglob("*.ts"))
    assert "org_merge_into_personal" not in src and "org_merge_undo" not in src


# ------------------------------------------------------------------------------------------- SAKOBE-MERGE (2182)
SELLER = {"legalName": "Synthetic Freelance Studio", "gstin": "27AAXFV2138F1ZR", "stateCode": "27", "address": ["1 Test Road, Pune"]}
BUYER = {"name": "Synthetic Freelance Client", "stateCode": "27", "address": ["2 Test Lane, Pune"]}
CLIENT_SIDE = ("pulse.client", "pulse.client_contact", "pulse.project", "pulse.erp_document", "pulse.erp_line", "pulse.erp_series", "pulse.fin_entry")


def _doc(conn, org, kind, client, project, me, n=0):
    did = conn.execute("""insert into pulse.erp_document(org_id,doc_type,issue_date,seller,buyer,place_of_supply,tax_mode,taxable,cgst,sgst,igst,total,project_id,client_id,created_by)
        values(%s,%s,current_date - 1,%s,%s,'27','intra',100000,9000,9000,0,118000,%s,%s,%s) returning id""",
                       (org, kind, Jsonb(SELLER), Jsonb(BUYER), project, client, me)).fetchone()["id"]
    conn.execute("""insert into pulse.erp_line(org_id,document_id,position,description,qty,rate,gst_rate,taxable,cgst,sgst,igst,total)
        values(%s,%s,0,%s,1,100000,18,100000,9000,9000,0,118000)""", (org, did, f"Synthetic design work {n}"))
    return did


def _freelancer(worker, owner, api):
    """A freelancer's own company (_solo) with a client of theirs: the client's contact, a client project, a quotation and
    an issued invoice for it, and the payment received."""
    s = _solo(worker, owner)
    s.client, s.client_person, s.client_project = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    with owner.transaction():
        set_tenant(owner, s.org)
        owner.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'finance','2020-01-01')", (s.org, s.me))
        owner.execute("insert into pulse.client(id,org_id,display_name,relationship_owner_id) values(%s,%s,'Synthetic Freelance Client',%s)", (s.client, s.org, s.me))
        owner.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,'Synthetic Client Contact','client')", (s.client_person, s.org))
        owner.execute("insert into pulse.client_contact(org_id,client_id,person_id,is_primary) values(%s,%s,%s,true)", (s.org, s.client, s.client_person))
        owner.execute("insert into pulse.project(id,org_id,registry_no,name,lead_person_id,client_id) values(%s,%s,8,'Synthetic client site',%s,%s)",
                      (s.client_project, s.org, s.me, s.client))
    with api.transaction():
        set_tenant(api, s.org, s.me)
        s.quote = _doc(api, s.org, "quotation", s.client, s.client_project, s.me, 0)
        s.invoice = _doc(api, s.org, "invoice", s.client, s.client_project, s.me, 1)
        api.execute("select pulse.erp_document_issue(%s)", (s.invoice,))
        s.number = api.execute("select number from pulse.erp_document where id=%s", (s.invoice,)).fetchone()["number"]
        s.payment = api.execute("""insert into pulse.fin_entry(org_id,kind,direction,entry_date,amount_minor,gst_minor,category,client_id,created_by)
            values(%s,'income','in',current_date - 1,118000,18000,'Design',%s,%s) returning id""", (s.org, s.client, s.me)).fetchone()["id"]
    assert s.number, "the invoice was issued under a number"
    return s


def _rows(owner, org, who, tables=CLIENT_SIDE):
    """Rows of each table in one organisation, read there as a person who may see billing."""
    with owner.transaction():
        set_tenant(owner, org, who)
        return {t: owner.execute(f"select count(*) n from {t} where org_id=%s", (org,)).fetchone()["n"] for t in tables}


def test_a_freelancers_clients_move_only_on_the_owners_word(owner, worker, api):
    f = _freelancer(worker, owner, api)
    other = build_world(worker, owner, api)
    with owner.transaction():
        set_tenant(owner, other.org)
        owner.execute("insert into pulse.client(org_id,display_name) values(%s,'Synthetic Other Client')", (other.org,))
    before, other_before = _rows(owner, f.org, f.me), _rows(owner, other.org, other.lead)
    assert before == {"pulse.client": 1, "pulse.client_contact": 1, "pulse.project": 2, "pulse.erp_document": 2, "pulse.erp_line": 2,
                      "pulse.erp_series": 1, "pulse.fin_entry": 1}
    # Without the owner's word an organisation with a client is a company: refused, nothing moves, no personal space.
    for flag in (None, False):
        with pytest.raises(psycopg.errors.InsufficientPrivilege, match="has clients"):
            _merge(owner, f.org, f.account, flag)
    assert _rows(owner, f.org, f.me) == before
    with owner.transaction():
        assert owner.execute("select count(*) n from pulse.org where personal_account=%s", (f.account,)).fetchone()["n"] == 0

    # With it: the client and everything pointing at it move, ids kept, and the person's old seat becomes the personal one.
    r = _merge(owner, f.org, f.account, True)
    mine, me2 = r["to"], uuid.UUID(r["toPerson"])
    assert r["withClients"] is True
    assert {t: r["moved"].get(t) for t in CLIENT_SIDE} == before
    assert not set(CLIENT_SIDE) & set(r["kept"]), "nothing of a client stays with the old organisation"
    assert _rows(owner, f.org, f.me) == dict.fromkeys(CLIENT_SIDE, 0)
    with owner.transaction():
        set_tenant(owner, mine, me2)
        c = owner.execute("select relationship_owner_id o from pulse.client where id=%s and org_id=%s", (f.client, mine)).fetchone()
        assert c["o"] == me2, "the relationship owner is the person's personal seat"
        assert owner.execute("select person_id p from pulse.client_contact where client_id=%s", (f.client,)).fetchone()["p"] == f.client_person
        assert owner.execute("select display_name n from pulse.person where id=%s", (f.client_person,)).fetchone()["n"] == "Synthetic Client Contact"
        assert owner.execute("select client_id c from pulse.project where id=%s", (f.client_project,)).fetchone()["c"] == f.client
        docs = owner.execute("select id, client_id c, project_id p, created_by b, number from pulse.erp_document order by doc_type").fetchall()
        assert [(d["id"], d["c"], d["p"], d["b"]) for d in docs] == [(f.invoice, f.client, f.client_project, me2), (f.quote, f.client, f.client_project, me2)]
        assert docs[0]["number"] == f.number
        assert owner.execute("select client_id c from pulse.fin_entry where id=%s", (f.payment,)).fetchone()["c"] == f.client
        # Nothing in the personal space points at a client that is not there.
        for t in ("pulse.client_contact", "pulse.project", "pulse.erp_document", "pulse.fin_entry"):
            n = owner.execute(f"""select count(*) n from {t} x where x.org_id=%s and x.client_id is not null
                                  and not exists (select 1 from pulse.client c where c.id = x.client_id and c.org_id = x.org_id)""", (mine,)).fetchone()["n"]
            assert n == 0, t
        rec = owner.execute("select with_clients w from pulse_priv.org_merge where id=%s", (r["merge"],)).fetchone()
        assert rec["w"] is True
        note = owner.execute("select changes from pulse.audit_event where org_id=%s and action='org_merge_into_personal'", (mine,)).fetchone()["changes"]
        assert note["withClients"] is True
    # The person sees them in their personal space (the API's own role), and another company sees none of it.
    assert _as(api, mine, me2, "select count(*) n from pulse.client")[0]["n"] == 1
    assert _as(api, mine, me2, "select count(*) n from pulse.erp_document")[0]["n"] == 2
    assert _as(api, other.org, other.lead, "select count(*) n from pulse.client where display_name like 'Synthetic Freelance%%'")[0]["n"] == 0
    assert _rows(owner, other.org, other.lead) == other_before

    # The undo puts the clients back with the rest: the old seat, the old organisation, nothing left in the personal space.
    with owner.transaction():
        back = owner.execute("select pulse.org_merge_undo(%s,%s,%s) r", (r["merge"], WHO, "synthetic words: put it back")).fetchone()["r"]
    assert back["back"]["pulse.client"] == 1 and back["back"]["pulse.erp_document"] == 2
    assert _rows(owner, f.org, f.me) == before
    assert _rows(owner, mine, me2) == dict.fromkeys(CLIENT_SIDE, 0)
    with owner.transaction():
        set_tenant(owner, f.org, f.me)
        assert owner.execute("select relationship_owner_id o from pulse.client where id=%s", (f.client,)).fetchone()["o"] == f.me
        assert owner.execute("select created_by b from pulse.erp_document where id=%s", (f.invoice,)).fetchone()["b"] == f.me
        assert owner.execute("select status from pulse.org where id=%s", (f.org,)).fetchone()["status"] == "active"
    assert _rows(owner, other.org, other.lead) == other_before


def test_billing_carries_on_in_the_personal_space(owner, worker, api):
    """The invoice numbering moves with the invoices: the next one issued in the personal space takes the next number."""
    f = _freelancer(worker, owner, api)
    r = _merge(owner, f.org, f.account, True)
    mine, me2 = r["to"], r["toPerson"]
    with api.transaction():
        set_tenant(api, mine, me2)
        nxt = _doc(api, mine, "invoice", f.client, f.client_project, me2, 2)
        api.execute("select pulse.erp_document_issue(%s)", (nxt,))
        numbers = [x["number"] for x in api.execute("select number from pulse.erp_document where doc_type='invoice' order by issued_at").fetchall()]
    assert numbers[0] == f.number and len(set(numbers)) == 2, numbers


def test_the_client_path_keeps_every_other_refusal(owner, worker, api):
    f = _freelancer(worker, owner, api)
    other = build_world(worker, owner, api)

    def refuse(match):
        return pytest.raises(psycopg.errors.InsufficientPrivilege, match=match)

    # Another person signs in to it.
    stranger = _account(owner, (other.org, other.lead))
    with owner.transaction():
        owner.execute("insert into pulse_priv.account_member(account_id,member_org,person_id,kind) values(%s,%s,%s,'staff')", (stranger, f.org, f.contact))
    with refuse("Other people sign in"):
        _merge(owner, f.org, f.account, True)
    with owner.transaction():
        owner.execute("delete from pulse_priv.account_member where account_id=%s and member_org=%s", (stranger, f.org))
    # A stranger's account (no seat there).
    with refuse("no staff seat"):
        _merge(owner, f.org, stranger, True)
    # Other active staff.
    with owner.transaction():
        set_tenant(owner, f.org)
        helper = owner.execute("insert into pulse.person(org_id,display_name,side,status) values(%s,'Synthetic Helper','staff','active') returning id", (f.org,)).fetchone()["id"]
    with refuse("other staff"):
        _merge(owner, f.org, f.account, True)
    with owner.transaction():
        set_tenant(owner, f.org)
        owner.execute("update pulse.person set status='inactive' where id=%s", (helper,))
    # A client signs in to the portal.
    with owner.transaction():
        set_tenant(owner, f.org)
        pp = owner.execute("""insert into pulse_priv.portal_principal(org_id,username,name,password_hash) values(%s,%s,'Synthetic Client Login','x')
                              returning id""", (f.org, "synthetic-" + uuid.uuid4().hex[:8])).fetchone()["id"]
        owner.execute("""insert into pulse_priv.portal_grant(org_id,principal_id,client_id,project_id,active,reason)
                         values(%s,%s,%s,%s,true,'synthetic: the client follows the site')""", (f.org, pp, f.client, f.client_project))
    with refuse("portal"):
        _merge(owner, f.org, f.account, True)
    with owner.transaction():
        set_tenant(owner, f.org)
        owner.execute("update pulse_priv.portal_grant set active=false where principal_id=%s", (pp,))
    # Linked to another organisation.
    with owner.transaction():
        cid = owner.execute("insert into pulse_priv.org_connection(a_org,b_org,kind,client_id) values(%s,%s,'client',%s) returning id", (f.org, other.org, f.client)).fetchone()["id"]
    with refuse("linked to another organisation"):
        _merge(owner, f.org, f.account, True)
    with owner.transaction():
        owner.execute("delete from pulse_priv.org_connection where id=%s", (cid,))
    # No words, no merge; and nobody but the platform's tools may run it.
    with owner.transaction(), pytest.raises(psycopg.errors.InvalidParameterValue):
        owner.execute("select pulse.org_merge_into_personal(%s,%s,%s,%s,true)", (f.org, f.account, WHO, " "))
    with api.transaction(), pytest.raises(psycopg.errors.InsufficientPrivilege):
        set_tenant(api, f.org, f.me)
        api.execute("select pulse.org_merge_into_personal(%s,%s,%s,%s,true)", (f.org, f.account, WHO, WORDS))
    # Every refusal left it as it was; with the blockers gone it merges.
    with owner.transaction():
        set_tenant(owner, f.org)
        assert owner.execute("select status from pulse.org where id=%s", (f.org,)).fetchone()["status"] == "active"
    assert _merge(owner, f.org, f.account, True)["moved"]["pulse.client"] == 1


def test_the_admin_tool_moves_clients_only_with_the_flag(owner, worker, api):
    f = _freelancer(worker, owner, api)
    with owner.transaction():
        handle = owner.execute("select handle from pulse_priv.pulse_account where id=%s", (f.account,)).fetchone()["handle"]
    no = _tool("--org", f.handle, "--account", handle)
    assert no.returncode == 2 and "clients" in no.stderr, no.stderr
    new = "n" + uuid.uuid4().hex[:10]
    dry = _tool("--org", f.handle, "--account", handle, "--with-clients", "--handle", new)
    assert dry.returncode == 0 and "DRY RUN" in dry.stdout and '"withClients": true' in dry.stdout and f'"to": "{new}"' in dry.stdout, dry.stderr
    assert _rows(owner, f.org, f.me)["pulse.client"] == 1
    # A handle someone else has is refused, and then nothing is written: the merge rolls back with it.
    other = _account(owner, (f.org, f.contact))
    with owner.transaction():
        taken = owner.execute("select handle from pulse_priv.pulse_account where id=%s", (other,)).fetchone()["handle"]
        owner.execute("delete from pulse_priv.account_member where account_id=%s", (other,))
    bad = _tool("--org", f.handle, "--account", handle, "--with-clients", "--handle", taken, "--apply")
    assert bad.returncode == 2 and "already has" in bad.stderr, bad.stderr
    assert _rows(owner, f.org, f.me)["pulse.client"] == 1
    done = _tool("--org", f.handle, "--account", handle, "--with-clients", "--handle", "@" + new.upper(), "--apply")
    assert done.returncode == 0 and "APPLIED" in done.stdout, done.stderr
    merge = next(line.split('"')[3] for line in done.stdout.splitlines() if line.strip().startswith('"merge"'))
    with owner.transaction():
        set_tenant(owner, f.org)
        assert owner.execute("select status from pulse.org where id=%s", (f.org,)).fetchone()["status"] == "archived"
        assert owner.execute("select count(*) n from pulse.client where org_id=%s", (f.org,)).fetchone()["n"] == 0
        # The new handle is the account's; the old one still finds the person (an alias), and the seat follows.
        assert owner.execute("select handle from pulse_priv.pulse_account where id=%s", (f.account,)).fetchone()["handle"] == new
        names = {r["handle"] for r in owner.execute("select handle from pulse_priv.handle_name where kind='person' and ref=%s", (f.account,))}
        assert names == {handle, new}
        mine = owner.execute("select merged_into from pulse.org where id=%s", (f.org,)).fetchone()["merged_into"]
        seat = owner.execute("select person_id from pulse_priv.account_member where account_id=%s and member_org=%s", (f.account, mine)).fetchone()["person_id"]
        set_tenant(owner, mine)
        assert owner.execute("select username from pulse.people_profile where person_id=%s", (seat,)).fetchone()["username"] == new
        assert owner.execute("select person_id from pulse.person_username_alias where org_id=%s and username=%s", (mine, handle)).fetchone()["person_id"] == seat
    with api.transaction():
        assert api.execute("select pulse.login_alias(%s) a", (handle,)).fetchone()["a"] == new
    assert _tool("--undo", merge, "--with-clients").returncode == 2
    assert _tool("--undo", merge, "--apply").returncode == 0
    assert _rows(owner, f.org, f.me)["pulse.client"] == 1
