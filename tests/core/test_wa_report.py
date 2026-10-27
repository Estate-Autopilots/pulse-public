"""WA-REPORT (1074) on real PostgreSQL: Insights → Reports. Leadership and admins read every page and the book; a
colleague reads their own page and its PDF and nothing else; evidence excerpts come only from imported chats the viewer
may read; every page read is audited; the tables are closed to the API. Every name, group and number here is synthetic."""

import hashlib
import json

import psycopg
import pytest
from pulse_sdk.db import set_tenant
from test_wa_import import begin, load, msg, world


def page(ed, key, part, sort, title, blocks=(), subject=None, evidence=None, md="Synthetic page"):
    return (ed, key, part, sort, title, None, f"Summary of {title}", subject[0] if subject else None, subject[1] if subject else None,
            json.dumps(list(blocks)), md, json.dumps(evidence or {}), title, md)


def test_reports_read_rules_search_excerpts_and_files(worker, owner, api):
    w, people = world(worker, owner, api)
    b = begin(owner, w, members=[w.editor], participants=people)
    load(owner, w, b["batchId"], [msg(1, "Synthetic: the leads are not connecting", sender="s-client1"), msg(2, "Synthetic: checking the targeting now")])
    with owner.transaction():
        set_tenant(owner, w.org)
        ids = [str(r["id"]) for r in owner.execute("select id from pulse_priv.wa_message where chat_id=%s order by seq", (b["chatId"],))]
        ed = owner.execute("""insert into pulse_priv.report_edition (org_id, version, title, built_at, pages_printed, chapters, status)
                              values (%s, 'synthetic/v1', 'Synthetic analysis', now(), 12, 4, 'current') returning id""", (w.org,)).fetchone()["id"]
        ev = {"m_synthetic01": [str(b["chatId"]), ids[0]]}
        rows = [page(ed, "company/overview", "company", 1, "Synthetic at a glance", [{"t": "md", "md": "Lead quality is the friction."}], md="Lead quality is the friction."),
                page(ed, f"person/{w.editor}", "people", 2, "Editor One", [{"t": "evidence", "items": [{"m": "m_synthetic01", "label": "complaint"}]}], ("person", str(w.editor)), ev),
                page(ed, f"person/{w.lead}", "people", 3, "Synthetic Leader", subject=("person", str(w.lead)), evidence=ev),
                page(ed, f"client/{w.client}", "clients", 4, "Synthetic Developers", subject=("client", str(w.client)), md="funds and lead quality")]
        owner.cursor().executemany("""insert into pulse_priv.report_page (org_id, edition_id, key, part, sort, title, subtitle, summary, subject_kind, subject_id, blocks, md, evidence, search)
                             values (pulse.current_org(), %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, to_tsvector('simple', %s || ' ' || %s))""", rows)
        book = b"%PDF-1.4 synthetic book " * 100
        for key, data in (("book.pdf", book), (f"slice:person/{w.editor}", b"%PDF-1.4 synthetic slice")):
            owner.execute("insert into pulse_priv.report_file (org_id, edition_id, key, mime, size, sha256, parts) values (%s,%s,%s,'application/pdf',%s,%s,2)",
                          (w.org, ed, key, len(data), hashlib.sha256(data).hexdigest()))
            half = len(data) // 2
            owner.execute("insert into pulse_priv.report_file_part (edition_id, key, n, data) values (%s,%s,0,%s), (%s,%s,1,%s)", (ed, key, data[:half], ed, key, data[half:]))

    with api.transaction():                                  # a colleague (a member of the chat): their own page only
        set_tenant(api, w.org, w.editor)
        idx = api.execute("select pulse.report_index('{}') r").fetchone()["r"]
        assert [i["key"] for i in idx["items"]] == [f"person/{w.editor}"] and idx["parts"] == {"people": 1}
        assert api.execute("select pulse.report_page('company/overview') r").fetchone()["r"] is None
        assert api.execute("select pulse.report_page(%s) r", (f"person/{w.lead}",)).fetchone()["r"] is None
        mine = api.execute("select pulse.report_page(%s) r", (f"person/{w.editor}",)).fetchone()["r"]
        assert mine["title"] == "Editor One" and mine["evidence"]["m_synthetic01"][1] == ids[0] and mine["hasPdf"] and mine["prev"] is None
        assert api.execute("select pulse.report_excerpts(%s) r", (f"person/{w.editor}",)).fetchone()["r"] == {"m_synthetic01": "Synthetic: the leads are not connecting"}
        assert api.execute("select pulse.report_subject('person', %s) r", (str(w.editor),)).fetchone()["r"]["key"] == f"person/{w.editor}"
        assert api.execute("select pulse.report_subject('client', %s) r", (str(w.client),)).fetchone()["r"] is None
        assert api.execute("select pulse.report_editions() r").fetchone()["r"] is None
        assert api.execute("select pulse.report_file_open('book.pdf') r").fetchone()["r"] is None
        assert api.execute("select count(*) n from pulse.report_file_parts('book.pdf', 0, 9)").fetchone()["n"] == 0
        assert api.execute("select pulse.report_file_open(%s) r", (f"slice:person/{w.editor}",)).fetchone()["r"]["parts"] == 2
        parts = api.execute("select data from pulse.report_file_parts(%s, 0, 9)", (f"slice:person/{w.editor}",)).fetchall()
        assert b"".join(bytes(p["data"]) for p in parts) == b"%PDF-1.4 synthetic slice"
        assert api.execute("select pulse.report_page_md('company/overview') r").fetchone()["r"] is None

    with api.transaction():                                  # HR without leadership: nothing (no page of their own)
        set_tenant(api, w.org, w.editor2)
        assert api.execute("select pulse.report_index('{}') r").fetchone()["r"]["items"] == []
        assert api.execute("select pulse.report_page(%s) r", (f"person/{w.editor}",)).fetchone()["r"] is None

    with api.transaction():                                  # leadership: everything, search; no excerpts from a chat they are not in
        set_tenant(api, w.org, w.lead)
        idx = api.execute("select pulse.report_index('{}') r").fetchone()["r"]
        assert idx["total"] == 4 and idx["edition"]["version"] == "synthetic/v1" and idx["parts"] == {"company": 1, "people": 2, "clients": 1}
        hits = api.execute("""select pulse.report_index('{"q":"lead quality"}') r""").fetchone()["r"]
        assert {i["key"] for i in hits["items"]} == {"company/overview", f"client/{w.client}"}
        p = api.execute("select pulse.report_page(%s) r", (f"person/{w.editor}",)).fetchone()["r"]
        assert p["next"]["key"] == f"person/{w.lead}" and p["prev"] is None
        assert api.execute("select pulse.report_excerpts(%s) r", (f"person/{w.editor}",)).fetchone()["r"] == {}
        assert api.execute("select pulse.report_file_open('book.pdf') r").fetchone()["r"]["size"] == len(book)
        assert api.execute("select pulse.report_page_md(%s) r", (f"client/{w.client}",)).fetchone()["r"] == "funds and lead quality"
        assert len(api.execute("select pulse.report_editions() r").fetchone()["r"]) == 1
    with owner.transaction():                                # every page read and download is audited (metadata only)
        set_tenant(owner, w.org)
        audited = owner.execute("select count(*) n from pulse.audit_event where resource in ('report_page','report_file') and actor_id = %s", (w.lead,)).fetchone()["n"]
        assert audited >= 3

    for table in ("report_edition", "report_page", "report_file", "report_file_part"):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            with api.transaction():
                set_tenant(api, w.org, w.lead)
                api.execute(f"select count(*) from pulse_priv.{table}")
