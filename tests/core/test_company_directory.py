"""COMPANY-SEARCH (1891): the public company and people directory. Anyone signed in finds companies (name, @handle,
logo and city by default; what else the admins show) and people who turned on "Let people find me"; private fields
never come back; exact IDs rank first, then names; prefixes, typos and Devanagari names are found; 100k companies
answer in under 150 ms. Synthetic tenants, obviously fake people and the leak gate's reviewed synthetic IDs only."""
import hashlib
import json
import statistics
import time
import uuid

import psycopg
import pytest
from pulse_sdk.db import set_tenant
from helpers import build_world

# The leak gate's reviewed synthetic GSTINs: the first three have a correct check letter, the last two do not.
GOOD_GSTIN = "27AABCS5678K1ZS"
GOOD_GSTIN_2 = "29AAACN1234F1ZT"
GOOD_GSTIN_3 = "27AAXFV2138F1ZR"
BAD_CHECK = "27AAXFV2138F1ZS"
BAD_STATE = "99AAXFV2138F1ZR"
CIN = "U72900MH2020PTC" + "000001"           # synthetic; a CIN has no check digit
COMPANY_COLUMNS = ["id", "handle", "name", "legal_name", "city", "industry", "website", "logo_version", "verified_by", "ids", "match", "score"]
PEOPLE_COLUMNS = ["handle", "name", "headline", "photo_version", "company_handle", "company_name", "email", "phone", "match", "score"]


def tag():
    return uuid.uuid4().hex[:8]


def admin_of(worker, w):
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'admin','2020-01-01') on conflict do nothing", (w.org, w.manager))


def rename(owner, w, name):
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("update pulse.org set name=%s where id=%s", (name, w.org))
        return owner.execute("select handle from pulse.org where id=%s", (w.org,)).fetchone()["handle"]


def save_card(api, w, card):
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        return api.execute("select pulse.directory_card_save(%s::jsonb) c", (json.dumps(card),)).fetchone()["c"]


def companies(api, w, viewer, q, limit=8, exclude=None):
    with api.transaction():
        set_tenant(api, w.org, viewer)
        cur = api.execute("select * from pulse.directory_companies(%s, %s, %s)", (q, limit, exclude))
        assert [d.name for d in cur.description] == COMPANY_COLUMNS
        return cur.fetchall()


def people(api, w, viewer, q, limit=8):
    with api.transaction():
        set_tenant(api, w.org, viewer)
        cur = api.execute("select * from pulse.directory_people(%s, %s)", (q, limit))
        assert [d.name for d in cur.description] == PEOPLE_COLUMNS
        return cur.fetchall()


def account(owner, w, person, handle, name, kind="staff"):
    acct = uuid.uuid4()
    with owner.transaction():
        owner.execute("insert into pulse_priv.pulse_account(id,handle,display_name) values(%s,%s,%s)", (acct, handle, name))
        owner.execute("insert into pulse_priv.handle_name(handle,kind,ref) values(%s,'person',%s)", (handle, acct))
        owner.execute("insert into pulse_priv.account_member(account_id,member_org,person_id,kind) values(%s,%s,%s,%s)", (acct, w.org, person, kind))
    return acct


@pytest.fixture
def two(worker, owner, api):
    a, b = build_world(worker, owner, api), build_world(worker, owner, api)
    admin_of(worker, a)
    admin_of(worker, b)
    return a, b


def test_new_tables_force_row_security_with_a_tenant_policy_and_no_api_grant(worker, api):
    for t in ("org_public_card", "directory_entry", "directory_invite"):
        r = worker.execute("""select c.relrowsecurity rls, c.relforcerowsecurity force,
            exists(select 1 from pg_policy p where p.polrelid=c.oid and p.polname='tenant_isolation') tenant
          from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='pulse' and c.relname=%s""", (t,)).fetchone()
        assert r == {"rls": True, "force": True, "tenant": True}, t
        for conn in (api, worker):
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                with conn.transaction():
                    conn.execute(f"select * from pulse.{t} limit 1")


def test_gstin_and_cin_checks(api):
    q = lambda f, v: api.execute(f"select pulse.{f}(%s) ok", (v,)).fetchone()["ok"]
    for g in (GOOD_GSTIN, GOOD_GSTIN_2, GOOD_GSTIN_3, GOOD_GSTIN.lower(), " " + GOOD_GSTIN + " "):
        assert q("gstin_valid", g) is True, g
    for g in (BAD_CHECK, BAD_STATE, "00" + GOOD_GSTIN[2:], GOOD_GSTIN[:14], "", None, "27AABCS5678K1Z"):
        assert q("gstin_valid", g) is False, g
    assert q("cin_valid", CIN) is True
    for c in (CIN.replace("MH", "QQ"), CIN.replace("PTC", "XYZ"), CIN.replace("2020", "1700"), CIN[:-1], "L" + CIN):
        assert q("cin_valid", c) is False, c


def test_a_company_is_listed_with_name_handle_and_city_only_by_default(two, owner, api):
    a, b = two
    t = tag()
    handle = rename(owner, a, f"Zephyrine {t} Interiors")
    save_card(api, a, {"legalName": f"Zephyrine {t} Interiors Private Limited", "city": "Pune", "industry": "Interiors",
                       "website": "www.zephyrine.example", "gstin": GOOD_GSTIN})
    rows = companies(api, b, b.editor, f"zephyrine {t}")       # a member of another company
    mine = [r for r in rows if r["id"] == a.org]
    assert len(mine) == 1
    r = mine[0]
    assert (r["handle"], r["name"], r["city"]) == (handle, f"Zephyrine {t} Interiors", "Pune")
    assert r["legal_name"] is None and r["industry"] is None and r["website"] is None and r["ids"] == []
    assert r["verified_by"] == "gstin"                         # a valid GSTIN is on file, even while hidden
    # A hidden ID does not find the company; shown, it does, first.
    assert not [x for x in companies(api, b, b.editor, GOOD_GSTIN) if x["id"] == a.org]
    save_card(api, a, {"show": {"ids": True, "legalName": True, "website": True, "industry": True}})
    first = companies(api, b, b.editor, GOOD_GSTIN)[0]
    assert first["id"] == a.org and first["match"] == "id"
    assert first["ids"] == [{"kind": "gstin", "label": "GSTIN", "value": GOOD_GSTIN}]
    assert first["legal_name"].endswith("Private Limited") and first["website"] == "https://www.zephyrine.example"
    # "Show us in search" off: gone from search and from the profile.
    save_card(api, a, {"listed": False})
    assert not [x for x in companies(api, b, b.editor, f"zephyrine {t}") if x["id"] == a.org]
    with api.transaction():
        set_tenant(api, b.org, b.editor)
        assert api.execute("select count(*) n from pulse.directory_company(%s)", (handle,)).fetchone()["n"] == 0


def test_access_matrix(two, owner, api):
    a, b = two
    t = tag()
    rename(owner, a, f"Quillmont {t} Studio")
    # Signed out (no viewer): refused.
    for sql in ("select * from pulse.directory_companies('quillmont')", "select * from pulse.directory_people('fake')",
                "select * from pulse.directory_company('x')", "select pulse.directory_me()"):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            with api.transaction():
                set_tenant(api, a.org)
                api.execute(sql)
    # Anyone signed in searches; only an admin reads or changes their own card.
    for viewer in (a.editor, a.lead, b.editor, b.manager):
        w = a if viewer in (a.editor, a.lead) else b
        assert [r for r in companies(api, w, viewer, f"quillmont {t}") if r["id"] == a.org]
    for viewer in (a.editor, a.lead):
        for sql, args in (("select pulse.directory_card_get()", ()), ("select pulse.directory_card_save(%s::jsonb)", ('{"city":"Nowhere"}',))):
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                with api.transaction():
                    set_tenant(api, a.org, viewer)
                    api.execute(sql, args)
    with api.transaction():
        set_tenant(api, a.org, a.manager)
        card = api.execute("select pulse.directory_card_get() c").fetchone()["c"]
    assert card["show"] == {"legalName": False, "logo": True, "city": True, "industry": False, "website": False, "ids": False}
    # An admin changes only their own company's card: b's admin saving writes b's card.
    save_card(api, b, {"city": "Nashik"})
    r = [x for x in companies(api, b, b.editor, f"quillmont {t}") if x["id"] == a.org][0]
    assert r["city"] is None
    # Internal functions are closed to the API role.
    for fn in ("pulse.directory_refresh_company(%s)", "pulse.directory_refresh_person(%s)"):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            with api.transaction():
                set_tenant(api, a.org, a.manager)
                api.execute(f"select {fn}", (a.org,))


def test_private_fields_never_come_back(two, owner, api, worker):
    a, b = two
    t = tag()
    secret = f"secretword{t}"
    rename(owner, a, f"Marigoldia {t} Works")
    save_card(api, a, {"legalName": f"{secret} legal", "industry": f"{secret} industry", "website": f"https://{secret}.example",
                       "gstin": GOOD_GSTIN_2, "cin": CIN, "otherIds": [{"kind": "other", "label": "IEC", "value": f"IEC{t}"}]})
    person = account(owner, a, a.editor, f"fake{t}", f"Fake Marigold {t}")
    with owner.transaction():
        owner.execute("insert into pulse_priv.account_profile(account_id, headline, contact_email, contact_phone) values(%s,%s,%s,%s)",
                      (person, f"Head of {t}", f"{secret}@example.com", "+919000012345"))
    with api.transaction():
        set_tenant(api, a.org, a.editor)
        api.execute("""select pulse.directory_me_save('{"findable": true}'::jsonb)""")
    seen = []
    for q in (f"marigoldia {t}", secret, GOOD_GSTIN_2, CIN, f"IEC{t}", f"fake{t}", f"{secret}@example.com", "9000012345", f"head of {t}"):
        seen += [dict(r) for r in companies(api, b, b.editor, q)] + [dict(r) for r in people(api, b, b.editor, q)]
    text = json.dumps(seen, default=str)
    assert f"Fake Marigold {t}" in text and f"Head of {t}" in text          # what is public is there
    for hidden in (secret, GOOD_GSTIN_2, CIN, f"IEC{t}", "9000012345", str(person)):
        assert hidden not in text, hidden
    # The single-profile reads have the same columns.
    with api.transaction():
        set_tenant(api, b.org, b.editor)
        cur = api.execute("select * from pulse.directory_person(%s)", (f"fake{t}",))
        assert [d.name for d in cur.description] == ["handle", "name", "headline", "photo_version", "company_handle", "company_name", "email", "phone"]
        p = cur.fetchone()
        assert p["email"] is None and p["phone"] is None and p["company_name"] == f"Marigoldia {t} Works"


def test_people_are_found_only_after_they_opt_in(two, owner, api):
    a, b = two
    t = tag()
    acct = account(owner, a, a.editor, f"fakeperson{t}", f"Fakename Tester{t}")
    assert not people(api, b, b.editor, f"fakeperson{t}")
    assert not people(api, b, b.editor, f"Fakename Tester{t}")
    with owner.transaction():
        owner.execute("insert into pulse_priv.account_profile(account_id, headline, contact_email) values(%s,'Synthetic editor',%s)",
                      (acct, f"fake.{t}@example.com"))
    with api.transaction():
        set_tenant(api, a.org, a.editor)
        me = api.execute("""select pulse.directory_me_save('{"findable": true}'::jsonb) m""").fetchone()["m"]
    assert me["findable"] is True and me["shown"]["handle"] == f"fakeperson{t}"
    r = people(api, b, b.editor, f"@fakeperson{t}")[0]
    assert (r["handle"], r["match"], r["headline"], r["email"]) == (f"fakeperson{t}", "handle", "Synthetic editor", None)
    assert people(api, b, b.editor, f"fakename test")                   # prefix of the name
    hidden = people(api, b, b.editor, f"fake.{t}@example.com")          # e-mail hidden: never an ID match, never shown
    assert all(r["match"] != "id" and r["email"] is None for r in hidden)
    with api.transaction():
        set_tenant(api, a.org, a.editor)
        api.execute("""select pulse.directory_me_save('{"showEmail": true}'::jsonb)""")
    hit = people(api, b, b.editor, f"fake.{t}@example.com")[0]
    assert hit["email"] == f"fake.{t}@example.com" and hit["match"] == "id"
    # A rename follows; turning it off removes the person.
    with owner.transaction():
        owner.execute("update pulse_priv.pulse_account set display_name=%s where id=%s", (f"Renamed Fake{t}", acct))
    assert people(api, b, b.editor, f"@fakeperson{t}")[0]["name"] == f"Renamed Fake{t}"
    with api.transaction():
        set_tenant(api, a.org, a.editor)
        api.execute("""select pulse.directory_me_save('{"findable": false}'::jsonb)""")
    assert not people(api, b, b.editor, f"fakeperson{t}")
    # Only a company the person works in can be shown.
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        with api.transaction():
            set_tenant(api, a.org, a.editor)
            api.execute("select pulse.directory_me_save(%s::jsonb)", (json.dumps({"company": "someoneelse"}),))


def test_exact_ids_and_handles_rank_first_then_names(two, worker, owner, api):
    a, b = two
    t = tag()
    c = build_world(worker, owner, api)
    admin_of(worker, c)
    ha = rename(owner, a, f"Harbourline {t} Traders")
    rename(owner, c, f"{ha} Logistics")            # c's NAME starts with a's handle
    save_card(api, c, {"gstin": GOOD_GSTIN_3, "show": {"ids": True}})
    rows = companies(api, b, b.editor, ha)
    assert rows[0]["id"] == a.org and rows[0]["match"] == "handle"
    assert [r["id"] for r in rows].index(c.org) > 0
    rows = companies(api, b, b.editor, f"@{ha}")
    assert rows[0]["id"] == a.org
    rows = companies(api, b, b.editor, GOOD_GSTIN_3.lower())
    assert rows[0]["id"] == c.org and rows[0]["match"] == "id" and rows[0]["verified_by"] == "gstin"
    # The PAN inside a shown GSTIN finds it too; part of the GSTIN while typing shows it as well.
    assert companies(api, b, b.editor, GOOD_GSTIN_3[2:12])[0]["id"] == c.org
    assert [r for r in companies(api, b, b.editor, GOOD_GSTIN_3[:9]) if r["id"] == c.org]
    # Exact name (without "Pvt Ltd") beats a longer name that starts the same.
    rows = companies(api, b, b.editor, f"Harbourline {t} Traders Pvt. Ltd.")
    assert rows[0]["id"] == a.org and rows[0]["match"] == "name"
    # Leave out the searcher's own company when asked.
    assert not [r for r in companies(api, a, a.editor, ha, exclude=a.org) if r["id"] == a.org]


def test_prefixes_typos_and_devanagari_names(two, owner, api):
    a, b = two
    t = tag()
    rename(owner, a, f"Kalpavriksh Vitalis {t}")
    def found(q):
        return [r for r in companies(api, b, b.editor, q, limit=20) if r["id"] == a.org]
    assert found("kalpa")[0]["match"] in ("prefix", "name")               # what it starts with
    assert found("vitalis")                                                # a later word
    assert found("vita")                                                   # a later word, still being typed
    assert found("kalpvriksh")[0]["match"] in ("fuzzy", "sounds", "words") # a letter missing
    assert found("kalpavirksh")                                            # two letters swapped
    assert found("कल्पवृक्ष")                                               # typed in Hindi / Marathi
    assert found("वाइटलिस")
    assert not companies(api, b, b.editor, "k")                           # one letter: nothing yet
    with owner.transaction():                                              # an internal function: not the API's
        assert owner.execute("select pulse.dir_sound('Vitals') a, pulse.dir_sound('वाइटल्स') b").fetchone() == {"a": "vtls", "b": "vtls"}


def browse(api, w, viewer, kind=None, limit=12):
    with api.transaction():
        set_tenant(api, w.org, viewer)
        if kind:
            cur = api.execute("select * from pulse.directory_browse_companies(%s, %s)", (kind, limit))
            assert [d.name for d in cur.description] == COMPANY_COLUMNS[:-2]
        else:
            cur = api.execute("select * from pulse.directory_browse_people(%s)", (limit,))
            assert [d.name for d in cur.description] == PEOPLE_COLUMNS[:-2]
        return cur.fetchall()


def test_browse_shows_only_what_search_shows(two, owner, api):
    """UI-SWEEP (1906): Find companies and people before anything is typed. Verified and recently joined companies come
    from the same public index as search, with hidden fields still hidden and without the viewer's own company; people
    of the viewer's company only once they turned on "Let people find me", never the viewer, never another company's."""
    a, b = two
    t = tag()
    rename(owner, a, f"0000 Verdance {t} Builders")                  # sorts first among the verified names
    save_card(api, a, {"legalName": f"Verdance {t} Builders Private Limited", "gstin": GOOD_GSTIN_2})
    seen = [r for r in browse(api, b, b.editor, "verified") if r["id"] == a.org]
    assert len(seen) == 1 and seen[0]["verified_by"] == "gstin"
    assert seen[0]["legal_name"] is None and seen[0]["ids"] == []       # hidden on the card: hidden here too
    assert not [r for r in browse(api, a, a.editor, "verified") if r["id"] == a.org]   # not your own company
    assert [r for r in browse(api, b, b.editor, "recent") if r["id"] == a.org]           # a joined just now
    assert not [r for r in browse(api, a, a.editor, "recent") if r["id"] == a.org]
    assert len(browse(api, b, b.editor, "recent", 500)) <= 12                            # the list is capped
    save_card(api, a, {"listed": False})                                                # "Show us in search" off
    assert not [r for r in browse(api, b, b.editor, "verified") if r["id"] == a.org]
    assert not [r for r in browse(api, b, b.editor, "recent") if r["id"] == a.org]
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        browse(api, b, b.editor, "everything")
    # People: a colleague who opted in; not before, not to another company, never yourself.
    acct = account(owner, a, a.editor, f"fakebrowse{t}", f"Fakebrowse Tester{t}")
    assert not [r for r in browse(api, a, a.manager) if r["handle"] == f"fakebrowse{t}"]
    with api.transaction():
        set_tenant(api, a.org, a.editor)
        api.execute("""select pulse.directory_me_save('{"findable": true}'::jsonb)""")
    assert [r for r in browse(api, a, a.manager) if r["handle"] == f"fakebrowse{t}"]
    assert not [r for r in browse(api, a, a.editor) if r["handle"] == f"fakebrowse{t}"]
    assert not [r for r in browse(api, b, b.editor) if r["handle"] == f"fakebrowse{t}"]
    assert acct
    # Signed out (no viewer): refused.
    for sql in ("select * from pulse.directory_browse_companies('recent')", "select * from pulse.directory_browse_people()"):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            with api.transaction():
                set_tenant(api, a.org)
                api.execute(sql)


def test_invite_a_company_not_on_pulse(two, api):
    a, b = two
    token = uuid.uuid4().hex + uuid.uuid4().hex
    digest = hashlib.sha256(token.encode()).hexdigest()
    with api.transaction():
        set_tenant(api, a.org, a.editor)
        inv = api.execute("select pulse.directory_invite_make(%s,%s,%s,'contract',null,%s) i",
                          ("Lotus Synthetic Interiors", "owner@lotus.example", None, digest)).fetchone()["i"]
    assert inv["status"] == "pending" and inv["purpose"] == "contract" and "token" not in json.dumps(inv)
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        with api.transaction():
            set_tenant(api, a.org, a.editor)
            api.execute("select pulse.directory_invite_make('Nobody Co',null,null,'general',null,%s)", (hashlib.sha256(b"x").hexdigest(),))
    with api.transaction():
        set_tenant(api, a.org, a.editor)
        assert [i["id"] for i in api.execute("select pulse.directory_invites() l").fetchone()["l"]] == [inv["id"]]
    with api.transaction():
        set_tenant(api, b.org, b.manager)                                  # another company sees none of it
        assert api.execute("select pulse.directory_invites() l").fetchone()["l"] == []
        got = api.execute("select pulse.directory_invite_claim(%s) c", (digest,)).fetchone()["c"]
    assert got["status"] == "joined" and got["mine"] is True and got["companyName"] == "Lotus Synthetic Interiors"
    with api.transaction():
        set_tenant(api, a.org, a.editor)
        l = api.execute("select pulse.directory_invites() l").fetchone()["l"]
        assert l[0]["status"] == "joined" and l[0]["joinedCompany"]["id"] == str(b.org)
        assert api.execute("select pulse.directory_invite_claim(%s) c", (hashlib.sha256(b"unknown").hexdigest(),)).fetchone()["c"] is None


WORDS = ["Shree", "Sai", "Om", "Gosele", "Lakshmi", "Balaji", "Kepuhip", "Siddhi", "Vetasak", "Royal", "Sunrise", "Global",
         "Prime", "Apex", "Nova", "Bright", "Green", "Golden", "Matrix", "Pinnacle"]
KINDS = ["Interiors", "Builders", "Developers", "Infra", "Realty", "Traders", "Enterprises", "Technologies", "Solutions",
         "Consultants", "Associates", "Industries", "Foods", "Pharma", "Logistics", "Media", "Studios", "Exports"]
CITIES = ["Pune", "Mumbai", "Nashik", "Nagpur", "Thane", "Aurangabad", "Kolhapur", "Satara", "Solapur", "Delhi", "Bengaluru", "Hyderabad"]


def test_search_answers_in_under_150_ms_on_100k_companies(worker, owner, api):
    """The seed benchmark: 100k synthetic companies (in one transaction, rolled back), then every kind of query."""
    org = build_world(worker, owner, api).org
    times = {}
    with owner.transaction():
        set_tenant(owner, org)
        # Built indexes, as on a real install (a bulk insert into live GIN indexes leaves pending lists a fresh install
        # never has, and is slow): drop them, load, build them again from their own definitions. All rolled back.
        indexes = owner.execute("""select c.relname, pg_get_indexdef(i.indexrelid) d from pg_index i join pg_class c on c.oid = i.indexrelid
                                    where i.indrelid = 'pulse.directory_entry'::regclass and not i.indisprimary""").fetchall()
        for ix in indexes:
            owner.execute(f'drop index pulse."{ix["relname"]}"')
        owner.execute("""insert into pulse.directory_entry(org_id, kind, ref, handle, name, city, id_keys)
          select %s, 'company', gen_random_uuid(), left(lower(regexp_replace(n.name, '[^A-Za-z0-9]', '', 'g')), 24) || g, n.name, n.city, n.id_keys
            from (select g, 
                 (%s::text[])[1 + g %% 20] || ' ' || initcap(s1.x || s2.x || s3.x) || ' ' || (%s::text[])[1 + (g / 20) %% 18]
                   || (array['', ' Pvt Ltd', ' LLP', ' Private Limited'])[1 + g %% 4] as name,
                 (%s::text[])[1 + g %% 12] city,
                 case when g %% 5 = 0 then array['BENCHID' || lpad(g::text, 8, '0')] else '{}' end id_keys
            from generate_series(1, 100000) g
            cross join lateral (select (array['ka','ri','mo','ta','shi','va','na','ra','pu','de','lo','san','vi','ja','ha','ga'])[1 + (g * 7 + 3) %% 16] x) s1
            cross join lateral (select (array['ma','ni','ku','ro','te','la','bi','so','dha','re','yo','chi','pa','ne','tu','vo'])[1 + (g / 16) %% 16] x) s2
            cross join lateral (select (array['n','r','sh','l','t','k','m','v','','s','d','j','p','th','g','y'])[1 + (g / 256) %% 16] x) s3) n""",
                      (org, WORDS, KINDS, CITIES))
        for ix in indexes:
            owner.execute(ix["d"])
        owner.execute("analyze pulse.directory_entry")
        sample = owner.execute("select name, handle from pulse.directory_entry where org_id = %s and handle like '%%54321'", (org,)).fetchone()
        typo = sample["name"].split()[1]
        typo = typo[:2] + typo[3:]                                        # a letter missing
        owner.execute("select set_config('pulse.viewer_id', %s, true)", (str(uuid.uuid4()),))
        h = sample["handle"]
        queries = {"handle": h, "@handle": f"@{h}", "id": "BENCHID00054320", "exact name": sample["name"],
                   "prefix": "Shree Ka", "two letters": "sh", "word": "technologies", "word prefix": "pharm",
                   "typo": f"{sample['name'].split()[0]} {typo}", "city": "kolhapur interiors", "hindi": "श्री गणेश",
                   "nothing": "zzqxj wvvq"}
        for label, q in queries.items():
            runs = []
            for _ in range(5):
                t0 = time.perf_counter()
                rows = owner.execute("select * from pulse.directory_companies(%s, 8)", (q,)).fetchall()
                runs.append((time.perf_counter() - t0) * 1000)
            times[label] = statistics.median(runs)
            if label in ("handle", "@handle"):
                assert rows[0]["handle"] == h
            if label == "id":
                assert rows[0]["handle"].endswith("54320") and rows[0]["match"] == "id"
            if label == "typo":
                assert rows, "a name with a letter missing still finds something"
        print("COMPANY-SEARCH benchmark (median ms of 5, 100k companies):", json.dumps({k: round(v, 1) for k, v in times.items()}))
        raise psycopg.Rollback()                                           # the 100k rows are never kept
    slow = {k: round(v, 1) for k, v in times.items() if v >= 150}
    assert not slow, f"slower than 150 ms: {slow}"
