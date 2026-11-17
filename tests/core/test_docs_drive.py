"""DOCS-DRIVE (1893): stars and Recent are each person's own, a chosen person views, comments or edits, the private folders
above a folder are named for the move check, and folders never go inside themselves. Enforced by the database under
forced row security. Synthetic tenants and words only."""
import psycopg
import pytest
from helpers import build_world
from test_tasks_rt1 import as_, one, team  # noqa: F401  (team is a fixture)

DOC = """insert into pulse.doc(org_id,title,body_html,body_text,access,created_by,folder_id)
  values(pulse.current_org(),%s,'<p>Synthetic words</p>','Synthetic words',%s,pulse.current_viewer(),%s) returning id"""
FOLDER = "insert into pulse.doc_folder(org_id,name,parent_id,created_by,access) values(pulse.current_org(),%s,%s,pulse.current_viewer(),%s) returning id"
SHARE_FOLDER = "insert into pulse.doc_folder_share(org_id,folder_id,person_id,added_by) values(pulse.current_org(),%s,%s,pulse.current_viewer()) returning folder_id"
SHARE_DOC = """insert into pulse.doc_share(org_id,doc_id,person_id,can_edit,can_comment,added_by) values(pulse.current_org(),%s,%s,%s,%s,pulse.current_viewer())
  on conflict (doc_id,person_id) do update set can_edit=excluded.can_edit,can_comment=excluded.can_comment returning doc_id"""
STAR_DOC = "insert into pulse.doc_star(org_id,person_id,doc_id) values(pulse.current_org(),%s,%s) returning id"
STAR_FOLDER = "insert into pulse.doc_star(org_id,person_id,folder_id) values(pulse.current_org(),%s,%s) returning id"
RECENT = "insert into pulse.doc_recent(org_id,person_id,doc_id) values(pulse.current_org(),%s,%s) returning doc_id"
COMMENT = "insert into pulse.doc_comment(org_id,doc_id,person_id,body) values(pulse.current_org(),%s,pulse.current_viewer(),'Synthetic note') returning id"


def doc(api, w, who, title, folder=None, access="company"):
    return one(api, w, who, DOC, (title, access, folder))["id"]


def folder(api, w, who, name, parent=None, access="company"):
    return one(api, w, who, FOLDER, (name, parent, access))["id"]


@pytest.mark.parametrize("table", ["doc_star", "doc_recent"])
def test_new_tables_force_row_security_with_a_tenant_policy(worker, table):
    r = worker.execute("""select c.relrowsecurity,c.relforcerowsecurity,exists(select 1 from pg_policy p where p.polrelid=c.oid and p.polname='tenant_isolation') tenant
      from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='pulse' and c.relname=%s""", (table,)).fetchone()
    assert (r["relrowsecurity"], r["relforcerowsecurity"], r["tenant"]) == (True, True, True)


def test_stars_and_recent_are_each_persons_own(api, worker, team):
    w = team
    offer = folder(api, w, w.editor, "Offer")
    d = doc(api, w, w.editor, "Offer stage 1", folder=offer)
    hidden = doc(api, w, w.editor2, "Pod head's own notes", access="private")
    one(api, w, w.editor, STAR_DOC, (w.editor, d))
    one(api, w, w.editor, STAR_FOLDER, (w.editor, offer))
    one(api, w, w.editor, RECENT, (w.editor, d))
    assert len(as_(api, w, w.editor, "select id from pulse.doc_star")) == 2
    assert as_(api, w, w.editor, "select doc_id from pulse.doc_recent") == [{"doc_id": d}]
    # Nobody else sees them, an admin included, and nobody stars or opens for someone else.
    for who in (w.editor2, w.outsider, w.lead, w.manager):
        assert as_(api, w, who, "select id from pulse.doc_star") == [], who
        assert as_(api, w, who, "select doc_id from pulse.doc_recent") == [], who
        assert as_(api, w, who, "delete from pulse.doc_star returning id") == [], who
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        one(api, w, w.manager, STAR_DOC, (w.editor, d))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        one(api, w, w.manager, RECENT, (w.editor, d))
    # A doc you cannot see is never starred or kept in your Recent.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        one(api, w, w.editor, STAR_DOC, (w.editor, hidden))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        one(api, w, w.editor, RECENT, (w.editor, hidden))
    # Taking a star off is your own.
    assert len(as_(api, w, w.editor, "delete from pulse.doc_star where folder_id=%s returning id", (offer,))) == 1


def test_a_chosen_person_views_comments_or_edits(api, worker, team):
    w = team
    d = doc(api, w, w.editor, "Proposal for a synthetic client", access="people")
    one(api, w, w.editor, SHARE_DOC, (d, w.editor2, False, False))
    # View: reads it, but neither comments nor changes it.
    assert as_(api, w, w.editor2, "select id from pulse.doc where id=%s", (d,)) == [{"id": d}]
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        one(api, w, w.editor2, COMMENT, (d,))
    assert as_(api, w, w.editor2, "update pulse.doc set title='Changed' where id=%s returning id", (d,)) == []
    # Comment: comments, still no changes.
    one(api, w, w.editor, SHARE_DOC, (d, w.editor2, False, True))
    assert one(api, w, w.editor2, COMMENT, (d,))["id"]
    assert as_(api, w, w.editor2, "update pulse.doc set title='Changed' where id=%s returning id", (d,)) == []
    # Edit: changes it too.
    one(api, w, w.editor, SHARE_DOC, (d, w.editor2, True, False))
    assert as_(api, w, w.editor2, "update pulse.doc set title='Changed by the editor' where id=%s returning id", (d,)) == [{"id": d}]
    assert one(api, w, w.editor2, "select pulse.doc_id_can_comment(%s) v", (d,))["v"] is True
    # The owner always comments; someone it is not shared with neither sees nor comments.
    assert one(api, w, w.editor, COMMENT, (d,))["id"]
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        one(api, w, w.outsider, COMMENT, (d,))
    # Only the owner (or an admin) changes what a chosen person may do.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        one(api, w, w.editor2, SHARE_DOC, (d, w.outsider, True, True))
    # A company doc: everyone who sees it comments, as before.
    c = doc(api, w, w.editor, "Company notes")
    assert one(api, w, w.outsider, COMMENT, (c,))["id"]


def test_the_private_folders_above_a_folder_are_named_only_to_those_who_see_them(api, worker, team):
    w = team
    legal = folder(api, w, w.editor, "Legal", access="people")
    one(api, w, w.editor, SHARE_FOLDER, (legal, w.editor2))
    contracts = folder(api, w, w.editor, "Contracts", parent=legal)
    offer = folder(api, w, w.editor, "Offer")
    chain = "select pulse.doc_folder_private_chain(%s) v"
    assert one(api, w, w.editor, chain, (contracts,))["v"] == [legal]
    assert one(api, w, w.editor2, chain, (legal,))["v"] == [legal]
    assert one(api, w, w.editor, chain, (offer,))["v"] == []
    # Someone outside Legal learns nothing about it, an admin included.
    for who in (w.outsider, w.manager):
        assert one(api, w, who, chain, (contracts,))["v"] == [], who


def test_a_folder_never_goes_inside_itself_and_moves_follow_who_may_change_it(api, worker, team):
    w = team
    company = folder(api, w, w.editor, "Company")
    offer = folder(api, w, w.editor, "Offer", parent=company)
    stage = folder(api, w, w.editor, "Stage 2", parent=offer)
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        one(api, w, w.editor, "update pulse.doc_folder set parent_id=%s where id=%s returning id", (stage, company))
    # Nesting is allowed: Stage 2 moves to the top, then into Company again.
    assert one(api, w, w.editor, "update pulse.doc_folder set parent_id=null where id=%s returning id", (stage,))["id"] == stage
    assert one(api, w, w.editor, "update pulse.doc_folder set parent_id=%s where id=%s returning id", (company, stage))["id"] == stage
    # A colleague who did not make the folder does not move it (leadership and admins may).
    assert as_(api, w, w.outsider, "update pulse.doc_folder set parent_id=null where id=%s returning id", (stage,)) == []
    assert as_(api, w, w.manager, "update pulse.doc_folder set parent_id=null where id=%s returning id", (stage,)) == [{"id": stage}]


def test_another_companys_stars_and_recent_are_never_seen(api, worker, owner, team):
    w = team
    d = doc(api, w, w.editor, "Vision")
    one(api, w, w.editor, STAR_DOC, (w.editor, d))
    one(api, w, w.editor, RECENT, (w.editor, d))
    other = build_world(worker, owner, api)
    for who in (other.editor, other.manager):
        assert as_(api, other, who, "select id from pulse.doc_star") == []
        assert as_(api, other, who, "select doc_id from pulse.doc_recent") == []
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            one(api, other, who, STAR_DOC, (who, d))
