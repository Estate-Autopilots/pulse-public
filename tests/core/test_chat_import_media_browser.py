"""CHAT-VOICE-FIX part 3 in the browser (services/api/test/chat-import-media-runner.mjs): Import WhatsApp chat from a
group's menu, with a .zip export made "with media"; its photo and voice note arrive beside their messages, the same
.zip again adds nothing, and the imported history shows them. The export, its people, the photo (an ffmpeg colour
frame) and the voice note (an ffmpeg tone) are synthetic; nothing is sent anywhere. Shots: PULSE_VOICE_SHOTS=<dir>."""
import json
import os
import shutil
import subprocess
import zipfile
from pathlib import Path

import pytest
from pulse_sdk.db import set_tenant
from test_chat_history_import import world

CHAT = """13/10/2026, 09:00 - Messages and calls are end-to-end encrypted. No one outside of this chat, not even WhatsApp, can read or listen to them.
13/10/2026, 09:01 - Pod Manager: Synthetic call sheet for the shoot
13/10/2026, 09:02 - Pod Manager: IMG-20261013-WA0001.jpg (file attached)
Site photo
13/10/2026, 09:03 - Editor One: PTT-20261013-WA0002.opus (file attached)
13/10/2026, 09:04 - Client Contact: Thanks, see you there
"""


def _ffmpeg(*args):
    return subprocess.run(["ffmpeg", "-v", "quiet", *args, "-"], capture_output=True, check=True).stdout


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="ffmpeg makes the synthetic photo and voice note")
@pytest.mark.skipif(os.environ.get("PULSE_AUTH_BROWSER") != "1", reason="browser checks run in CI with PULSE_AUTH_BROWSER=1")
def test_import_a_whatsapp_zip_with_media_from_the_group_menu(worker, owner, api, tmp_path):
    from conftest import dsn
    from psycopg.conninfo import conninfo_to_dict
    w, group = world(worker, owner, api)
    admin = f"manager@{w.domain}"
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.account (org_id, provider, handle, holder_person_id, purpose) values (%s, 'google', %s, %s, 'Workspace account')", (w.org, admin, w.manager))
    export = tmp_path / "WhatsApp Chat with Synthetic shoot crew.zip"
    with zipfile.ZipFile(export, "w") as z:
        z.writestr("_chat.txt", CHAT)
        z.writestr("IMG-20261013-WA0001.jpg", _ffmpeg("-f", "lavfi", "-i", "color=c=orange:s=160x120", "-frames:v", "1", "-f", "mjpeg"))
        z.writestr("PTT-20261013-WA0002.opus", _ffmpeg("-f", "lavfi", "-i", "sine=frequency=330:duration=2", "-c:a", "libopus", "-f", "ogg"))

    def config(value):
        d = conninfo_to_dict(value)
        d["database"] = d.pop("dbname")
        return json.dumps(d)
    ids = {"group": str(group), "senders": {"Pod Manager": str(w.manager), "Editor One": str(w.editor), "Client Contact": "kept"}}
    env = {**os.environ, "PULSE_CI": "1", "PULSE_PUBLIC_LOGIN_ENABLED": "0", "PULSE_CHAT_IMPORT": "1", "TEST_API_CONFIG": config(dsn("api")),
           "PULSE_ORG_ID": str(w.org), "TEST_ADMIN": admin, "TEST_ZIP": str(export), "TEST_IDS": json.dumps(ids), "PULSE_VOICE_REPORT": str(tmp_path / "import.json")}
    p = subprocess.run(["node", "test/chat-import-media-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api", env=env, capture_output=True, text=True, timeout=1200, check=False)
    assert p.returncode == 0, (p.stderr + p.stdout)[-6000:]
    report = json.loads((tmp_path / "import.json").read_text())
    assert report["checks"] >= 12 and len(report["steps"]) == (4 if os.environ.get("PULSE_VOICE_SHOTS") else 3)
    with owner.transaction():
        set_tenant(owner, w.org)
        kept = owner.execute("select f.name,f.mime,m.kind,m.body from pulse_priv.chat_import_file f join pulse_priv.chat_import_message m on m.id=f.message_id where f.channel_id=%s order by f.name", (group,)).fetchall()
    assert [(r["name"], r["mime"], r["kind"], r["body"]) for r in kept] == [("IMG-20261013-WA0001.jpg", "image/jpeg", "media", "Site photo"), ("PTT-20261013-WA0002.opus", "audio/ogg", "media", "")]
