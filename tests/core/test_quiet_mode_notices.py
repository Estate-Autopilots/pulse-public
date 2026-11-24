"""KAZUK-PREP (22 Nov 2026): a transaction that asks for no notices (pulse.notify_mode = 'none': the plan import's
notify:'none', a leadership set-up of a reconstructed project) gets none, also from work_notify ("You own a new client
project", "N steps are yours", "made you the owner", "dates moved"). Before 2524 only task.assigned honoured the mode.
The default and 'digest' still notify. Synthetic people only."""
from helpers import build_world
from pulse_sdk.db import set_tenant


def notices(worker, org, person):
    with worker.transaction():
        set_tenant(worker, org)
        return worker.execute("select count(*) n from pulse.notification where person_id=%s", (person,)).fetchone()["n"]


def as_admin(worker, w):
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'admin','2026-01-01')", (w.org, w.manager))


def test_naming_an_owner_in_quiet_mode_tells_nobody_and_still_names_them(api, worker, owner):
    w = build_world(worker, owner, api)
    as_admin(worker, w)
    made = {}
    for mode in ("", "digest", "none"):
        before = notices(worker, w.org, w.editor)
        with api.transaction():
            set_tenant(api, w.org, w.manager)
            api.execute("select set_config('pulse.notify_mode',%s,true)", (mode,))
            pid = api.execute("select pulse.work_project_save(null,%s::jsonb) r",
                              ('{"type":"internal","name":"Synthetic quiet %s","ownerId":"%s"}' % (mode or "default", w.editor),)).fetchone()["r"]["id"]
        with worker.transaction():
            set_tenant(worker, w.org)
            named = worker.execute("select owner_id from pulse.work_project where project_id=%s", (pid,)).fetchone()["owner_id"]
        made[mode or "default"] = (notices(worker, w.org, w.editor) - before, str(named))
    assert made["default"][0] == 1, "the default still tells the new owner"
    assert made["digest"][0] == 1, "digest mode is unchanged"
    assert made["none"][0] == 0, "notify_mode 'none' told the new owner anyway"
    assert made["default"][1] == str(w.editor) and made["none"][1] == str(w.editor), "the owner is named either way"
