"""TEAM-TELEMETRY (21 Nov 2026): a project plan's "sent in chat" for each task (GET /api/v0/projects/:id/plan) reads the
task-card index through chat_task_card_first (migration 2496) instead of unpacking every message of the company. The new
query gives exactly the rows of the old one under the viewer's own row policies, on tricky synthetic chats: several
cards in one message, a removed message, a chat the viewer cannot read, an earlier and a later card, imported history.
Synthetic tenant only."""
import re
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from helpers import build_world
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant

SRC = Path(__file__).resolve().parents[2] / "services/api/src/project-plan.ts"
TZ = "(select pulse.org_time_zone())"
OLD = f"""select distinct on (a->>'task') a->>'task' task,ch.name channel,ch.kind,(select display_name from pulse.person where id=m.author_id) "by",
        (m.created_at at time zone {TZ})::date::text "on"
      from pulse.chat_message m cross join lateral jsonb_array_elements(case when jsonb_typeof(m.attachments)='array' then m.attachments else '[]'::jsonb end) a
      join pulse.chat_channel ch on ch.id=m.channel_id
      where m.removed_at is null and a ? 'task' and a->>'task'=any(%s::text[]) order by a->>'task',m.created_at"""


def new_sql():
    """The plan's query as the API sends it (read from project-plan.ts, so this test follows the code)."""
    m = re.search(r"const chats = tasks\.length \? \(await c\.query\(`(.*?)`, \[tasks\.map", SRC.read_text(), re.S)
    assert m, "the plan's chat query was not found in project-plan.ts"
    return m.group(1).replace("${ORG_TZ}", TZ).replace("$1", "%s")


def test_plan_task_chats_same_rows(worker, owner, api):
    w = build_world(worker, owner, api)
    t = [str(uuid.uuid4()) for _ in range(6)]
    seen, hidden, other = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    base = datetime(2026, 11, 1, 6, 0, tzinfo=timezone.utc)
    with owner.transaction():
        set_tenant(owner, w.org)
        for ch, name in ((seen, "Synthetic crew"), (hidden, "Synthetic leads only"), (other, "Synthetic second crew")):
            owner.execute("insert into pulse.chat_channel(org_id,id,key,name,kind) values(%s,%s,%s,%s,'custom')", (w.org, ch, f"g-{ch}", name))
            owner.execute("insert into pulse.chat_member(org_id,channel_id,person_id) values(%s,%s,%s)", (w.org, ch, w.lead))
            if ch != hidden:
                owner.execute("insert into pulse.chat_member(org_id,channel_id,person_id) values(%s,%s,%s)", (w.org, ch, w.editor))

        def say(ch, minutes, attachments, removed=False, imported=None):
            owner.execute("""insert into pulse.chat_message(org_id,channel_id,author_id,body,attachments,client_id,created_at,removed_at,import_ref)
                             values(%s,%s,%s,'',%s,gen_random_uuid(),%s,%s,%s)""",
                          (w.org, ch, w.lead, Jsonb(attachments), base + timedelta(minutes=minutes), base if removed else None, imported))

        card = lambda i: {"task": t[i], "name": "Synthetic card", "url": f"/tasks/{t[i]}"}
        say(seen, 10, [card(0), card(1), {"id": str(uuid.uuid4()), "name": "synthetic.pdf"}])   # two cards in one message
        say(other, 5, [card(1)])                                                                   # an earlier card for t1
        say(hidden, 1, [card(2)])                                                                  # a chat the editor cannot read
        say(other, 20, [card(2)])
        say(seen, 2, [card(3)], removed=True)                                                      # removed: never counted
        say(seen, 30, [card(3)])
        say(seen, 0, [card(5)], imported=uuid.uuid4())                                             # imported history
        say(seen, 70, [card(5)])
        say(seen, 40, [{"id": str(uuid.uuid4()), "name": "synthetic.png", "mime": "image/png"}])  # a file, no card
        say(seen, 50, [])
        for i in range(30):                                                                        # other tasks' cards
            say(other, 60 + i, [{"task": str(uuid.uuid4()), "name": "Synthetic filler"}])
    sql = new_sql()
    assert "chat_task_card_first" in sql
    for who in (w.editor, w.lead, w.manager):
        with api.transaction():
            set_tenant(api, w.org, who)
            old = sorted(api.execute(OLD, (t,)).fetchall(), key=lambda r: r["task"])
            new = sorted(api.execute(sql, (t,)).fetchall(), key=lambda r: r["task"])
        assert new == old
    with api.transaction():
        set_tenant(api, w.org, w.editor)
        rows = {r["task"]: r for r in api.execute(sql, (t,)).fetchall()}
    assert {t[0], t[1], t[2], t[3], t[5]} <= set(rows) and t[4] not in rows
    assert rows[t[1]]["channel"] == "Synthetic second crew"      # the earliest card wins
    assert rows[t[2]]["channel"] == "Synthetic second crew"      # the unreadable chat's card is not shown
