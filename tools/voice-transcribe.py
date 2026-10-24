"""CHAT-VOICE: transcripts of Pulse voice messages, on request, locally and free (the approach of the WA lane's
transcribe_local.py: faster-whisper large-v3-turbo, int8, CPU, lowest priority). Off unless the API has
PULSE_VOICE_TRANSCRIPTS=1 (only then can anyone ask for a transcript); this worker then fills the queue
(pulse_priv.chat_voice_transcript, migration 0895) one company at a time. Audio never leaves the server.

  PULSE_DATABASE_URL_WORKER=... nice -n 19 uv run --with "psycopg[binary]" --with faster-whisper python tools/voice-transcribe.py [--once]
"""
import os
import subprocess
import sys
import time

import numpy as np
import psycopg
from psycopg.rows import dict_row

MODEL = os.environ.get("PULSE_VOICE_MODEL", "large-v3-turbo")


def pcm(data: bytes):
    raw = subprocess.run(["ffmpeg", "-v", "quiet", "-i", "pipe:0", "-ac", "1", "-ar", "16000", "-f", "f32le", "-"], input=data, capture_output=True, check=False).stdout
    return np.frombuffer(raw, dtype=np.float32)


def tenant(con, org):
    con.execute("select set_config('pulse.org_id',%s,true)", (org,))


def main():
    once = "--once" in sys.argv
    url = os.environ["PULSE_DATABASE_URL_WORKER"]
    from faster_whisper import WhisperModel
    model = WhisperModel(MODEL, device="cpu", compute_type="int8", cpu_threads=int(os.environ.get("PULSE_VOICE_THREADS", "2")))
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
        if once:
            return
        if not did:
            time.sleep(10)


if __name__ == "__main__":
    main()
