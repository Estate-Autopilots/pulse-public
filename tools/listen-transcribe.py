"""AGENT-CHANNELS: the live transcript of a listening session (migration 1685), on this server's own Whisper (as
tools/voice-transcribe.py: faster-whisper, int8, CPU, lowest priority; audio never leaves the server).

Every second, one company at a time: take the oldest audio piece waiting (pulse.listen_chunk_claim), transcribe it with
the text heard just before as a prompt, store the timed segments and drop the audio (pulse.listen_chunk_done); then hand
the new part of each session to its AI employee (pulse.listen_forward) and apply the companies' retention
(pulse.listen_purge, every ten minutes).

A live transcript needs speed more than the last word of accuracy, so the default model is "small" (PULSE_LISTEN_MODEL;
"large-v3-turbo" is better and about four times slower here). The model is let go after PULSE_LISTEN_IDLE seconds without
work (default 300). PULSE_LISTEN_STT=stub writes a fixed synthetic line per piece instead (tests and the Playwright walk).

  PULSE_DATABASE_URL_WORKER=... nice -n 19 uv run --with "psycopg[binary]" --with faster-whisper python tools/listen-transcribe.py [--once]
"""
import base64
import gc
import json
import os
import subprocess
import sys
import time

import psycopg
from psycopg.rows import dict_row

MODEL = os.environ.get("PULSE_LISTEN_MODEL", "small")
IDLE = int(os.environ.get("PULSE_LISTEN_IDLE", "300"))
STUB = os.environ.get("PULSE_LISTEN_STT") == "stub"


def stub_segments(seq, ms):
    """What the stub 'hears': one synthetic line per piece, timed to the piece."""
    secs = max(1.0, (ms or 10000) / 1000)
    return [{"s": 0.0, "e": round(secs, 1), "t": f"Synthetic speech, part {seq + 1}: the client asks for a quotation for 40 signboards by Friday."}]


class Whisper:
    def __init__(self):
        self.model, self.used = None, 0.0

    def segments(self, audio: bytes, prompt: str):
        import numpy as np
        if self.model is None:
            from faster_whisper import WhisperModel
            self.model = WhisperModel(MODEL, device="cpu", compute_type="int8", cpu_threads=int(os.environ.get("PULSE_LISTEN_THREADS", "2")))
        self.used = time.monotonic()
        raw = subprocess.run(["ffmpeg", "-v", "quiet", "-i", "pipe:0", "-ac", "1", "-ar", "16000", "-f", "f32le", "-"],
                             input=audio, capture_output=True, check=False).stdout
        pcm = np.frombuffer(raw, dtype=np.float32)
        if not len(pcm):
            return []
        segs, _ = self.model.transcribe(pcm, beam_size=1, vad_filter=True, initial_prompt=prompt or None, condition_on_previous_text=False)
        out = [{"s": round(s.start, 1), "e": round(s.end, 1), "t": s.text.strip()} for s in segs if s.text.strip()]
        self.used = time.monotonic()
        return out

    def rest(self):
        if self.model is not None and time.monotonic() - self.used > IDLE:
            self.model = None
            gc.collect()


def tenant(con, org):
    con.execute("select set_config('pulse.org_id',%s::text,true)", (str(org),))


def one_piece(con, org, stt):
    """Transcribe one waiting piece in this company; True if there was one."""
    with con.transaction():
        tenant(con, org)
        job = con.execute("select pulse.listen_chunk_claim() j").fetchone()["j"]
    if not job:
        return False
    try:
        if STUB:
            segs = stub_segments(job["seq"], job["ms"])
        else:
            segs = stt.segments(base64.b64decode(job["audio"] or ""), job.get("before") or "")
        error = None
    except Exception as e:  # noqa: BLE001  (the piece is retried, then marked failed; the session goes on)
        segs, error = [], type(e).__name__
    with con.transaction():
        tenant(con, org)
        con.execute("select pulse.listen_chunk_done(%s,%s,%s::jsonb,%s)", (job["sessionId"], job["seq"], json.dumps(segs), error))
    return True


def main():
    once = "--once" in sys.argv
    url = os.environ["PULSE_DATABASE_URL_WORKER"]
    stt, purged = Whisper(), 0.0
    while True:
        did = 0
        with psycopg.connect(url, row_factory=dict_row, options="-c role=pulse_worker") as con:
            if not con.execute("select to_regproc('pulse.listen_chunk_claim') is not null ok").fetchone()["ok"]:
                print("waiting for migration 1685 (pulse.listen_chunk_claim)", file=sys.stderr)
                if once:
                    return 0
                time.sleep(600)
                continue
            orgs = [r["org"] for r in con.execute("select pulse.list_active_orgs() org").fetchall()]
            for org in orgs:
                for _ in range(20):  # at most 20 pieces per company per round, so no company waits on another
                    if not one_piece(con, org, stt):
                        break
                    did += 1
                with con.transaction():
                    tenant(con, org)
                    con.execute("select pulse.listen_forward()")
                    if time.monotonic() - purged > 600:
                        con.execute("select pulse.listen_purge()")
            if time.monotonic() - purged > 600:
                purged = time.monotonic()
        if once:
            print(json.dumps({"listen_transcribe": "pass", "pieces": did}))
            return 0
        stt.rest()
        if not did:
            time.sleep(1.0)


if __name__ == "__main__":
    sys.exit(main())
