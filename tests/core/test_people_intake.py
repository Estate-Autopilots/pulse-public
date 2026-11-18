"""SELLER-ONBOARD: a people intake end to end on a disposable tenant, with synthetic people only (migration 2226).

An admin opens an intake on a direct chat, with a task and a doc. The watched person then sends:
- plain talk;
- a pasted sheet (3 people: one new, one already in People found by number, one not active);
- another page of the list as a CSV file;
- a corrected copy of the sheet;
- a comment on the task;
and fills in the doc. Someone who is not watched also pastes a list.

The server's worker (tools/people-intake.py) reads each source and posts the preview cards. The approvers then confirm
through the API (services/api/test/people-intake-runner.mjs), which does People's own add and edit, makes the group
with its first steps pinned, keeps the hand-off list and sends the invitations. Here we check what is in the database
afterwards. Finally the worker writes the hand-off file and pins the tester link the other side answers with."""
import csv
import importlib.util
import json
import os
import stat
import subprocess
import uuid
from pathlib import Path

import pytest
from conftest import dsn
from helpers import build_world
from psycopg.conninfo import conninfo_to_dict
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant

ROOT = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location("people_intake_worker", ROOT / "tools" / "people-intake.py")
W = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(W)
HEAD = "Full name\tMobile (WhatsApp)\tGmail\tRole\tActive? + joining date\tReports to\tCity / area\tLanguages\tAndroid? + model"
SHEET = "\n".join([HEAD,
    "\t".join(["Ruvin Synthetic", "98765 43210", "user-a352ed12@gmail.com", "Sales executive", "Yes, 12 Aug 2025", "Synthetic Director", "Kothrud", "Hindi, Marathi", "Yes, Redmi Note 12"]),
    "Synthetic Existing\t9000000001\t\tTeam lead\tYes\tRuvin Synthetic\tPune\tMarathi\tSamsung A14",
    "\t".join(["Amit Synthetic", "9123456780", "user-7fcc527d@gmail.com", "Sales exec", "No", "", "Nashik", "Hindi", "iPhone 12"])])
PEOPLE = [("owner", "Synthetic Owner", "Technology partner", None), ("collector", "Synthetic Collector", "Business manager", None),
          ("existing", "Synthetic Existing", "Sales Executive", "+91 90000 00001"), ("director", "Synthetic Director", "Director", None),
          ("outsider", "Synthetic Outsider", "Editor", None)]


def as_(api, org, who, sql, args=()):
    with api.transaction():
        set_tenant(api, org, who)
        cur = api.execute(sql, args)
        return cur.fetchall() if cur.description else []


def one(api, org, who, sql, args=()):
    rows = as_(api, org, who, sql, args)
    return rows[0] if rows else None


def own(owner, org, sql, args=()):
    with owner.transaction():
        set_tenant(owner, org)
        cur = owner.execute(sql, args)
        return cur.fetchall() if cur.description else []


def _world(worker, owner, api):
    w = build_world(worker, owner, api)
    p = {k: uuid.uuid4() for k, *_ in PEOPLE}
    with worker.transaction():
        set_tenant(worker, w.org)
        for k, name, role, phone in PEOPLE:
            worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,%s,'staff')", (p[k], w.org, name))
            worker.execute("insert into pulse.people_profile(org_id,person_id,role,evidence,username,email,phone) values(%s,%s,%s,'{}',%s,%s,%s)",
                           (w.org, p[k], role, "synthetic." + k, k + "@people.example", phone))
            worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')", (w.org, k + "@people.example", p[k]))
        for k, r in [("owner", "admin"), ("collector", "admin"), ("collector", "hr")]:
            worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,%s,'2020-01-01')", (w.org, p[k], r))
    # Someone already in People who signs in: updated by the list, never invited again.
    as_(api, w.org, p["owner"], "select pulse.login_issue(%s,'Synthetic-account-2026!')", (p["existing"],))
    return w, p


def test_people_intake_from_chat_to_people_group_and_testers(worker, owner, api, tmp_path):
    w, p = _world(worker, owner, api)
    org = w.org
    dm = one(api, org, p["owner"], "select pulse.chat_direct(%s) id", (p["collector"],))["id"]
    task = one(api, org, p["owner"], "select pulse.task_save(null,%s) v", (Jsonb({"title": "Collect sellers' details", "assigneeId": str(p["collector"]), "dueOn": "2026-11-19"}),))["v"]
    doc = uuid.uuid4()
    own(owner, org, "insert into pulse.doc(org_id,id,title,body_html,created_by,updated_by) values(%s,%s,'Sellers: details to collect','<p>Fill in</p>',%s,%s)", (org, doc, p["owner"], p["owner"]))
    spec = {"channelId": str(dm), "taskId": str(task), "docId": str(doc), "title": "Sellers", "watchIds": [str(p["collector"])], "approverIds": [str(p["collector"])],
            "groupName": "Synthetic sales team", "appUrl": "https://app.people.example", "testerLabel": "Sales App", "handoff": "app-testers", "defaults": {"department": "Sales"},
            # Read from ten minutes ago, as production's reads from the message asking for the list.
            "since": own(owner, org, "select (now() - interval '10 minutes')::text t")[0]["t"]}
    # Who may open one, and where.
    with pytest.raises(Exception, match="Admins and HR collect"):
        as_(api, org, p["outsider"], "select pulse.people_intake_open(%s)", (Jsonb(spec),))
    with pytest.raises(Exception, match="active staff in the conversation"):
        as_(api, org, p["owner"], "select pulse.people_intake_open(%s)", (Jsonb({**spec, "watchIds": [str(p["outsider"])]}),))
    intake = one(api, org, p["owner"], "select pulse.people_intake_open(%s) v", (Jsonb(spec),))["v"]
    with pytest.raises(Exception, match="already reads this conversation"):
        as_(api, org, p["owner"], "select pulse.people_intake_open(%s)", (Jsonb(spec),))
    approvers = own(owner, org, "select approver_ids from pulse.people_intake where id=%s", (intake,))[0]["approver_ids"]
    assert set(approvers) == {p["collector"], p["owner"]}, "whoever opens it confirms too"

    def send(who, body, attachments="[]"):
        return one(api, org, p[who], "select pulse.chat_send(%s,%s,null,%s::jsonb,%s,null) id", (dm, body, attachments, str(uuid.uuid4())))["id"]

    talk = send("collector", "ok, collecting them now")
    first = send("collector", SHEET)
    page2 = b"Name,Mobile,Gmail,Role\nNeha Synthetic,9000076655,user-3acecfdd@gmail.com,SE\n"
    fid = one(api, org, p["collector"], "select pulse.chat_file_add(%s,'page2.csv','text/csv',%s) id", (dm, page2))["id"]
    csv_msg = send("collector", "", json.dumps([{"id": str(fid), "name": "page2.csv", "mime": "text/csv"}]))
    not_watched = send("owner", "Tara Synthetic, 9000010001, user-3ff1d222@gmail.com")
    W.run_once(worker, only=[org])
    batches = {str(r["source_id"]): r for r in own(owner, org, "select * from pulse.people_intake_batch where intake_id=%s", (intake,))}
    assert batches[str(talk)]["state"] == "empty" and batches[str(talk)]["message_id"] is None, "plain talk makes no card"
    assert str(not_watched) not in batches, "only the watched people are read"
    assert batches[str(first)]["state"] == "preview" and len(batches[str(first)]["rows"]) == 3
    assert batches[str(csv_msg)]["state"] == "preview" and batches[str(csv_msg)]["read_from"] == [{"kind": "csv", "name": "page2.csv"}]
    cards = own(owner, org, "select body, attachments from pulse.chat_message where channel_id=%s and kind='event' and attachments::text like '%%intake%%' order by created_at", (dm,))
    assert [c["body"] for c in cards] == ["sent the details of 3 sellers. Check them below, then confirm.", "sent the details of 1 seller. Check them below, then confirm."]
    told = own(owner, org, "select person_id from pulse.notification where title='Sellers to add: check and confirm' and channel_id=%s", (dm,))
    assert {r["person_id"] for r in told} == {p["owner"]} and len(told) == 2, "the other approver hears of each card, not the sender"
    # A corrected copy replaces the card it repeats people of; the other page keeps its own.
    corrected = send("collector", SHEET.replace("Kothrud", "Kothrud, Warje"))
    W.run_once(worker, only=[org])
    states = {str(r["source_id"]): r["state"] for r in own(owner, org, "select source_id,state from pulse.people_intake_batch where intake_id=%s", (intake,))}
    assert (states[str(first)], states[str(corrected)], states[str(csv_msg)]) == ("superseded", "preview", "preview")
    # The task's comment and the doc (quiet for a minute) are read too.
    own(owner, org, "insert into pulse.work_comment(org_id,task_id,author_id,body) values(%s,%s,%s,'Tara Synthetic - 9000010002 - user-3ff1d222@gmail.com - SE')", (org, task, p["collector"]))
    table = "<table><tr>" + "".join(f"<th>{h}</th>" for h in HEAD.split("\t")) + "</tr><tr><td>Uma Synthetic</td><td>9000010003</td><td>user-12974c67@gmail.com</td>" + "<td></td>" * 6 + "</tr></table>"
    own(owner, org, "update pulse.doc set body_html=%s where id=%s", (table, doc))
    own(owner, org, "update pulse.doc set updated_at=now()-interval '2 minutes', updated_by=%s where id=%s", (p["collector"], doc))
    W.run_once(worker, only=[org])
    by_source = {r["source"]: r for r in own(owner, org, "select * from pulse.people_intake_batch where intake_id=%s and source in ('comment','doc')", (intake,))}
    assert by_source["comment"]["state"] == "preview" and by_source["comment"]["rows"][0]["name"] == "Tara Synthetic"
    assert by_source["doc"]["state"] == "preview" and by_source["doc"]["rows"][0]["name"] == "Uma Synthetic"
    W.run_once(worker, only=[org])
    assert own(owner, org, "select count(*)::int n from pulse.people_intake_batch where intake_id=%s and source='doc'", (intake,))[0]["n"] == 1, "a doc is read once per change"

    # The approvers decide through the API.
    config = conninfo_to_dict(dsn("api")); config["database"] = config.pop("dbname")
    ids = {"list": str(batches[str(first)]["id"]), "corrected": None, "page2": str(batches[str(csv_msg)]["id"]), "doc": str(by_source["doc"]["id"])}
    ids["corrected"] = str(own(owner, org, "select id from pulse.people_intake_batch where source_id=%s", (corrected,))[0]["id"])
    env = {**os.environ, "TEST_API_CONFIG": json.dumps(config), "PULSE_ORG_ID": str(org), "TEST_IDS": json.dumps(ids), "PULSE_CI": "1"}
    env.pop("PULSE_GMAIL_SEND_ENABLED", None)
    run = subprocess.run(["node", "test/people-intake-runner.mjs"], cwd=ROOT / "services/api", env=env, text=True, capture_output=True, timeout=240)
    assert run.returncode == 0, run.stdout[-3000:] + run.stderr[-3000:]
    out = json.loads(run.stdout.strip().splitlines()[-1])
    group = out["group"]

    def person(name):
        return own(owner, org, """select p.id,p.status,pp.role,pp.department,pp.phone,pp.email,pp.joined_on::text joined,pp.work_location,pp.languages,pp.notes,
            (select display_name from pulse.person m where m.id=pp.manager_id) manager from pulse.person p join pulse.people_profile pp on pp.person_id=p.id
            where p.display_name=%s and p.org_id=%s""", (name, org))[0]

    ruvin, amit, existing, neha = person("Ruvin Synthetic"), person("Amit Synthetic"), person("Synthetic Existing"), person("Neha Synthetic")
    assert (ruvin["status"], ruvin["role"], ruvin["department"], ruvin["phone"], ruvin["email"], ruvin["joined"]) == (
        "active", "Sales Executive", "Sales", "+91 98765 43210", "user-a352ed12@gmail.com", "2025-08-12")
    assert (ruvin["work_location"], ruvin["languages"], ruvin["manager"]) == ("Kothrud, Warje", ["Hindi", "Marathi"], "Synthetic Director")
    assert "Phone: Android, Redmi Note 12" in ruvin["notes"]
    assert (amit["status"], amit["role"]) == ("inactive", "Sales Executive"), "not active: kept, not active"
    # Already in People: its sales title follows the list, its name and e-mail stay, its manager is a row of the same list.
    assert (existing["role"], existing["email"], existing["manager"], existing["work_location"]) == ("Sales Team Lead", "existing@people.example", "Ruvin Synthetic", "Pune")
    assert (neha["status"], neha["role"]) == ("active", "Sales Executive")
    changes = own(owner, org, "select count(*)::int n from pulse.record_change where entity_id=%s and changed_by=%s", (ruvin["id"], p["owner"]))[0]["n"]
    assert changes >= 6, "each field is in the person's history, by the approver"
    # The group: the current people of both lists, their manager, both approvers (who run it); the first steps pinned.
    members = {r["person_id"]: r["role"] for r in own(owner, org, "select person_id, role from pulse.chat_member where channel_id=%s", (group,))}
    assert set(members) == {ruvin["id"], existing["id"], neha["id"], p["director"], p["owner"], p["collector"]} and amit["id"] not in members
    assert members[p["owner"]] == members[p["collector"]] == "admin"
    pinned = own(owner, org, "select id, body from pulse.chat_message where channel_id=%s and pinned_at is not null", (group,))
    assert len(pinned) == 1 and "https://app.people.example" in pinned[0]["body"] and "tester list" in pinned[0]["body"]
    # Invitations: prepared for the new people who cannot sign in, as private links (this server mails none here).
    inv = {r["person_id"]: r["status"] for r in own(owner, org, "select person_id,status,token_hash is not null t from pulse_priv.staff_invitation where person_id = any(%s)",
                                                     ([ruvin["id"], amit["id"], existing["id"], neha["id"]],))}
    assert inv.get(ruvin["id"]) == "prepared" and inv.get(neha["id"]) == "sent", "Ruvin: a WhatsApp link; Neha: mailed (the runner switched mail on)"
    assert amit["id"] not in inv or inv[amit["id"]] == "prepared"
    # The chat says what was done; the hand-off list is kept for the worker.
    lines = [r["body"] for r in own(owner, org, "select body from pulse.chat_message where channel_id=%s and kind='event' and body like 'added %%' order by created_at", (dm,))]
    assert lines == ["added 2 and updated 1 sellers in Pulse. They are in the group “Synthetic sales team”.", "added 1 and updated 0 sellers in Pulse. They are in the group “Synthetic sales team”."]
    hand = own(owner, org, "select rows, state from pulse_priv.people_intake_handoff where intake_id=%s order by created_at", (intake,))
    assert [[r["gmail"] for r in h["rows"]] for h in hand] == [["user-a352ed12@gmail.com"], ["user-3acecfdd@gmail.com"]]

    # The worker writes the lists out and says READY; the other side answers; the tester link is pinned in the group.
    out_dir, note = tmp_path / "handoffs", tmp_path / "orchestrator.md"
    W.run_once(worker, out_dir=str(out_dir), note_file=str(note), only=[org])
    files = sorted((out_dir / "app-testers").glob("*.csv"), key=lambda f: (len(f.name), f.name))  # the day's first, then -2
    assert len(files) == 2 and stat.S_IMODE(files[0].stat().st_mode) == 0o600
    rows = list(csv.DictReader(files[0].open()))
    assert rows == [{"name": "Ruvin Synthetic", "gmail": "user-a352ed12@gmail.com", "phone": "+91 98765 43210", "role": "Sales Executive"}]
    assert note.read_text().count(" READY app-testers: ") == 2
    files[0].with_suffix(".answer.json").write_text(json.dumps({"optInUrl": "https://play.example/apps/testing/synthetic.app", "added": ["user-a352ed12@gmail.com"]}))
    W.run_once(worker, out_dir=str(out_dir), note_file=str(note), only=[org])
    pinned = own(owner, org, "select body from pulse.chat_message where channel_id=%s and pinned_at is not null", (group,))
    assert len(pinned) == 1 and "https://play.example/apps/testing/synthetic.app" in pinned[0]["body"], "the new first steps replace the old pin"
    assert own(owner, org, "select tester_optin_url from pulse.people_intake where id=%s", (intake,))[0]["tester_optin_url"] == "https://play.example/apps/testing/synthetic.app"
    assert own(owner, org, "select count(*)::int n from pulse.chat_message where channel_id=%s and body like 'The Sales App tester link is now pinned%%'", (dm,))[0]["n"] == 1
    assert " ANSWERED " in note.read_text()
    # An answer that cannot be used is said once as REFUSED (not at every poll), and read again once its file changes.
    def second_state():
        return own(owner, org, "select state from pulse_priv.people_intake_handoff where path=%s", (str(files[1]),))[0]["state"]
    bad = files[1].with_suffix(".answer.json")
    bad.write_text("{not json")
    for _ in range(2):
        W.run_once(worker, out_dir=str(out_dir), note_file=str(note), only=[org])
    assert note.read_text().count(" REFUSED ") == 1 and "cannot be read" in note.read_text() and second_state() == "written"
    bad.write_text(json.dumps({"optInUrl": "http://play.example/apps/testing/synthetic.app"}))
    os.utime(bad, ns=(bad.stat().st_mtime_ns + 10**9,) * 2)
    for _ in range(2):
        W.run_once(worker, out_dir=str(out_dir), note_file=str(note), only=[org])
    assert note.read_text().count(" REFUSED ") == 2 and "must be an https address" in note.read_text() and second_state() == "written"
    assert len(own(owner, org, "select 1 from pulse.chat_message where channel_id=%s and pinned_at is not null", (group,))) == 1
    bad.unlink()
    # An answer with no https link in it is noted and nothing changes.
    files[1].with_suffix(".answer.txt").write_text("javascript:alert(1)")
    W.run_once(worker, out_dir=str(out_dir), note_file=str(note), only=[org])
    assert own(owner, org, "select state from pulse_priv.people_intake_handoff where path=%s", (str(files[1]),))[0]["state"] == "answered", "no link: noted, nothing pinned"
    assert len(own(owner, org, "select 1 from pulse.chat_message where channel_id=%s and pinned_at is not null", (group,))) == 1


def test_the_opener_is_watched_too_once_added(worker, owner, api):
    """Owner, 18 Nov 2026 (DOCS-ACTIVITY-2): the Willow Lane sellers intake reads what Savuzo sends as well as Sakobe.
    Whose messages are read is the intake's own watch_ids (people_intake_pending), so production's change is one line on
    that row: the opener added. Then the opener's own request, sent at the intake's start, is a silent read (plain talk:
    no card, nobody told), and a list the opener pastes makes a card that the other approver hears of."""
    w, p = _world(worker, owner, api)
    org = w.org
    dm = one(api, org, p["owner"], "select pulse.chat_direct(%s) id", (p["collector"],))["id"]

    def send(who, body):
        return one(api, org, p[who], "select pulse.chat_send(%s,%s,null,'[]'::jsonb,%s,null) id", (dm, body, str(uuid.uuid4())))["id"]

    ask = send("owner", "Please send each seller's full name, mobile (WhatsApp), Gmail and role, in this chat or in the doc.")
    since = own(owner, org, "select (created_at - interval '1 millisecond')::text t from pulse.chat_message where id=%s", (ask,))[0]["t"]
    intake = one(api, org, p["owner"], "select pulse.people_intake_open(%s) v", (Jsonb({"channelId": str(dm), "title": "Sellers", "watchIds": [str(p["collector"])],
        "approverIds": [str(p["collector"])], "since": since}),))["v"]
    W.run_once(worker, only=[org])
    assert own(owner, org, "select count(*)::int n from pulse.people_intake_batch where intake_id=%s", (intake,))[0]["n"] == 0, "only the collector is watched"
    own(owner, org, "update pulse.people_intake set watch_ids = array_append(watch_ids, %s) where id=%s", (p["owner"], intake))
    W.run_once(worker, only=[org])
    read = own(owner, org, "select state, message_id from pulse.people_intake_batch where intake_id=%s and source_key=%s", (intake, str(ask)))
    assert [(r["state"], r["message_id"]) for r in read] == [("empty", None)], "the opener's request is read as plain talk and posts nothing"
    pasted = send("owner", SHEET)
    W.run_once(worker, only=[org])
    card = own(owner, org, "select state, author_id, jsonb_array_length(rows) n from pulse.people_intake_batch where intake_id=%s and source_key=%s", (intake, str(pasted)))
    assert [(r["state"], r["author_id"], r["n"]) for r in card] == [("preview", p["owner"], 3)]
    told = own(owner, org, "select person_id from pulse.notification where title='Sellers to add: check and confirm' and channel_id=%s", (dm,))
    assert [r["person_id"] for r in told] == [p["collector"]], "the other approver hears of the opener's card"
