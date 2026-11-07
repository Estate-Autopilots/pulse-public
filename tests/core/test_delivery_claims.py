"""Synthetic coverage for delivery claim owner, manager, and colleague RLS."""

from __future__ import annotations

import uuid

from pulse_sdk.db import set_tenant

from helpers import build_world, drive_id


def test_claim_rows_are_self_visible_and_decidable_only_by_the_report_manager(worker, owner, api):
    w = build_world(worker, owner, api)
    file_id = drive_id()
    with worker.transaction():
        set_tenant(worker, w.org)
        for person_id, name, role in ((w.editor, "Synthetic Editor", "Video editor"),
                                      (w.editor2, "Synthetic Colleague", "Video editor"),
                                      (w.manager, "Synthetic Manager", "Manager")):
            worker.execute("insert into pulse.people_profile(org_id,person_id,role,evidence) values (%s,%s,%s,'test')",
                           (w.org, person_id, role))
        worker.execute("update pulse.people_profile set manager_id=%s where person_id=%s", (w.manager, w.editor))
        assert worker.execute("select manager_id from pulse.people_profile where person_id=%s", (w.editor,)).fetchone()["manager_id"] == w.manager
        worker.execute("insert into pulse.task(id,org_id,project_id,title,assignee_person_id) values (%s,%s,%s,'Synthetic editor task',%s)",
                       (uuid.uuid4(), w.org, w.project, w.editor))
        worker.execute("""insert into pulse.index_file(org_id,file_id,name,mime,path,project_id,uploader_account,account_basis,observed_at,event_seq)
                        values (%s,%s,'Synthetic walkthrough.mp4','video/mp4','Pilot project/Model Final Videos/Synthetic walkthrough.mp4',%s,%s,'synthetic',now(),1)""",
                       (w.org, file_id, w.project, w.shared_handle))
        worker.execute("""insert into pulse.delivery(org_id,file_id,project_id,uploader_account,kind,delivered_at,rule,rule_detail,event_seq)
                        values (%s,%s,%s,%s,'final',now(),'synthetic','Synthetic test delivery',1)""",
                       (w.org, file_id, w.project, w.shared_handle))
    with api.transaction():
        set_tenant(api, w.org, w.editor)
        claim = api.execute("insert into pulse.delivery_claim(org_id,file_id,person_id) values (%s,%s,%s) returning id",
                            (w.org, file_id, w.editor)).fetchone()
        claim_id = claim["id"]
        assert api.execute("select count(*) n from pulse.delivery_claim where id=%s", (claim_id,)).fetchone()["n"] == 1
    with api.transaction():
        set_tenant(api, w.org, w.editor2)
        assert api.execute("select count(*) n from pulse.delivery_claim where id=%s", (claim_id,)).fetchone()["n"] == 0
        assert api.execute("select pulse.delivery_claim_taken(%s) taken", (file_id,)).fetchone()["taken"] is True
        assert api.execute("select pulse.delivery_claim_taken(%s) taken", (drive_id(),)).fetchone()["taken"] is False
        assert api.execute("update pulse.delivery_claim set status='confirmed',decided_by=%s,decided_at=now() where id=%s",
                           (w.editor2, claim_id)).rowcount == 0
    with api.transaction():
        set_tenant(api, w.org, w.editor)
        assert api.execute("update pulse.delivery_claim set status='confirmed',decided_by=%s,decided_at=now() where id=%s",
                           (w.editor, claim_id)).rowcount == 0
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        manager_state = api.execute("select pulse.current_viewer() viewer,pulse.manages(%s) ok", (w.editor,)).fetchone()
        assert manager_state == {"viewer": w.manager, "ok": True}
        assert api.execute("select count(*) n from pulse.delivery_claim where id=%s", (claim_id,)).fetchone()["n"] == 1
        assert api.execute("update pulse.delivery_claim set status='confirmed',decided_by=%s,decided_at=now() where id=%s",
                           (w.manager, claim_id)).rowcount == 1
    with api.transaction():
        set_tenant(api, w.org, w.editor)
        row = api.execute("select status,credited_via from pulse.delivery_claim where id=%s", (claim_id,)).fetchone()
        assert (row["status"], row["credited_via"]) == ("confirmed", "claim")
