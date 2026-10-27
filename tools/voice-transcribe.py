"""CHAT-VOICE: transcripts of Pulse voice messages, on request, locally and free (the approach of the WA lane's
transcribe_local.py: faster-whisper large-v3-turbo, int8, CPU, lowest priority). Off unless the API has
PULSE_VOICE_TRANSCRIPTS=1 (only then can anyone ask for a transcript); this worker then fills the queue
(pulse_priv.chat_voice_transcript, migration 0895) one company at a time. Audio never leaves the server.

CALLS-V2: also call recordings (pulse.chat_call_recording, migration 1033) once their last part is in (two minutes after
they stopped): the parts are put back together and remuxed (ffmpeg, no re-encoding) so a player knows the length and can
seek, then transcribed with timed segments and the language. A recording's transcript is the call's, for its
conversation's members; an AI employee may then summarise it as the company's policy says (1033).

CALLS-V2: the model (~1-1.8 GB) is loaded when there is something to transcribe and let go after PULSE_VOICE_IDLE
seconds without work (default 300), so the workers for pulse-dev and production do not hold it all day on a shared server.

  PULSE_DATABASE_URL_WORKER=... nice -n 19 uv run --with "psycopg[binary]" --with faster-whisper python tools/voice-transcribe.py [--once]
"""
import ctypes
import gc
import os
import subprocess
import sys
import time

import numpy as np
import psycopg
import psycopg.types.json
from psycopg.rows import dict_row

MODEL = os.environ.get("PULSE_VOICE_MODEL", "large-v3-turbo")
IDLE = int(os.environ.get("PULSE_VOICE_IDLE", "300"))


class Lazy:
    """The model, loaded on first use and let go after IDLE seconds without work."""

    def __init__(self):
        self.model, self.used = None, 0.0

    def transcribe(self, audio, **kw):
        if self.model is None:
            from faster_whisper import WhisperModel
            self.model = WhisperModel(MODEL, device="cpu", compute_type="int8", cpu_threads=int(os.environ.get("PULSE_VOICE_THREADS", "2")))
        self.used = time.monotonic()
        try:
            return self.model.transcribe(audio, **kw)
        finally:
            self.used = time.monotonic()

    def rest(self):
        if self.model is not None and time.monotonic() - self.used > IDLE:
            self.model = None
            gc.collect()
            try:  # hand the freed memory back to the system
                ctypes.CDLL("libc.so.6").malloc_trim(0)
            except OSError:
                pass


def pcm(data: bytes):
    raw = subprocess.run(["ffmpeg", "-v", "quiet", "-i", "pipe:0", "-ac", "1", "-ar", "16000", "-f", "f32le", "-"], input=data, capture_output=True, check=False).stdout
    return np.frombuffer(raw, dtype=np.float32)


def tenant(con, org):
    con.execute("select set_config('pulse.org_id',%s::text,true)", (str(org),))


PART = 1024 * 1024


def remux(data: bytes, mime: str):
    """The recording as one file with its length and cues (MediaRecorder's pieces carry neither); None if ffmpeg fails."""
    fmt = {"audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "mp4"}.get(mime, "webm")
    extra = ["-movflags", "frag_keyframe+empty_moov"] if fmt == "mp4" else []
    out = subprocess.run(["ffmpeg", "-v", "quiet", "-i", "pipe:0", "-vn", "-c", "copy", *extra, "-f", fmt, "-"], input=data, capture_output=True, check=False)
    return out.stdout if out.returncode == 0 and out.stdout else None


def recording(con, org, model):
    """One call recording waiting for its transcript, in this company; True if one was done (or failed)."""
    with con.transaction():
        tenant(con, org)
        job = con.execute("""update pulse.chat_call_recording r set transcript_state='working',attempts=attempts+1 where r.id=(
            select id from pulse.chat_call_recording where org_id=pulse.current_org() and state='saved' and transcript_state='queued'
              and attempts<3 and stopped_at<now()-interval '130 seconds' order by stopped_at limit 1 for update skip locked)
            returning r.id,r.mime,r.seconds""").fetchone()
        if not job:
            return False
        data = b"".join(bytes(p["bytes"]) for p in con.execute("select bytes from pulse_priv.chat_call_recording_part where recording_id=%s order by seq", (job["id"],)).fetchall())
    fixed = remux(data, job["mime"]) if data else None
    try:
        segs, info = model.transcribe(pcm(fixed or data), beam_size=1, vad_filter=True)
        segments = [{"s": round(s.start, 1), "e": round(s.end, 1), "t": s.text.strip()} for s in segs if s.text.strip()]
        text = " ".join(x["t"] for x in segments).strip()[:400000]
        state, error, language, seconds = "done", None, (info.language or None), int(round(info.duration or 0)) or None
    except Exception as e:  # noqa: BLE001  (the recording stays playable; the transcript is marked failed after 3 tries)
        segments, text, state, error, language, seconds = None, None, "failed", str(e)[:300], None, None
    with con.transaction():
        tenant(con, org)
        if fixed:
            con.execute("delete from pulse_priv.chat_call_recording_part where recording_id=%s", (job["id"],))
            for i in range(0, len(fixed), PART):
                con.execute("insert into pulse_priv.chat_call_recording_part(org_id,recording_id,seq,bytes) values(%s,%s,%s,%s)", (org, job["id"], i // PART, fixed[i:i + PART]))
            con.execute("update pulse.chat_call_recording set bytes=%s,parts=%s where id=%s", (len(fixed), (len(fixed) + PART - 1) // PART, job["id"]))
        retry = state == "failed" and con.execute("select attempts<3 ok from pulse.chat_call_recording where id=%s", (job["id"],)).fetchone()["ok"]
        con.execute("""update pulse.chat_call_recording set transcript_state=%s,transcript=%s,segments=%s,language=%s,transcript_at=now(),transcript_error=%s,
            seconds=coalesce(%s,seconds),summary_state=case when %s='done' then summary_state when summary_state='queued' and %s then 'queued' else 'off' end where id=%s""",
                    ("queued" if retry else state, text, psycopg.types.json.Jsonb(segments) if segments is not None else None, language, error,
                     seconds if not job["seconds"] or job["seconds"] < 2 else None, state, bool(retry), job["id"]))
        con.execute("select pulse.chat_call_record_line(%s)", (job["id"],))
    return True


def main():
    once = "--once" in sys.argv
    url = os.environ["PULSE_DATABASE_URL_WORKER"]
    # CALLS-V2: enabled on a server whose database has not had the calls migrations yet (1033), it waits for them
    # without loading the model, so the unit can be switched on before a release reaches that server.
    while not once:
        with psycopg.connect(url, row_factory=dict_row, options="-c role=pulse_worker") as con:
            if con.execute("select to_regclass('pulse.chat_call_recording') is not null ok").fetchone()["ok"]:
                break
        print("waiting for migration 1033 (pulse.chat_call_recording)", file=sys.stderr)
        time.sleep(600)
    model = Lazy()
    while True:
        did = 0
        with psycopg.connect(url, row_factory=dict_row, options="-c role=pulse_worker") as con:
            orgs = [r["org"] for r in con.execute("select pulse.list_active_orgs() org").fetchall()]
            for org in orgs:
                with con.transaction():
                    tenant(con, org)
                    job = con.execute("""update pulse_priv.chat_voice_transcript t set state='working',attempts=attempts+1 where (message_id,file_id)=(
                        select message_id,file_id from pulse_priv.chat_voice_transcript where state='queued' and attempts<3 order by requested_at limit 1 for update skip locked)
                        returning t.message_id,t.file_id""").fetchone()
                    if not job:
                        continue
                    data = con.execute("select bytes from pulse_priv.chat_file where id=%s", (job["file_id"],)).fetchone()
                try:
                    segs, info = model.transcribe(pcm(bytes(data["bytes"])), beam_size=1, vad_filter=True)
                    text = " ".join(s.text.strip() for s in segs).strip()[:20000]
                    state = "done"
                except Exception:  # noqa: BLE001  (the note stays playable; the transcript is marked failed)
                    text, state = None, "failed"
                with con.transaction():
                    tenant(con, org)
                    con.execute("update pulse_priv.chat_voice_transcript set state=%s,body=%s,model=%s,done_at=now() where message_id=%s and file_id=%s",
                                (state, text, MODEL, job["message_id"], job["file_id"]))
                    con.execute("insert into pulse.chat_event(org_id,channel_id) select org_id,channel_id from pulse.chat_message where id=%s", (job["message_id"],))
                did += 1
            # CALLS-V2: then one call recording per company.
            for org in orgs:
                try:
                    did += recording(con, org, model)
                except psycopg.Error as e:  # one company's trouble never stops the others
                    print(f"call recording transcript failed: {str(e)[:200]}", file=sys.stderr)
        if once:
            return
        if did:  # the segments are decoded as they are read, after transcribe() returned
            model.used = time.monotonic()
        else:
            model.rest()
            time.sleep(10)


if __name__ == "__main__":
    main()
