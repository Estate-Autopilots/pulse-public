"""CHAT-GROUPS in the browser (services/api/test/chat-groups-browser-runner.mjs): the Groups tab by category, New group,
Group info's settings, group requests, Settings → Chats, Report a bug posting into Bugs and support, and a project's
"Start the project's team chat". Phone 390, tablet 834, laptop 1440, light and dark. A synthetic company with invented
names only; nothing leaves it."""
import hashlib
import json
import os
import struct
import subprocess
import uuid
import zlib
from pathlib import Path

import pytest
from conftest import dsn
from psycopg.conninfo import conninfo_to_dict
from pulse_sdk.db import set_tenant
from test_tasks_rt1 import one, team  # noqa: F401  (team is a fixture)

def png(width=360, height=220):
    """A synthetic "screenshot" for the walk's bug report: a page with a header bar, two text lines and a blue button."""
    def px(x, y):
        if y < 34: return (38, 50, 74)
        if 60 <= y < 70 and 24 <= x < 250: return (150, 158, 172)
        if 84 <= y < 94 and 24 <= x < 200: return (190, 196, 206)
        if 150 <= y < 186 and 24 <= x < 140: return (44, 100, 199)
        return (246, 247, 249)
    raw = b"".join(b"\x00" + bytes(c for x in range(width) for c in px(x, y)) for y in range(height))
    chunk = lambda kind, data: struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)  # noqa: E731
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


PNG = png()


@pytest.mark.skipif(os.environ.get("PULSE_AUTH_BROWSER") != "1", reason="browser checks run in CI with PULSE_AUTH_BROWSER=1")
def test_chat_groups_in_the_browser(worker, owner, api, team):  # noqa: F811
    w = team                                    # manager: admin (the walk's admin); lead: HR; editor2: pod head; editor: staff
    with owner.transaction():
        set_tenant(owner, w.org)
        for pid, name in ((w.manager, "Ravi Menon"), (w.lead, "Kavya Rao"), (w.editor, "Rifob Das"), (w.editor2, "Tara Iyer"), (w.outsider, "Meera Jivop")):
            owner.execute("update pulse.person set display_name=%s where id=%s", (name, pid))
        cid = uuid.uuid4()
        owner.execute("insert into pulse.client(id,org_id,display_name) values(%s,%s,'Orchid Realty')", (cid, w.org))
        owner.execute("update pulse.project set name='Orchid Towers launch',title='Orchid Towers launch',kind='client_work',client_id=%s,lead_person_id=%s where id=%s", (cid, w.manager, w.project))
        empty = uuid.uuid4()
        owner.execute("""insert into pulse.project (id, org_id, registry_no, name, title, kind, client_id, lead_person_id, storage_root)
                         values (%s, %s, %s, 'Sunrise Heights', 'Sunrise Heights', 'client_work', %s, %s, 'gdrive:synthetic-sunrise')""", (empty, w.org, w.registry_no + 1, cid, w.manager))
    one(api, w, w.manager, "select pulse.chat_refresh()")
    one(api, w, w.manager, "select pulse.chat_groups_context()")                       # Bugs and support
    news = one(api, w, w.manager, "select pulse.chat_group_new(%s) r", (json.dumps({"name": "Company news", "description": "Office news, holidays and launches", "category": "announcements",
                                                                                     "icon": "megaphone", "colour": "violet", "members": [str(w.editor), str(w.editor2), str(w.lead), str(w.outsider)]}),))["r"]["id"]
    team_chat = one(api, w, w.manager, "select pulse.chat_project_group(%s) r", (w.project,))["r"]["id"]
    one(api, w, w.manager, "select pulse.chat_group_members(%s,%s,'{}')", (team_chat, [w.editor, w.editor2]))
    client = one(api, w, w.manager, "select pulse.chat_group_create('Orchid Realty × Studio', %s) id", ([w.editor2],))["id"]
    one(api, w, w.manager, "select pulse.chat_group_set(%s,%s)", ([client], json.dumps({"kind": "client", "clientId": str(cid)})))
    vendors = one(api, w, w.manager, "select pulse.chat_category_set(%s) r", (json.dumps({"name": "Vendors", "icon": "truck", "colour": "teal"}),))["r"]["id"]
    printers = one(api, w, w.manager, "select pulse.chat_group_new(%s) r", (json.dumps({"name": "Print vendors", "category": vendors, "members": [str(w.lead)]}),))["r"]["id"]
    desk = one(api, w, w.manager, "select pulse.chat_group_new(%s) r", (json.dumps({"name": "Design desk", "category": "teams", "icon": "palette", "colour": "green",
                                                                                     "members": [str(w.editor), str(w.editor2)]}),))["r"]["id"]
    lunch = one(api, w, w.editor, "select pulse.chat_group_create('Friday lunch', %s) id", ([w.manager, w.editor2],))["id"]
    say = lambda who, ch, text: one(api, w, who, "select pulse.chat_send(%s,%s,null,'[]',%s,null) id", (ch, text, uuid.uuid4()))["id"]  # noqa: E731
    say(w.manager, news, "The office is closed on Friday for the festival. Enjoy the long weekend!")
    say(w.editor2, team_chat, "Moodboard is up in the Orchid folder")
    say(w.editor, team_chat, "Cut 2 of the walkthrough is ready for review")
    say(w.editor2, client, "Sharing the brochure draft by 5 pm")
    say(w.lead, printers, "Quote for 500 brochures came in")
    say(w.editor2, lunch, "Biryani again?")
    say(w.editor, desk, "New brochure layouts are in the shared folder")
    # A bug report the editor posted into Bugs and support, with its picture.
    with api.transaction():
        set_tenant(api, w.org, w.editor)
        words = "The Save button on the task did nothing the first time I pressed it"
        rid = api.execute("""insert into pulse.reported_bug (org_id, number, person_id, command_id, words, route, fingerprint)
            select pulse.current_org(), coalesce(max(number), 0) + 1, %s, %s, %s, '/tasks', %s from pulse.reported_bug returning id""",
                          (w.editor, f"cmd-{uuid.uuid4().hex[:12]}", words, hashlib.sha256(words.encode()).hexdigest())).fetchone()["id"]
        api.execute("""insert into pulse.reported_bug_file (report_id, org_id, kind, content_type, bytes, sha256, data)
            values (%s, pulse.current_org(), 'screenshot', 'image/png', %s, %s, %s)""", (rid, len(PNG), hashlib.sha256(PNG).hexdigest(), PNG))
    bug = one(api, w, w.editor, "select pulse.chat_bug_post(%s, true) r", (rid,))["r"]
    one(api, w, w.editor2, "select pulse.chat_send(%s,'Same for me on the phone',%s,'[]',%s,null)", (bug["channelId"], bug["messageId"], uuid.uuid4()))
    # Managers and leadership make groups here: the editor asks for one, and it waits for the admin.
    one(api, w, w.manager, "select pulse.chat_group_policy_set('managers')")
    one(api, w, w.editor, "select pulse.chat_group_request_file(%s)", (json.dumps({"name": "Edit room", "description": "Editors swap cuts and notes", "category": "teams",
                                                                                     "members": [str(w.editor2)], "note": "For the Orchid edits"}),))
    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    env = {**os.environ, "PULSE_CI": "1", "TEST_API_CONFIG": json.dumps(config),
           "TEST_IDS": json.dumps({"org": str(w.org), "news": str(news), "bugs": bug["channelId"], "team": str(team_chat), "project": str(w.project), "empty": str(empty),
                                   "editor": w.editor_handle})}
    p = subprocess.run(["node", "test/chat-groups-browser-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api", env=env,
                       capture_output=True, text=True, timeout=2400, check=False)
    print(p.stdout[-6000:])
    assert p.returncode == 0, p.stderr[-4000:] + p.stdout[-4000:]
    assert "CHAT-GROUPS OK" in p.stdout
