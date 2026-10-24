"""CHATS-2 in the browser on a synthetic agency: the WhatsApp-style list and conversation, optimistic sends, quote
replies, reactions, Make a task, # task cards, groups, presence, the status dialog, Gmail-class e-mail (synthetic mail
through the real sanitiser) and Telegram/WhatsApp setup. Screenshots with PULSE_CHATS_SCREENSHOTS=<dir>.
Every person, message and mail here is invented; nothing is sent anywhere."""
import json
import os
import struct
import subprocess
import uuid
import zlib
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from pulse_sdk.db import set_tenant
from test_tasks_rt1 import as_, team  # noqa: F401  (team is a fixture)
from test_work_structure import _seed_showcase

IST = timezone(timedelta(hours=5, minutes=30))


def png(width, height, paint):
    """A small PNG without image libraries: paint(x, y) -> (r, g, b)."""
    raw = b"".join(b"\x00" + b"".join(bytes(paint(x, y)) for x in range(width)) for y in range(height))
    chunk = lambda kind, data: struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def portrait(hue):
    """An abstract portrait: a soft background, a head and shoulders. Recognisably a photo slot, never a real face."""
    import colorsys
    bg = [int(c * 255) for c in colorsys.hls_to_rgb(hue, 0.82, 0.45)]
    skin = [int(c * 255) for c in colorsys.hls_to_rgb(0.07 + hue * 0.03, 0.62, 0.42)]
    shirt = [int(c * 255) for c in colorsys.hls_to_rgb((hue + 0.5) % 1, 0.38, 0.5)]
    hair = [int(c * 255) for c in colorsys.hls_to_rgb(0.08, 0.18, 0.3)]

    def paint(x, y):
        dx, dy = x - 48, y - 40
        if dx * dx + (dy + 8) * (dy + 8) < 20 * 20 and dy < -6:
            return hair
        if dx * dx * 1.15 + dy * dy < 19 * 19:
            return skin
        if y > 66 and abs(dx) < 40 - (y - 66) * -0.9 and (dx * dx) / 1600 + ((y - 100) ** 2) / 1300 < 1:
            return shirt
        return bg
    return png(96, 96, paint)


def scene():
    """A synthetic 'first look' frame: dusk sky, a building, warm windows."""
    def paint(x, y):
        if 70 < x < 170 and y > 40 and not (y > 150):
            return (255, 214, 140) if (x // 12 + y // 14) % 3 == 0 and y < 140 else (58, 64, 92)
        if y > 150:
            return (46, 52, 70)
        t = y / 150
        return (int(250 - 120 * t), int(170 - 60 * t), int(120 + 60 * t))
    return png(240, 180, paint)


def _seed_chats(api, worker, owner, w):
    ids = _seed_showcase(api, worker, w)
    with worker.transaction():
        set_tenant(worker, w.org)
        people = {r["display_name"]: r["id"] for r in worker.execute("select id,display_name from pulse.person where org_id=%s", (w.org,))}
        profile = {"Kabir Shah": ("kabir", "Creative"), "Ahoro Rao": ("ahoro", "Creative"), "Dev Panab": ("dev", "Creative"), "Tara Nair": ("tara", "Creative"),
                   "Sana Khan": ("sana", "Production"), "Meera Iyer": ("meera", "Performance"), "Ishaan Vivim": ("ishaan", "Performance"),
                   "Vikram Seduh": ("vikram", "Sales"), "Neha Jivop": ("neha", "HR"), "Rila Kapoor": ("rila", "Leadership")}
        for name, (username, department) in profile.items():
            worker.execute("update pulse.people_profile set username=%s,department=%s where person_id=%s", (username, department, people[name]))
    P = {k.split()[0].lower(): people[k] for k in profile}
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("update pulse.hr_policy set attendance_enabled=true where org_id=%s", (w.org,))
        for n, name in enumerate(["ahoro", "meera", "sana", "rila", "dev"]):
            owner.execute("insert into pulse.person_photo(org_id,person_id,mime,bytes) values(%s,%s,'image/png',%s) on conflict(person_id) do update set bytes=excluded.bytes",
                          (w.org, P[name], portrait(n / 5)))
    now = datetime.now(IST)
    today = now.replace(hour=0, minute=0, second=0, microsecond=0)

    def at(days, h, m):
        """Earlier days at that time; today's 9:00 is four hours ago, so a run at any hour keeps today in the past."""
        if days == 0:
            return (now - timedelta(hours=4) + timedelta(hours=h - 9, minutes=m)).astimezone(timezone.utc)
        return (today + timedelta(days=days, hours=h, minutes=m)).astimezone(timezone.utc)

    def act(who, sql, params=()):
        with api.transaction():
            set_tenant(api, w.org, who)
            return api.execute(sql, params).fetchone()

    def say(who, channel, body, when, quote=None, attachments=None):
        mid = act(who, "select pulse.chat_send(%s,%s,null,%s,%s,%s) id", (channel, body, json.dumps(attachments or []), uuid.uuid4(), quote))["id"]
        with worker.transaction():
            set_tenant(worker, w.org)
            worker.execute("update pulse.chat_message set created_at=%s,updated_at=%s where id=%s", (when, when, mid))
        return mid

    def react(who, message, emoji):
        act(who, "select pulse.chat_react(%s,%s)", (message, emoji))

    act(P["kabir"], "select pulse.chat_refresh()")
    with api.transaction():
        set_tenant(api, w.org, P["kabir"])
        chan = {r["key"]: r["id"] for r in api.execute("select key,id from pulse.chat_channel")}
    pod1 = act(P["kabir"], "select id from pulse.chat_channel where kind='pod' and name='Pod 1'")["id"]
    creative = chan["team:creative"]
    dm = lambda a, b: act(P[a], "select pulse.chat_direct(%s) id", (P[b],))["id"]
    ahoro, meera, tara = dm("kabir", "ahoro"), dm("kabir", "meera"), dm("kabir", "tara")

    # A morning with the pod head: a frame, a quote, a reaction, a task card and its first update.
    say(P["ahoro"], ahoro, "Morning! Did the Sunrise lobby footage come in?", at(0, 9, 12))
    say(P["kabir"], ahoro, "Yes, 42 clips. Uploading to the Sunrise folder now.", at(0, 9, 15))
    frame = act(P["kabir"], "select pulse.chat_file_add(%s,'lobby-first-look.png','image/png',%s) id", (ahoro, scene()))["id"]
    look = say(P["kabir"], ahoro, "First look at the grade", at(0, 9, 16), attachments=[{"id": str(frame), "name": "lobby-first-look.png", "mime": "image/png"}])
    warm = say(P["ahoro"], ahoro, "Looks great. Warm it up a touch on the windows?", at(0, 9, 20), quote=look)
    react(P["kabir"], warm, "👍")
    ask = say(P["ahoro"], ahoro, "Also the client wants a 30-second cut for Instagram by Friday", at(0, 9, 21))
    with worker.transaction():
        set_tenant(worker, w.org)
        teaser = worker.execute("select id,title from pulse.task where title='Colour grade the teaser'").fetchone()
        drone = worker.execute("select id,title from pulse.task where title='Drone permit for Sunrise'").fetchone()
    say(P["kabir"], ahoro, "", at(0, 9, 30), quote=ask, attachments=[{"task": str(teaser["id"]), "name": teaser["title"], "url": f"/tasks/{teaser['id']}"}])
    act(P["kabir"], "select pulse.chat_task_follow_set(%s,%s,true)", (teaser["id"], ahoro))
    as_(api, w, P["kabir"], "select pulse.task_move(%s,'in_progress')", (teaser["id"],))
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.chat_message set created_at=%s where channel_id=%s and kind='event'", (at(0, 9, 31), ahoro))
    last = say(P["kabir"], ahoro, "On it. First cut by 4 pm 🎬", at(0, 9, 33))
    react(P["ahoro"], last, "🙏")

    # Pod 1: yesterday's review, today's ask with a mention and a task card.
    v2 = say(P["dev"], pod1, "Pushed the Northstar edit v2 to Drive. Notes welcome.", at(-1, 18, 5))
    fire = say(P["sana"], pod1, "Watched it, the drone opener is 🔥", at(-1, 18, 20), quote=v2)
    for who in ("ahoro", "kabir"):
        react(P[who], fire, "❤️")
    say(P["ahoro"], pod1, "@kabir can you check the drone permit before Monday's shoot? The site plan is in the folder.", at(0, 10, 2),
        attachments=[{"task": str(drone["id"]), "name": drone["title"], "url": f"/tasks/{drone['id']}"}])

    # A group people made, with a photo, pinned by Kabir.
    crew = act(P["ahoro"], "select pulse.chat_group_create('Sunrise shoot crew',%s) id", ([P["kabir"], P["sana"], P["dev"], P["tara"]],))["id"]
    act(P["ahoro"], "select pulse.chat_group_photo(%s,'image/png',%s)", (crew, png(64, 64, lambda x, y: (255 - x * 2, 140 + y, 90 + x))))
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.chat_message set created_at=%s where channel_id=%s and kind='event'", (at(-1, 16, 0), crew))
    say(P["ahoro"], crew, "Shoot is on Monday, 7 am at Sunrise Towers. Call time 6:30.", at(-1, 16, 1))
    say(P["sana"], crew, "I’ll bring the gimbal and two lights.", at(-1, 16, 10))
    shots = say(P["tara"], crew, "Can someone share the shot list?", at(-1, 16, 12))
    say(P["ahoro"], crew, "Here you go", at(-1, 16, 15), quote=shots, attachments=[{"url": "https://docs.google.com/document/d/synthetic-shot-list/edit", "name": "Sunrise shot list"}])
    act(P["kabir"], "select pulse.chat_pin(%s,true)", (crew,))

    brand = say(P["tara"], creative, "The Lakeview brand kit is updated. Use the new logo lockup from today.", at(-2, 12, 30))
    react(P["kabir"], brand, "👀")
    say(P["meera"], meera, "Hi Kabir, quick one: can you share the Lakeview reel in 9:16?", at(0, 11, 40))
    say(P["meera"], meera, "Need it for the ads team by 3.", at(0, 11, 41))
    thanks = say(P["tara"], tara, "Thanks for the help with the carousel!", at(-6, 17, 0))
    say(P["kabir"], tara, "Anytime 🙌", at(-6, 17, 4), quote=thanks)

    # Who has read what: Kabir is behind on Pod 1 (a mention) and Meera; Ahoro has read everything (blue ticks).
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.chat_member set read_through=now()")
        worker.execute("update pulse.chat_member set read_through=%s where person_id=%s and channel_id in (%s,%s)", (at(0, 9, 0), P["kabir"], pod1, meera))
        worker.execute("insert into pulse.chat_receipt(org_id,channel_id,person_id,delivered_through) select org_id,channel_id,person_id,now() from pulse.chat_member on conflict do nothing")
        # Presence today: in the office, from home, on a shoot, on a break, on leave, active, away.
        d = "(now() at time zone 'Asia/Kolkata')::date"
        for who, mode in (("kabir", "office"), ("ahoro", "office"), ("dev", "wfh"), ("sana", "field"), ("meera", "office"), ("rila", "office")):
            worker.execute(f"insert into pulse.attendance_entry(org_id,person_id,work_date,checked_in_at,mode) values(%s,%s,{d},now()-interval '3 hours',%s)", (w.org, P[who], mode))
        entry = worker.execute("select id from pulse.attendance_entry where person_id=%s", (P["meera"],)).fetchone()["id"]
        worker.execute("insert into pulse.attendance_break(org_id,entry_id,person_id,started_at) values(%s,%s,%s,now()-interval '10 minutes')", (w.org, entry, P["meera"]))
        worker.execute(f"insert into pulse.task(id,org_id,title,assignee_person_id,status,deliverable_type,work_on) values(%s,%s,'Lakeview walkthrough shoot',%s,'open','Video shoot',{d})", (uuid.uuid4(), w.org, P["sana"]))
        worker.execute(f"insert into pulse.leave_request(org_id,person_id,from_date,to_date,leave_kind,status) values(%s,%s,{d},{d},'casual','approved')", (w.org, P["tara"]))
        for who, ago in (("ishaan", 1), ("vikram", 25), ("neha", 2)):
            worker.execute("insert into pulse.person_status(org_id,person_id,last_active_at) values(%s,%s,now()-make_interval(mins=>%s)) on conflict(org_id,person_id) do update set last_active_at=excluded.last_active_at", (w.org, P[who], ago))
    act(P["ahoro"], "select pulse.presence_set('Client review till 4','📅',now()+interval '3 hours',null)")
    act(P["vikram"], "select pulse.presence_set(null,null,null,now()+interval '2 hours')")
    return {**ids, "people": {k: str(v) for k, v in P.items()}, "ahoroDm": str(ahoro), "meeraDm": str(meera), "pod1": str(pod1), "crew": str(crew), "teaser": str(teaser["id"])}


@pytest.mark.skipif(os.environ.get("PULSE_AUTH_BROWSER") != "1", reason="browser checks run in CI with PULSE_AUTH_BROWSER=1")
def test_chats_in_the_browser(worker, owner, api, team, tmp_path):  # noqa: F811
    from conftest import dsn
    from psycopg.conninfo import conninfo_to_dict
    w = team
    seeded = _seed_chats(api, worker, owner, w)

    def config(value):
        d = conninfo_to_dict(value)
        d["database"] = d.pop("dbname")
        return json.dumps(d)
    env = {**os.environ, "PULSE_CI": "1", "PULSE_PUBLIC_LOGIN_ENABLED": "0", "TEST_API_CONFIG": config(dsn("api")), "TEST_MEMBER": w.editor_handle,
           "TEST_HEAD": f"editor2@{w.domain}", "TEST_IDS": json.dumps(seeded), "PULSE_CHATS_REPORT": str(tmp_path / "chats.json")}
    p = subprocess.run(["node", "test/chats-browser-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api", env=env, capture_output=True, text=True, timeout=2400, check=False)
    assert p.returncode == 0, (p.stderr + p.stdout)[-6000:]
    report = json.loads((tmp_path / "chats.json").read_text())
    assert report["browserChecks"] >= 25


def test_synthetic_images_are_valid_png():
    for data in (portrait(0.3), scene()):
        assert data.startswith(b"\x89PNG") and len(data) < 400000
