"""DOCS-MCP (1716): tags and categories on docs, and private folders (only chosen people see a folder and everything in
it, admins included), enforced by the database under forced row security. Synthetic tenants and words only."""
import psycopg
import pytest
from helpers import build_world
from test_tasks_rt1 import as_, one, team  # noqa: F401  (team is a fixture)

DOC = """insert into pulse.doc(org_id,title,body_html,body_text,access,created_by,folder_id,tags,category)
  values(pulse.current_org(),%s,'<p>Synthetic words</p>','Synthetic words',%s,pulse.current_viewer(),%s,%s,%s) returning id"""
FOLDER = "insert into pulse.doc_folder(org_id,name,parent_id,created_by,access) values(pulse.current_org(),%s,%s,pulse.current_viewer(),%s) returning id"
SHARE = "insert into pulse.doc_folder_share(org_id,folder_id,person_id,added_by) values(pulse.current_org(),%s,%s,pulse.current_viewer()) returning folder_id"


def doc(api, w, who, title, folder=None, access="company", tags=(), category=None):
    return one(api, w, who, DOC, (title, access, folder, list(tags), category))["id"]


def folder(api, w, who, name, parent=None, access="company"):
    return one(api, w, who, FOLDER, (name, parent, access))["id"]


def ids(api, w, who, table):
    return {r["id"] for r in as_(api, w, who, f"select id from pulse.{table}")}


def test_folder_share_forces_row_security_with_a_tenant_policy(worker):
    r = worker.execute("""select c.relrowsecurity,c.relforcerowsecurity,exists(select 1 from pg_policy p where p.polrelid=c.oid and p.polname='tenant_isolation') tenant
      from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='pulse' and c.relname='doc_folder_share'""").fetchone()
    assert (r["relrowsecurity"], r["relforcerowsecurity"], r["tenant"]) == (True, True, True)


def test_tags_and_category(api, worker, team):
    w = team
    d = doc(api, w, w.editor, "Offer stage 2", tags=["offer", "stage 2"], category="Offer")
    row = one(api, w, w.editor2, "select tags,category from pulse.doc where id=%s", (d,))
    assert row["tags"] == ["offer", "stage 2"] and row["category"] == "Offer"
    # Tags are lowercase words, at most 20; a category is one short line.
    for bad in (["Offer"], ["<b>x</b>"], [f"t{i}" for i in range(21)]):
        with pytest.raises(psycopg.errors.CheckViolation):
            doc(api, w, w.editor, "Bad tags", tags=bad)
    with pytest.raises(psycopg.errors.CheckViolation):
        doc(api, w, w.editor, "Bad category", category="x" * 41)
    # Anyone who may edit a company doc changes its tags; the version does not move for a label.
    before = one(api, w, w.editor2, "select version from pulse.doc where id=%s", (d,))["version"]
    assert one(api, w, w.editor2, "update pulse.doc set tags=array['offer','sop'] where id=%s returning version", (d,))["version"] == before
    assert {r["id"] for r in as_(api, w, w.outsider, "select id from pulse.doc where tags @> array['sop']")} == {d}


def test_private_folder_hides_everything_inside_from_everyone_else(api, worker, team):
    w = team
    legal = folder(api, w, w.editor, "Legal", access="people")
    one(api, w, w.editor, SHARE, (legal, w.editor2))
    inner = folder(api, w, w.editor, "Contracts", parent=legal)
    open_folder = folder(api, w, w.editor, "Offer")
    company = doc(api, w, w.editor, "Lease draft", folder=legal)
    deep = doc(api, w, w.editor2, "Clause notes", folder=inner)
    outside = doc(api, w, w.editor, "Offer stage 1", folder=open_folder, tags=["offer"])
    one(api, w, w.editor, """insert into pulse.doc_file(org_id,folder_id,name,mime,size,sha256,bytes,added_by)
      values(pulse.current_org(),%s,'nda.txt','text/plain',3,'x',%s,pulse.current_viewer()) returning id""", (legal, b"abc"))
    # The maker and the chosen person see the folder, the folder inside it, and the docs at any depth.
    for who in (w.editor, w.editor2):
        assert {legal, inner, open_folder} <= ids(api, w, who, "doc_folder"), who
        assert {company, deep, outside} <= ids(api, w, who, "doc"), who
        assert as_(api, w, who, "select name from pulse.doc_file where folder_id=%s", (legal,)) != []
    # Everyone else (a colleague, HR, an admin) sees none of it, but still sees the company's open folder.
    for who in (w.outsider, w.lead, w.manager):
        assert legal not in ids(api, w, who, "doc_folder") and inner not in ids(api, w, who, "doc_folder"), who
        assert ids(api, w, who, "doc") & {company, deep} == set(), who
        assert outside in ids(api, w, who, "doc") and open_folder in ids(api, w, who, "doc_folder"), who
        assert as_(api, w, who, "select name from pulse.doc_file where folder_id=%s", (legal,)) == [], who
        assert as_(api, w, who, "update pulse.doc set title='Changed' where id=%s returning id", (company,)) == [], who
        assert as_(api, w, who, "select pulse.doc_id_can_see(%s) v", (company,))[0]["v"] is False, who
    # Only the maker (or an admin who can see it) chooses its people: an admin outside it cannot add themselves.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        one(api, w, w.manager, SHARE, (legal, w.manager))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        one(api, w, w.editor2, SHARE, (legal, w.outsider))
    # Adding a person opens it to them at once; the company's again opens it to all.
    one(api, w, w.editor, SHARE, (legal, w.outsider))
    assert company in ids(api, w, w.outsider, "doc") and company not in ids(api, w, w.lead, "doc")
    as_(api, w, w.editor, "update pulse.doc_folder set access='company' where id=%s returning id", (legal,))
    assert {company, deep} <= ids(api, w, w.lead, "doc")


def test_a_private_doc_stays_private_and_its_owner_keeps_it(api, worker, team):
    w = team
    shared = folder(api, w, w.editor, "Product")
    mine = doc(api, w, w.outsider, "My own notes", folder=shared, access="private")
    assert mine in ids(api, w, w.outsider, "doc") and mine not in ids(api, w, w.editor, "doc") and mine not in ids(api, w, w.manager, "doc")


def test_another_companys_docs_and_folders_are_never_seen(api, worker, owner, team):
    w = team
    f = folder(api, w, w.editor, "Company")
    d = doc(api, w, w.editor, "Vision", folder=f, tags=["offer"])
    other = build_world(worker, owner, api)
    assert as_(api, other, other.editor, "select id from pulse.doc where id=%s", (d,)) == []
    assert as_(api, other, other.manager, "select id from pulse.doc_folder where id=%s", (f,)) == []
    assert as_(api, other, other.manager, "select id from pulse.doc where tags @> array['offer']") == []
