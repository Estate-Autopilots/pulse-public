"""Synthetic design-export claim eligibility and two-viewer RLS coverage."""

from __future__ import annotations

import uuid

from pulse_sdk.db import set_tenant

from helpers import build_world, drive_id


def test_shared_design_claim_is_single_viewer_visible_and_manager_decidable(worker, owner, api):
    w = build_world(worker, owner, api)
    shared_file = drive_id()
    credited_file = drive_id()
    client_file = drive_id()
    unsupported_file = drive_id()
    with worker.transaction():
        set_tenant(worker, w.org)
        for person_id, role in ((w.editor, "Graphic Designer"), (w.editor2, "Graphic Designer"),
                                (w.manager, "Manager")):
            worker.execute("insert into pulse.people_profile(org_id,person_id,role,evidence) values (%s,%s,%s,'test')",
                           (w.org, person_id, role))
        worker.execute("update pulse.people_profile set manager_id=%s where person_id=%s", (w.manager, w.editor))
        worker.execute("insert into pulse.task(id,org_id,project_id,title,assignee_person_id) values (%s,%s,%s,'Synthetic design task',%s)",
                       (uuid.uuid4(), w.org, w.project, w.editor))
        worker.execute("insert into pulse.account(org_id,provider,handle,is_shared) values (%s,'google','client@example.test',false)",
                       (w.org,))
        rows = [
            (shared_file, "shared.png", "image/png", w.shared_handle, "last modifying account"),
            (credited_file, "credited.psd", "image/vnd.adobe.photoshop", w.shared_handle, "last modifying account"),
            (client_file, "client.png", "image/png", "client@example.test", "last modifying account"),
            (unsupported_file, "readme.txt", "text/plain", w.shared_handle, "last modifying account"),
        ]
        for file_id, name, mime, uploader, basis in rows:
            worker.execute("""insert into pulse.index_file(org_id,file_id,name,mime,path,project_id,uploader_account,
                           account_basis,created_at,observed_at,event_seq)
                           values (%s,%s,%s,%s,'Synthetic project/Single Image',%s,%s,%s,now(),now(),1)""",
                           (w.org, file_id, name, mime, w.project, uploader, basis))

        # Add a synthetic individually resolved delivery attribution for one shared export.
        file_uuid, asset_uuid, version_uuid = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        worker.execute("""insert into pulse.file(id,org_id,store,store_id,name,mime,first_seq,last_seq)
                       values (%s,%s,'gdrive',%s,'credited.psd','image/vnd.adobe.photoshop',1,1)""",
                       (file_uuid, w.org, credited_file))
        worker.execute("""insert into pulse.asset(id,org_id,project_id,legacy_key,deliverable_type,first_seq)
                       values (%s,%s,%s,%s,'unknown',1)""", (asset_uuid, w.org, w.project, f"file:gdrive:{credited_file}"))
        worker.execute("""insert into pulse.version(id,org_id,asset_id,version_no,kind,file_id,created_at,creator_person_id)
                       values (%s,%s,%s,1,'final',%s,now(),%s)""", (version_uuid, w.org, asset_uuid, file_uuid, w.editor))
        worker.execute("""insert into pulse.attribution(org_id,event_seq,event_time,version_id,person_id,probability,method,
                       resolver_version,evidence,decided_at)
                       values (%s,9001,now(),%s,%s,1,'manual','delivery-attribution/v1','[]',now())""",
                       (w.org, version_uuid, w.editor))

    with api.transaction():
        set_tenant(api, w.org, w.editor)
        assert api.execute("select pulse.design_claim_allowed(%s) allowed", (shared_file,)).fetchone()["allowed"] is True
        assert api.execute("select pulse.design_claim_allowed(%s) allowed", (credited_file,)).fetchone()["allowed"] is False
        assert api.execute("select pulse.design_claim_allowed(%s) allowed", (client_file,)).fetchone()["allowed"] is False
        assert api.execute("select pulse.design_claim_allowed(%s) allowed", (unsupported_file,)).fetchone()["allowed"] is False
        claim_id = api.execute("""insert into pulse.delivery_claim(org_id,file_id,person_id,claim_scope)
                                values (%s,%s,%s,'design') returning id""",
                               (w.org, shared_file, w.editor)).fetchone()["id"]
        assert api.execute("select count(*) n from pulse.delivery_claim where id=%s", (claim_id,)).fetchone()["n"] == 1

    with api.transaction():
        set_tenant(api, w.org, w.editor2)
        assert api.execute("select count(*) n from pulse.delivery_claim where id=%s", (claim_id,)).fetchone()["n"] == 0
        assert api.execute("select pulse.design_claim_allowed(%s) allowed", (shared_file,)).fetchone()["allowed"] is False

    with api.transaction():
        set_tenant(api, w.org, w.manager)
        assert api.execute("select pulse.manages(%s) ok", (w.editor,)).fetchone()["ok"] is True
        assert api.execute("select count(*) n from pulse.delivery_claim where id=%s", (claim_id,)).fetchone()["n"] == 1
        assert api.execute("update pulse.delivery_claim set status='confirmed',decided_by=%s,decided_at=now() where id=%s",
                           (w.manager, claim_id)).rowcount == 1


def test_confirmed_design_claim_person_is_viewer_independent(worker, owner, api):
    w = build_world(worker, owner, api)
    leadership_id, other_manager_id, other_pod = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    files = {key: drive_id() for key in ("confirmed", "pending", "rejected", "delivery")}
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,'Synthetic Leadership','staff')",
                       (leadership_id, w.org))
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'leadership','2026-01-01')",
                       (w.org, leadership_id))
        worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,'Synthetic Other Manager','staff')",
                       (other_manager_id, w.org))
        worker.execute("insert into pulse.unit(id,org_id,kind,name) values(%s,%s,'pod','Pod 2')", (other_pod, w.org))
        worker.execute("""insert into pulse.role_assignment(org_id,person_id,unit_id,role_key,is_manager_of_unit,valid_from)
                          values(%s,%s,%s,'manager',true,'2026-01-01')""", (w.org, other_manager_id, other_pod))
        for file_id in files.values():
            worker.execute("""insert into pulse.index_file(org_id,file_id,name,mime,path,project_id,uploader_account,
                           account_basis,created_at,observed_at,event_seq)
                           values(%s,%s,'Synthetic claimed design.psd','image/vnd.adobe.photoshop',
                             'Synthetic project/Designs',%s,%s,'last modifying account',now(),now(),1)""",
                           (w.org, file_id, w.project, w.shared_handle))
    with owner.transaction():
        set_tenant(owner, w.org)
        for key, status, scope in (("confirmed", "confirmed", "design"),
                                   ("pending", "pending", "design"),
                                   ("rejected", "rejected", "design"),
                                   ("delivery", "confirmed", "delivery")):
            owner.execute("""insert into pulse.delivery_claim(org_id,file_id,person_id,claim_scope,status,decided_by,decided_at)
                             values(%s,%s,%s,%s,%s,%s,case when %s='pending' then null else now() end)""",
                          (w.org, files[key], w.editor, scope, status,
                           None if status == "pending" else w.manager, status))

    for viewer in (leadership_id, other_manager_id):
        with api.transaction():
            set_tenant(api, w.org, viewer)
            if viewer == other_manager_id:
                assert api.execute("select pulse.viewer_is('manager') manager,pulse.manages(%s) manages",
                                   (w.editor,)).fetchone() == {"manager": True, "manages": False}
            else:
                assert api.execute("select pulse.viewer_is('leadership') leadership").fetchone()["leadership"] is True
            credited = api.execute("select pulse.design_claim_person(%s) person", (files["confirmed"],)).fetchone()["person"]
            assert credited == w.editor
            for key in ("pending", "rejected", "delivery"):
                assert api.execute("select pulse.design_claim_person(%s) person", (files[key],)).fetchone()["person"] is None
