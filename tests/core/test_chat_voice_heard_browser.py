"""CHAT-VOICE-FIX parts 2-3 in the browser (services/api/test/voice-heard-runner.mjs): a voice note the server is sure
of shows its words, one it is not sure of says "Not clear — listen" with its English gist; find in a chat
finds a voice note by what it says and filters by type and person. Synthetic team, notes and words; nothing is sent
anywhere. Screenshots with PULSE_VOICE_SHOTS=<dir>."""
import json
import os
import subprocess
from pathlib import Path

import pytest
from test_chat_voice_heard import _heard, _note
from test_tasks_rt1 import one, team  # noqa: F401  (team is a fixture)


@pytest.mark.skipif(os.environ.get("PULSE_AUTH_BROWSER") != "1", reason="browser checks run in CI with PULSE_AUTH_BROWSER=1")
def test_unclear_notes_say_so_and_voice_notes_are_found_by_what_they_say(worker, owner, api, team, tmp_path):  # noqa: F811
    from conftest import dsn
    from psycopg.conninfo import conninfo_to_dict
    w = team
    one(api, w, w.editor, "select pulse.chat_refresh()")
    group = one(api, w, w.editor, "select pulse.chat_group_create('Site shoots',%s) id", ([w.editor2],))["id"]
    f1, clear = _note(api, w, group)
    f2, unclear = _note(api, w, group)
    words = "उद्या सकाळी अकरा वाजता साइटवर शूट आहे"
    _heard(worker, w, clear, f1, words, True)
    _heard(worker, w, unclear, f2, "garbled guess zqxv", False, gist="Send the new proposal to the client today")

    def config(value):
        d = conninfo_to_dict(value)
        d["database"] = d.pop("dbname")
        return json.dumps(d)
    ids = {"group": str(group), "clear": str(clear), "unclear": str(unclear), "clearWords": words, "gist": "Send the new proposal to the client today",
           "hiddenWords": "garbled guess zqxv", "searchWord": "साइटवर", "author": str(w.editor)}
    env = {**os.environ, "PULSE_CI": "1", "PULSE_PUBLIC_LOGIN_ENABLED": "0", "TEST_API_CONFIG": config(dsn("api")), "PULSE_ORG_ID": str(w.org),
           "TEST_LISTENER": f"editor2@{w.domain}", "TEST_IDS": json.dumps(ids, ensure_ascii=False), "PULSE_VOICE_REPORT": str(tmp_path / "heard.json")}
    p = subprocess.run(["node", "test/voice-heard-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api", env=env, capture_output=True, text=True, timeout=1200, check=False)
    assert p.returncode == 0, (p.stderr + p.stdout)[-6000:]
    report = json.loads((tmp_path / "heard.json").read_text())
    assert report["checks"] >= 14 and len(report["steps"]) == (4 if os.environ.get("PULSE_VOICE_SHOTS") else 3)
