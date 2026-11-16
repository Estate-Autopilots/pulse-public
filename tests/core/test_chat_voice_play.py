"""CHAT-VOICE-FIX (owner, 14 Nov 2026: a voice note "does not play"): every audio chat file gets playable copies on the
server (migration 2107, tools/voice-transcribe.py): a WebM note remuxed so it has its length and cues, and an AAC copy
Safari and iPhones play; the original is kept. pulse.chat_voice_open serves a copy to whoever may read the note (as
chat_file_read), the original until the copy is there, and nothing to anybody else. Synthetic audio only (an ffmpeg
tone), written to a pipe as a MediaRecorder writes it: without a length."""
import importlib.util
import json
import shutil
import subprocess
import uuid
from pathlib import Path

import psycopg
import pytest
from pulse_sdk.db import set_tenant
from test_tasks_rt1 import as_, one, team  # noqa: F401  (team is a fixture)

ROOT = Path(__file__).resolve().parents[2]
needs_ffmpeg = pytest.mark.skipif(not (shutil.which("ffmpeg") and shutil.which("ffprobe")), reason="ffmpeg makes the copies")


def _worker_module():
    spec = importlib.util.spec_from_file_location("voice_transcribe", ROOT / "tools/voice-transcribe.py")
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def _tone(seconds=3):
    """A synthetic Opus WebM with no length in it (to a pipe, like Chrome's MediaRecorder)."""
    return subprocess.run(["ffmpeg", "-v", "quiet", "-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}", "-c:a", "libopus", "-b:a", "24k", "-f", "webm", "-"],
                          capture_output=True, check=True).stdout


def _length(data, suffix):
    p = Path(f"/tmp/pulse-voice-test-{uuid.uuid4()}{suffix}")
    try:
        p.write_bytes(data)
        out = subprocess.run(["ffprobe", "-v", "quiet", "-show_entries", "format=duration", "-of", "csv=p=0", str(p)], capture_output=True, text=True, check=False).stdout.strip()
        return float(out) if out and out != "N/A" else None
    finally:
        p.unlink(missing_ok=True)


def _note(api, w, data, mime="audio/webm"):
    one(api, w, w.editor, "select pulse.chat_refresh()")
    group = one(api, w, w.editor, "select pulse.chat_group_create('Voice play crew',%s) id", ([w.editor2],))["id"]
    fid = one(api, w, w.editor, "select pulse.chat_file_add(%s,'Voice message.webm',%s,%s) id", (group, mime, data))["id"]
    note = {"id": str(fid), "name": "Voice message.webm", "mime": mime, "voice": {"seconds": 3, "peaks": [10, 40, 90, 30]}}
    mid = one(api, w, w.editor, "select pulse.chat_send(%s,'',null,%s,%s,null) id", (group, json.dumps([note]), uuid.uuid4()))["id"]
    return group, fid, mid


def _open(api, w, who, fid, kind, audit=False):
    return one(api, w, who, "select name,mime,bytes,kind,seconds,original_mime from pulse.chat_voice_open(%s,%s,%s)", (fid, kind, audit))


def _downloads(worker, w, fid):
    with worker.transaction():
        set_tenant(worker, w.org)
        return worker.execute("select count(*)::int n from pulse.audit_event where action='download' and resource='chat_file' and resource_id=%s", (str(fid),)).fetchone()["n"]


def test_a_note_plays_from_its_copy_for_its_readers_only(api, worker, team):  # noqa: F811
    w = team
    original = b"\x1aE\xdf\xa3synthetic-webm-without-length"
    group, fid, _ = _note(api, w, original)
    # Before the worker: the original, for the sender and a member; nothing for someone outside the chat.
    for who in (w.editor, w.editor2):
        r = _open(api, w, who, fid, "webm")
        assert r["kind"] == "original" and bytes(r["bytes"]) == original and r["mime"] == "audio/webm"
    assert _open(api, w, w.outsider, fid, "webm") is None and _open(api, w, w.outsider, fid, "aac") is None
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        _open(api, w, w.editor2, fid, "mp3")
    # The worker's copies are served once they exist; a failed copy (no bytes) falls back to the original.
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse_priv.chat_file_play(org_id,file_id,kind,mime,bytes,seconds) values(%s,%s,'webm','audio/webm',%s,3.0)", (w.org, fid, b"remuxed"))
        worker.execute("insert into pulse_priv.chat_file_play(org_id,file_id,kind,mime,error) values(%s,%s,'aac','audio/mp4','ffmpeg failed')", (w.org, fid))
    r = _open(api, w, w.editor2, fid, "webm")
    assert r["kind"] == "webm" and bytes(r["bytes"]) == b"remuxed" and float(r["seconds"]) == 3.0
    assert _open(api, w, w.editor2, fid, "aac")["kind"] == "original"
    # The download line is written once per play (the first range), not for every range the player asks for.
    before = _downloads(worker, w, fid)
    _open(api, w, w.editor2, fid, "webm", audit=True)
    _open(api, w, w.editor2, fid, "webm")
    assert _downloads(worker, w, fid) == before + 1
    # The API reads no copy table directly; another file type is not a voice note.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor2, "select count(*) from pulse_priv.chat_file_play")
    pdf = one(api, w, w.editor, "select pulse.chat_file_add(%s,'Brief.pdf','application/pdf',%s) id", (group, b"%PDF-1.4"))["id"]
    assert _open(api, w, w.editor, pdf, "webm") is None


@needs_ffmpeg
def test_the_worker_gives_a_recorded_note_its_length_and_an_aac_copy(api, worker, team):  # noqa: F811
    w = team
    tone = _tone(3)
    assert _length(tone, ".webm") is None  # what Chrome records: players read Infinity
    _, fid, _ = _note(api, w, tone)
    _, broken, _ = _note(api, w, b"\x1aE\xdf\xa3 not really audio")
    m = _worker_module()
    assert m.playable(worker, w.org, limit=10) >= 2
    with worker.transaction():
        set_tenant(worker, w.org)
        rows = {(r["file_id"], r["kind"]): r for r in worker.execute("select file_id,kind,mime,bytes,seconds,error from pulse_priv.chat_file_play where file_id in (%s,%s)", (fid, broken)).fetchall()}
        kept = bytes(worker.execute("select bytes from pulse_priv.chat_file where id=%s", (fid,)).fetchone()["bytes"])
    webm, aac = rows[(fid, "webm")], rows[(fid, "aac")]
    assert webm["error"] is None and aac["error"] is None and aac["mime"] == "audio/mp4"
    assert abs(_length(bytes(webm["bytes"]), ".webm") - 3) < 0.3 and abs(float(webm["seconds"]) - 3) < 0.3
    assert abs(_length(bytes(aac["bytes"]), ".m4a") - 3) < 0.3
    assert kept == tone  # the original is never changed
    # A file ffmpeg cannot read is recorded with its error, and not tried again.
    assert rows[(broken, "webm")]["bytes"] is None and rows[(broken, "webm")]["error"]
    assert m.playable(worker, w.org, limit=10) == 0
    # The reader gets the copy that plays where they are.
    assert _open(api, w, w.editor2, fid, "aac")["mime"] == "audio/mp4"
    assert _open(api, w, w.editor2, fid, "webm")["kind"] == "webm"
