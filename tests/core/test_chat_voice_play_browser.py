"""CHAT-VOICE-FIX in the browser (services/api/test/voice-play-runner.mjs): on a synthetic team, a voice note (an ffmpeg
tone, recorded the way Chrome's MediaRecorder writes it: no length) plays from a tap although every voice file answers
5 s late, under the autoplay policy real browsers apply; a browser without WebM/Opus (Safari, iPhone) gets the AAC copy;
a note that cannot play says so with Try again and Download. Nothing is sent anywhere. Shots: PULSE_VOICE_SHOTS=<dir>."""
import json
import os
import subprocess
import uuid
from pathlib import Path

import pytest
from test_chat_voice_play import _tone, _worker_module, needs_ffmpeg
from test_tasks_rt1 import one, team  # noqa: F401  (team is a fixture)


@needs_ffmpeg
@pytest.mark.skipif(os.environ.get("PULSE_AUTH_BROWSER") != "1", reason="browser checks run in CI with PULSE_AUTH_BROWSER=1")
def test_a_voice_note_plays_from_a_tap_on_a_slow_server(worker, owner, api, team, tmp_path):  # noqa: F811
    from conftest import dsn
    from psycopg.conninfo import conninfo_to_dict
    w = team
    one(api, w, w.editor, "select pulse.chat_refresh()")
    group = one(api, w, w.editor, "select pulse.chat_group_create('Voice notes',%s) id", ([w.editor2],))["id"]

    def send(data, seconds):
        fid = one(api, w, w.editor, "select pulse.chat_file_add(%s,'Voice message.webm','audio/webm',%s) id", (group, data))["id"]
        note = {"id": str(fid), "name": "Voice message.webm", "mime": "audio/webm", "voice": {"seconds": seconds, "peaks": [20 + (i * 37) % 80 for i in range(48)]}}
        mid = one(api, w, w.editor, "select pulse.chat_send(%s,'',null,%s,%s,null) id", (group, json.dumps([note]), uuid.uuid4()))["id"]
        return str(fid), str(mid)

    good_file, good = send(_tone(6), 6)
    broken_file, broken = send(b"\x1aE\xdf\xa3 not really audio", 4)
    _worker_module().playable(worker, w.org, limit=10)  # the server's worker makes the copies

    def config(value):
        d = conninfo_to_dict(value)
        d["database"] = d.pop("dbname")
        return json.dumps(d)
    ids = {"group": str(group), "good": good, "goodFile": good_file, "broken": broken, "brokenFile": broken_file}
    env = {**os.environ, "PULSE_CI": "1", "PULSE_PUBLIC_LOGIN_ENABLED": "0", "TEST_API_CONFIG": config(dsn("api")), "PULSE_ORG_ID": str(w.org),
           "TEST_LISTENER": f"editor2@{w.domain}", "TEST_IDS": json.dumps(ids), "PULSE_VOICE_REPORT": str(tmp_path / "voice.json")}
    p = subprocess.run(["node", "test/voice-play-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api", env=env, capture_output=True, text=True, timeout=1200, check=False)
    assert p.returncode == 0, (p.stderr + p.stdout)[-6000:]
    report = json.loads((tmp_path / "voice.json").read_text())
    assert report["checks"] >= 15 and len(report["steps"]) == (4 if os.environ.get("PULSE_VOICE_SHOTS") else 3)
