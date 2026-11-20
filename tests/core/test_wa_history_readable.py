"""SPEED-5 (2396) on real PostgreSQL: the imported chats search's history reads (pulse.wa_readable_chats, worked out once
for the list) are exactly the chats the per-chat rule gave (wa_reader or chat_browse, once per chat), for a member, a
colleague who is not a member, HR and leadership, an admin and an opted-in client contact, under each group setting
(members only, leaders, all staff); another company reads none of them. Every group and person here is synthetic."""

from pulse_sdk.db import set_tenant
from test_group_access import groups, readers

OLD = """select x.id from pulse_priv.wa_chat x where x.org_id = pulse.current_org()
  and (pulse.wa_reader(x.id) or pulse.chat_browse(x.channel_id)) order by 1"""
NEW = "select id from pulse.wa_readable_chats() id order by 1"


def both(owner, org, viewer):
    with owner.transaction():                       # as the definer functions run: the owner, this company and viewer
        set_tenant(owner, org, viewer)
        old = [r["id"] for r in owner.execute(OLD).fetchall()]
        new = [r["id"] for r in owner.execute(NEW).fetchall()]
    assert new == old, (viewer, new, old)
    return set(new)


def test_readable_chats_equal_the_per_chat_rule(worker, owner, api):
    w, g = groups((worker, owner, api))
    with owner.transaction():
        set_tenant(owner, w.org)
        imported = {r["id"] for r in owner.execute("select id from pulse_priv.wa_chat where org_id=%s", (w.org,)).fetchall()}
    assert imported                                  # the fixture's imported client group
    people = (w.editor, w.editor2, w.lead, w.manager, g["poc"])
    seen = {}
    for setting in ("members", "leaders", "staff"):
        if setting != "members":
            readers(api, w, w.manager, setting)
        seen[setting] = {p: both(owner, w.org, p) for p in people}
    assert seen["members"][w.manager] == imported    # an admin reads every imported chat
    assert seen["staff"][w.editor2] >= seen["members"][w.editor2]   # the setting only ever opens more
    other, _ = groups((worker, owner, api))
    assert not both(owner, other.org, other.editor) & imported      # another company: none of these
