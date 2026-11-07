"""DOCS-WORKBENCH (1686): the company's docs, folders, files, sharing, comments, mentions and version history, enforced by
the database under forced row security. Synthetic tenants and words only."""
import psycopg
import pytest
from test_tasks_rt1 import as_, new_task, one, team  # noqa: F401  (team is a fixture)

DOC = "insert into pulse.doc(org_id,title,body_html,body_text,access,created_by) values(pulse.current_org(),%s,%s,'',%s,pulse.current_viewer()) returning id"
TABLES = ("doc", "doc_comment", "doc_file", "doc_folder", "doc_mention", "doc_share", "doc_version")


def doc(api, w, who, title, access="private", html="<p>Synthetic words</p>"):
    return one(api, w, who, DOC, (title, html, access))["id"]


def seen(api, w, who):
    return {r["id"] for r in as_(api, w, who, "select id from pulse.doc")}


def test_tables_force_row_security_with_a_tenant_policy(worker):
    rows = worker.execute("""select c.relname,c.relrowsecurity,c.relforcerowsecurity,
        exists(select 1 from pg_policy p where p.polrelid=c.oid and p.polname='tenant_isolation') tenant
      from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='pulse' and c.relname = any(%s) order by 1""", (list(TABLES),)).fetchall()
    assert [(r["relname"], r["relrowsecurity"], r["relforcerowsecurity"], r["tenant"]) for r in rows] == [(t, True, True, True) for t in TABLES]


def test_private_company_and_chosen_people(api, worker, team):
    w = team
    private = doc(api, w, w.editor, "My private notes")
    company = doc(api, w, w.editor, "Studio handbook", "company")
    chosen = doc(api, w, w.editor, "Plan for two", "people")
    # Private is the owner's alone (admins included out); the company's is everyone's; chosen people see what is shared.
    assert seen(api, w, w.editor) >= {private, company, chosen}
    assert private not in seen(api, w, w.manager) and company in seen(api, w, w.manager)
    assert seen(api, w, w.outsider) & {private, company, chosen} == {company}
    one(api, w, w.editor, "insert into pulse.doc_share(org_id,doc_id,person_id,can_edit,added_by) values(pulse.current_org(),%s,%s,false,pulse.current_viewer()) returning doc_id",
        (chosen, w.outsider))
    assert chosen in seen(api, w, w.outsider)
    # Read-only share: the outsider cannot change it; with can_edit they can.
    assert as_(api, w, w.outsider, "update pulse.doc set title='Changed' where id=%s returning id", (chosen,)) == []
    as_(api, w, w.editor, "update pulse.doc_share set can_edit=true where doc_id=%s and person_id=%s returning doc_id", (chosen, w.outsider))
    assert as_(api, w, w.outsider, "update pulse.doc set title='Changed' where id=%s returning version", (chosen,))[0]["version"] == 2
    # Only the owner (or an admin) shares or archives; a company doc's editor cannot make it private.
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="shared with"):
        as_(api, w, w.outsider, "update pulse.doc set access='private' where id=%s returning id", (company,))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.outsider, "insert into pulse.doc_share(org_id,doc_id,person_id,added_by) values(pulse.current_org(),%s,%s,pulse.current_viewer()) returning doc_id",
            (company, w.editor2))
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="archives"):
        as_(api, w, w.outsider, "update pulse.doc set archived_at=now() where id=%s returning id", (company,))
    # A read-only company doc: everyone reads, only the owner (and admins) change it.
    as_(api, w, w.editor, "update pulse.doc set company_edits=false where id=%s returning id", (company,))
    assert as_(api, w, w.outsider, "update pulse.doc set title='Nope' where id=%s returning id", (company,)) == []
    assert as_(api, w, w.manager, "update pulse.doc set title='Handbook (admin)' where id=%s returning id", (company,)) != []
    # Nobody takes over a doc.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor, "update pulse.doc set created_by=%s where id=%s returning id", (w.outsider, private))


def test_version_history_keeps_sessions_and_restores(api, worker, team):
    w = team
    d = doc(api, w, w.editor, "Draft", "company", "<p>one</p>")
    as_(api, w, w.editor, "update pulse.doc set body_html='<p>two</p>' where id=%s returning id", (d,))
    as_(api, w, w.editor, "update pulse.doc set body_html='<p>three</p>' where id=%s returning id", (d,))
    # One person's autosaves within ten minutes are one version; another person's edit is a new one.
    rows = as_(api, w, w.editor, "select version,body_html,reason from pulse.doc_version where doc_id=%s order by saved_at", (d,))
    assert [(r["version"], r["body_html"], r["reason"]) for r in rows] == [(3, "<p>three</p>", "create")]
    as_(api, w, w.outsider, "update pulse.doc set body_html='<p>four</p>' where id=%s returning id", (d,))
    assert len(as_(api, w, w.editor, "select id from pulse.doc_version where doc_id=%s", (d,))) == 2
    # Versions are read with the doc and are never written directly.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor, "insert into pulse.doc_version(org_id,doc_id,version,title,body_html) values(pulse.current_org(),%s,9,'x','x') returning id", (d,))
    private = doc(api, w, w.editor, "Private draft")
    assert as_(api, w, w.outsider, "select id from pulse.doc_version where doc_id=%s", (private,)) == []


def test_mentions_comments_and_files_follow_the_doc(api, worker, team):
    w = team
    t = new_task(api, w, w.editor, title="Cut the synthetic reel")
    private = doc(api, w, w.editor, "Mentions the reel")
    company = doc(api, w, w.editor, "Also mentions the reel", "company")
    for d in (private, company):
        one(api, w, w.editor, "insert into pulse.doc_mention(org_id,doc_id,kind,ref_id,label) values(pulse.current_org(),%s,'task',%s,'Cut the synthetic reel') returning doc_id", (d, t))
    backlinks = lambda who: {r["doc_id"] for r in as_(api, w, who, "select doc_id from pulse.doc_mention where kind='task' and ref_id=%s", (t,))}  # noqa: E731
    assert backlinks(w.editor) == {private, company}
    assert backlinks(w.outsider) == {company}
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        one(api, w, w.outsider, "insert into pulse.doc_mention(org_id,doc_id,kind,ref_id) values(pulse.current_org(),%s,'task',%s) returning doc_id", (private, t))
    with pytest.raises(psycopg.errors.CheckViolation):
        one(api, w, w.editor, "insert into pulse.doc_mention(org_id,doc_id,kind,ref_id) values(pulse.current_org(),%s,'weapon',%s) returning doc_id", (company, t))
    # Comments: anyone who reads it comments; the writer takes theirs back; private docs take no outside comments.
    c = one(api, w, w.outsider, "insert into pulse.doc_comment(org_id,doc_id,person_id,body) values(pulse.current_org(),%s,pulse.current_viewer(),'Looks good') returning id", (company,))["id"]
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        one(api, w, w.outsider, "insert into pulse.doc_comment(org_id,doc_id,person_id,body) values(pulse.current_org(),%s,pulse.current_viewer(),'Peek') returning id", (private,))
    assert as_(api, w, w.editor2, "update pulse.doc_comment set removed_at=now() where id=%s and person_id=pulse.current_viewer() returning id", (c,)) == []
    assert as_(api, w, w.editor, "update pulse.doc_comment set resolved_at=now() where id=%s returning id", (c,)) != []
    # A file inside a private doc is the doc's; a folder's file is every staff member's; files are size-capped.
    f = one(api, w, w.editor, """insert into pulse.doc_file(org_id,doc_id,name,mime,size,sha256,bytes,added_by)
      values(pulse.current_org(),%s,'shot.png','image/png',3,'x','\\x010203',pulse.current_viewer()) returning id""", (private,))["id"]
    assert as_(api, w, w.outsider, "select id from pulse.doc_file where id=%s", (f,)) == []
    folder = one(api, w, w.editor, "insert into pulse.doc_folder(org_id,name,created_by) values(pulse.current_org(),'Synthetic briefs',pulse.current_viewer()) returning id")["id"]
    g = one(api, w, w.editor, """insert into pulse.doc_file(org_id,folder_id,name,mime,size,sha256,bytes,added_by)
      values(pulse.current_org(),%s,'deck.pdf','application/pdf',3,'x','\\x010203',pulse.current_viewer()) returning id""", (folder,))["id"]
    assert as_(api, w, w.outsider, "select id from pulse.doc_file where id=%s", (g,)) != []
    with pytest.raises(psycopg.errors.CheckViolation):
        one(api, w, w.editor, """insert into pulse.doc_file(org_id,folder_id,name,mime,size,sha256,bytes,added_by)
          values(pulse.current_org(),%s,'big.bin','application/octet-stream',20000000,'x','\\x01',pulse.current_viewer()) returning id""", (folder,))
    # Folders cannot loop.
    sub = one(api, w, w.editor, "insert into pulse.doc_folder(org_id,name,parent_id,created_by) values(pulse.current_org(),'Inside',%s,pulse.current_viewer()) returning id", (folder,))["id"]
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        as_(api, w, w.editor, "update pulse.doc_folder set parent_id=%s where id=%s returning id", (sub, folder))
