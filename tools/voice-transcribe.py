"""CHAT-VOICE: transcripts of Pulse voice messages, on request, locally and free (the approach of the WA lane's
transcribe_local.py: faster-whisper large-v3-turbo, int8, CPU, lowest priority). Off unless the API has
PULSE_VOICE_TRANSCRIPTS=1 (only then can anyone ask for a transcript); this worker then fills the queue
(pulse_priv.chat_voice_transcript, migration 0895) one company at a time. Audio never leaves the server.

CALLS-V2: also call recordings (pulse.chat_call_recording, migration 1033) once their last part is in (two minutes after
they stopped): the parts are put back together and remuxed (ffmpeg, no re-encoding) so a player knows the length and can
seek, then transcribed with timed segments and the language. A recording's transcript is the call's, for its
conversation's members; an AI employee may then summarise it as the company's policy says (1033).

KAZUK-REST (1712): also in-person meetings recorded in Pulse (pulse.meeting), the same way as call recordings.

CHAT-VOICE-FIX (2107): first, every audio chat file gets its playable copies (pulse_priv.chat_file_play), made with
ffmpeg on this server within seconds of the upload: a WebM note remuxed (no re-encoding) so it has its length and cues
(MediaRecorder writes neither, so players read Infinity and seek badly), and an AAC .m4a copy that Safari and iPhones
play. The original is never changed; a copy ffmpeg cannot make is recorded with its error and not retried.

CALLS-V2: the model (~1-1.8 GB) is loaded when there is something to transcribe and let go after PULSE_VOICE_IDLE
seconds without work (default 300), so the workers for pulse-dev and production do not hold it all day on a shared server.

  PULSE_DATABASE_URL_WORKER=... nice -n 19 uv run --with "psycopg[binary]" --with faster-whisper python tools/voice-transcribe.py [--once]
"""
import ctypes
import gc
import os
import subprocess
import sys
import tempfile
import time

import psycopg
import psycopg.types.json
from psycopg.rows import dict_row

MODEL = os.environ.get("PULSE_VOICE_MODEL", "large-v3-turbo")
IDLE = int(os.environ.get("PULSE_VOICE_IDLE", "300"))


class Lazy:
    """The model, loaded on first use and let go after IDLE seconds without work."""

    def __init__(self):
        self.model, self.used = None, 0.0

    def load(self):
        if self.model is None:
            from faster_whisper import WhisperModel
            self.model = WhisperModel(MODEL, device="cpu", compute_type="int8", cpu_threads=int(os.environ.get("PULSE_VOICE_THREADS", "2")))
        self.used = time.monotonic()
        return self.model

    def transcribe(self, audio, **kw):
        self.load()
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


    def detect(self, audio):
        """Whisper's language guess over the first 30 s of speech: {"en": p, "hi": p, "mr": p} (summing to 1)."""
        from faster_whisper.audio import pad_or_trim
        m = self.load()
        feats = m.feature_extractor(audio)
        seg = pad_or_trim(feats[:, :min(m.feature_extractor.nb_max_frames, feats.shape[-1] - 1)])
        probs = m.model.detect_language(m.encode(seg))[0]
        cand = {tok.strip("<|>"): p for tok, p in probs if tok.strip("<|>") in ("en", "hi", "mr")}
        tot = sum(cand.values()) or 1.0
        return {k: cand.get(k, 0.0) / tot for k in ("en", "hi", "mr")}


# ---- CHAT-VOICE-FIX part 2 (2135): transcripts right or hidden ----
# Whisper (large-v3-turbo) writes confident nonsense for Marathi mixed with Hindi and English. AI4Bharat's engines are
# trained on Indian speech: IndicConformer (CTC, ONNX int8 through onnx-asr) and IndicWhisper (Vistaar whisper-medium
# fine-tunes, CTranslate2 int8), one model per language, public weights kept in this server's caches. Two engines of
# different design that write the same words are rarely both wrong, so their agreement is the confidence; the language
# whose two engines agree best is the one spoken. Below CLEAR_AT the words are kept (for search by the gist and for the
# record) but not shown; a one-line English gist (Whisper's own translation) is made for such a note when Whisper is
# sure enough of it. Audio never leaves the server.
INDIC_DIR = os.environ.get("PULSE_VOICE_INDIC_DIR", os.path.expanduser("~/.cache/ea-asr"))
CONFORMER = {"hi": "OpenVoiceOS/ai4bharat-indicconformer-hi-onnx", "mr": "OpenVoiceOS/ai4bharat-indicconformer-mr-onnx"}
CLEAR_AT = float(os.environ.get("PULSE_VOICE_CLEAR_AT", "0.8"))
GIST_LOGPROB = float(os.environ.get("PULSE_VOICE_GIST_LOGPROB", "-0.9"))
SR = 16000


def _norm(t):
    import re
    import unicodedata
    t = unicodedata.normalize("NFC", t or "").lower().replace("़", "").replace("ँ", "ं")
    t = "".join(ch for ch in t if not unicodedata.category(ch).startswith(("P", "S")) and ch not in "‌‍")
    return re.sub(r"\s+", "", t)


def agreement(a, b):
    """1 - character edit distance / the longer text (spaces and punctuation aside): 1 = the same words."""
    a, b = _norm(a), _norm(b)
    if not a or not b:
        return 0.0
    if len(a) < len(b):
        a, b = b, a
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return max(0.0, 1 - prev[-1] / len(a))


class Indic:
    """AI4Bharat's engines, loaded on first use and let go with Whisper after IDLE seconds without work. `ready` is
    False when this server lacks onnx-asr or the models (then Whisper alone decides, more strictly)."""

    def __init__(self):
        self.models, self.used, self._ready = {}, 0.0, None

    def ready(self):
        if self._ready is None:
            try:
                import onnx_asr  # noqa: F401
                from huggingface_hub import snapshot_download
                for lang, repo in CONFORMER.items():
                    snapshot_download(repo, allow_patterns=["*.json", "*.txt", "model.int8.onnx", "*.md"], local_files_only=True)
                    if not os.path.isdir(os.path.join(INDIC_DIR, f"ct2-indicwhisper-{lang}")):
                        raise FileNotFoundError(f"ct2-indicwhisper-{lang}")
                self._ready = True
            except Exception as e:  # noqa: BLE001
                print(f"Indian-language engines unavailable ({str(e)[:120]}): Whisper alone, stricter", file=sys.stderr)
                self._ready = False
        return self._ready

    def _model(self, key):
        if key not in self.models:
            kind, lang = key.split(":")
            if kind == "ic":
                import onnx_asr
                from huggingface_hub import snapshot_download
                path = snapshot_download(CONFORMER[lang], allow_patterns=["*.json", "*.txt", "model.int8.onnx", "*.md"], local_files_only=True)
                self.models[key] = onnx_asr.load_model("nemo-conformer-ctc", path, quantization="int8")
            else:
                from faster_whisper import WhisperModel
                self.models[key] = WhisperModel(os.path.join(INDIC_DIR, f"ct2-indicwhisper-{lang}"), device="cpu", compute_type="int8",
                                                cpu_threads=int(os.environ.get("PULSE_VOICE_THREADS", "2")))
        self.used = time.monotonic()
        return self.models[key]

    def conformer(self, lang, pieces):
        m, out = self._model(f"ic:{lang}"), []
        for a in pieces:
            t = m.recognize(a, sample_rate=SR)
            t = (t if isinstance(t, str) else getattr(t, "text", str(t))).strip()
            if t:
                out.append(t)
        self.used = time.monotonic()
        return " ".join(out).strip()

    def whisper(self, lang, speech):
        # Beam 2: on this server's starved CPU, beam 5 cost about 3 CPU-seconds per second of audio per language.
        segs, _ = self._model(f"iw:{lang}").transcribe(speech, language=lang, beam_size=2, vad_filter=True, condition_on_previous_text=False,
                                                        temperature=[0.0, 0.2, 0.4])
        text = " ".join(s.text.strip() for s in segs).strip()
        self.used = time.monotonic()
        return text

    def rest(self):
        if self.models and time.monotonic() - self.used > IDLE:
            self.models.clear()
            gc.collect()


def speech_pieces(audio, max_s=20):
    """The whole note in pieces of at most max_s seconds (a voice note is nearly all speech, and a tight voice detector
    cut whole words off quiet speakers in the bake-off), and how many seconds of speech Silero VAD hears in it."""
    from faster_whisper.vad import VadOptions, get_speech_timestamps
    pieces = [audio[a:a + max_s * SR] for a in range(0, len(audio), max_s * SR)]
    heard = sum(t["end"] - t["start"] for t in get_speech_timestamps(audio, VadOptions(speech_pad_ms=400))) / SR
    return [p for p in pieces if len(p) >= SR // 4], heard


def hear(model, indic, audio):
    """What a voice note says and how sure the server is: {text, clear, confidence, language, engine, gist}."""
    import math
    pieces, heard = speech_pieces(audio)
    speech = audio
    if heard < 0.5:
        return {"text": "", "clear": False, "confidence": 0.0, "language": None, "engine": "vad", "gist": None}
    lid = model.detect(speech)
    out = None
    if lid["en"] < 0.75 and indic.ready():
        best, tried = None, {}
        for lang in ("mr", "hi"):
            ic, iw = indic.conformer(lang, pieces), indic.whisper(lang, speech)
            agree = agreement(ic, iw)
            tried[lang] = {"ic": ic, "iw": iw, "agree": round(agree, 3)}
            if best is None or agree > best[0]:
                best = (agree, lang, ic, iw)
        agree, lang, ic, iw = best
        out = {"text": iw or ic, "clear": agree >= CLEAR_AT, "confidence": round(agree, 3), "language": lang,
               "engine": f"indicwhisper-{lang}+indicconformer-{lang}", "tried": tried, "lid": {k: round(v, 3) for k, v in lid.items()}}
    if out is None:
        # English, or no Indian-language engines here: Whisper alone, trusted only when it is sure of the words and the
        # language (its Hindi/Marathi guesses on mixed speech are confident and wrong, so those are never "clear" alone).
        lang = max(lid, key=lid.get)
        segs, _ = model.transcribe(speech, language=lang, beam_size=5, vad_filter=True, condition_on_previous_text=False)
        segs = list(segs)
        text = " ".join(s.text.strip() for s in segs).strip()
        lp = sum(s.avg_logprob * max(1e-3, s.end - s.start) for s in segs) / max(1e-3, sum(max(1e-3, s.end - s.start) for s in segs)) if segs else -9
        conf = math.exp(lp)
        out = {"text": text, "clear": bool(text) and lang == "en" and lid["en"] >= 0.75 and conf >= 0.6 and all(s.compression_ratio < 2.4 for s in segs),
               "confidence": round(min(1.0, conf), 3), "language": lang, "engine": f"whisper-{MODEL}"}
    out["gist"] = gist(model, speech) if not out["clear"] else None
    return out


def gist(model, speech):
    """A short English line of what the note is about (Whisper translating), only when Whisper is sure enough."""
    segs, _ = model.transcribe(speech, task="translate", beam_size=2, vad_filter=True, condition_on_previous_text=False)
    segs = [s for s in segs if s.text.strip()]
    if not segs or sum(s.avg_logprob for s in segs) / len(segs) < GIST_LOGPROB or any(s.compression_ratio > 2.4 or s.no_speech_prob > 0.6 for s in segs):
        return None
    text = " ".join(s.text.strip() for s in segs).strip()
    # large-v3-turbo was not trained to translate: on Marathi or Hindi it often writes the words again in Devanagari
    # (seen on a real note). A guess is shown only when it really is English.
    if not english(text):
        return None
    return text if len(text) <= 160 else text[:157].rsplit(" ", 1)[0] + "…"


def english(text):
    """Mostly Latin letters (a translation into English, not the speech written again in its own script)."""
    letters = [ch for ch in text if ch.isalpha()]
    return bool(letters) and sum(ch.isascii() for ch in letters) / len(letters) >= 0.9


def pcm(data: bytes):
    raw = subprocess.run(["ffmpeg", "-v", "quiet", "-i", "pipe:0", "-ac", "1", "-ar", "16000", "-f", "f32le", "-"], input=data, capture_output=True, check=False).stdout
    import numpy as np  # only the transcriber needs it (the copies and the tests do not)
    return np.frombuffer(raw, dtype=np.float32)


def tenant(con, org):
    con.execute("select set_config('pulse.org_id',%s::text,true)", (str(org),))


PART = 1024 * 1024


def ffmpeg_file(data: bytes, args, suffix: str):
    """ffmpeg from a file to a file (a pipe cannot be rewound, so the WebM muxer could write no length and no cues, and
    MP4 needs its index moved first): (bytes, None), or (None, ffmpeg's last words)."""
    with tempfile.TemporaryDirectory(prefix="pulse-voice-") as d:
        src, out = os.path.join(d, "in"), os.path.join(d, "out" + suffix)
        with open(src, "wb") as f:
            f.write(data)
        try:
            r = subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-y", "-i", src, *args, out], capture_output=True, timeout=600, check=False)
        except subprocess.TimeoutExpired:
            return None, "ffmpeg took too long"
        if r.returncode != 0 or not os.path.exists(out) or os.path.getsize(out) == 0:
            lines = r.stderr.decode(errors="replace").strip().splitlines()
            return None, (lines[-1] if lines else "ffmpeg made nothing")[:300]
        with open(out, "rb") as f:
            return f.read(), None


def seconds_of(data: bytes, suffix: str):
    """The length a player will read (None when the file has none)."""
    with tempfile.TemporaryDirectory(prefix="pulse-voice-") as d:
        src = os.path.join(d, "in" + suffix)
        with open(src, "wb") as f:
            f.write(data)
        r = subprocess.run(["ffprobe", "-v", "quiet", "-show_entries", "format=duration", "-of", "csv=p=0", src], capture_output=True, timeout=60, check=False)
        try:
            return round(float(r.stdout.decode().strip()), 2)
        except ValueError:
            return None


def remux(data: bytes, mime: str):
    """The recording as one file with its length and cues (MediaRecorder's pieces carry neither); None if ffmpeg fails."""
    fmt = {"audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "mp4"}.get(mime, "webm")
    extra = ["-movflags", "+faststart"] if fmt == "mp4" else []
    out, _ = ffmpeg_file(data, ["-vn", "-c", "copy", *extra, "-f", fmt], "." + fmt)
    return out


COPY_MAX = 10 * 1024 * 1024
MP4 = ("audio/mp4", "audio/x-m4a", "audio/aac")


def copies_of(data: bytes, mime: str):
    """CHAT-VOICE-FIX: a voice note's playable copies: [(kind, mime, bytes|None, seconds|None, error|None)]."""
    base, out = mime.split(";")[0].strip().lower(), []
    if base == "audio/webm":
        b, err = ffmpeg_file(data, ["-vn", "-c", "copy", "-f", "webm"], ".webm")
        out.append(("webm", "audio/webm", b, err))
    transcode = ["-vn", "-ac", "1", "-c:a", "aac", "-b:a", "48k", "-movflags", "+faststart", "-f", "mp4"]
    b, err = ffmpeg_file(data, ["-vn", "-c", "copy", "-movflags", "+faststart", "-f", "mp4"] if base in MP4 else transcode, ".m4a")
    if b is None and base in MP4:  # an MP4 whose audio is not AAC
        b, err = ffmpeg_file(data, transcode, ".m4a")
    out.append(("aac", "audio/mp4", b, err))
    done = []
    for kind, m, b, err in out:
        if b is not None and len(b) > COPY_MAX:
            b, err = None, "the copy would be over 10 MB"
        done.append((kind, m, b, seconds_of(b, ".webm" if kind == "webm" else ".m4a") if b else None, None if b else (err or "ffmpeg failed")))
    return done


def playable(con, org, limit=4):
    """CHAT-VOICE-FIX (2107): the playable copies of this company's newest audio chat files that have none yet."""
    with con.transaction():
        tenant(con, org)
        if con.execute("select to_regclass('pulse_priv.chat_file_play') is null gone").fetchone()["gone"]:
            return 0
        jobs = con.execute("""select f.id,f.mime from pulse_priv.chat_file f where f.org_id=pulse.current_org() and f.mime like 'audio/%%'
            and f.created_at>now()-interval '400 days' and not exists(select 1 from pulse_priv.chat_file_play p where p.file_id=f.id)
            order by f.created_at desc limit %s""", (limit,)).fetchall()
    for job in jobs:
        with con.transaction():
            tenant(con, org)
            row = con.execute("select bytes from pulse_priv.chat_file where id=%s", (job["id"],)).fetchone()
        if not row:
            continue
        made = copies_of(bytes(row["bytes"]), job["mime"])
        with con.transaction():
            tenant(con, org)
            for kind, mime, b, secs, err in made:
                con.execute("""insert into pulse_priv.chat_file_play(org_id,file_id,kind,mime,bytes,seconds,error) values(%s,%s,%s,%s,%s,%s,%s)
                    on conflict (file_id,kind) do nothing""", (org, job["id"], kind, mime, b, secs, err))
    return len(jobs)


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


def meeting(con, org, model):
    """KAZUK-REST (1712): one in-person meeting recorded in Pulse, waiting for its transcript, in this company; True if one
    was done (or failed). As a call recording: the parts are put back together and remuxed, then transcribed with timed
    segments; the API then reads its action items (services/api/src/meeting-actions.ts) as drafts a person confirms."""
    with con.transaction():
        tenant(con, org)
        if con.execute("select to_regclass('pulse.meeting') is null gone").fetchone()["gone"]:
            return False
        job = con.execute("""update pulse.meeting m set transcript_state='working',attempts=attempts+1 where m.id=(
            select id from pulse.meeting where org_id=pulse.current_org() and state='saved' and kind='recording' and transcript_state='queued'
              and attempts<3 and stopped_at<now()-interval '130 seconds' order by stopped_at limit 1 for update skip locked)
            returning m.id,m.mime,m.seconds""").fetchone()
        if not job:
            return False
        data = b"".join(bytes(p["bytes"]) for p in con.execute("select bytes from pulse_priv.meeting_part where meeting_id=%s order by seq", (job["id"],)).fetchall())
    fixed = remux(data, job["mime"]) if data else None
    try:
        segs, info = model.transcribe(pcm(fixed or data), beam_size=1, vad_filter=True)
        segments = [{"s": round(s.start, 1), "e": round(s.end, 1), "t": s.text.strip()} for s in segs if s.text.strip()]
        text = " ".join(x["t"] for x in segments).strip()[:400000]
        state, error, language, seconds = "done", None, (info.language or None), int(round(info.duration or 0)) or None
    except Exception as e:  # noqa: BLE001  (the audio stays playable; the transcript is marked failed after 3 tries)
        segments, text, state, error, language, seconds = None, None, "failed", str(e)[:300], None, None
    with con.transaction():
        tenant(con, org)
        if fixed:
            con.execute("delete from pulse_priv.meeting_part where meeting_id=%s", (job["id"],))
            for i in range(0, len(fixed), PART):
                con.execute("insert into pulse_priv.meeting_part(org_id,meeting_id,seq,bytes) values(%s,%s,%s,%s)", (org, job["id"], i // PART, fixed[i:i + PART]))
            con.execute("update pulse.meeting set bytes=%s,parts=%s where id=%s", (len(fixed), (len(fixed) + PART - 1) // PART, job["id"]))
        retry = state == "failed" and con.execute("select attempts<3 ok from pulse.meeting where id=%s", (job["id"],)).fetchone()["ok"]
        con.execute("""update pulse.meeting set transcript_state=%s,transcript=%s,segments=%s,language=%s,transcript_at=now(),transcript_error=%s,
            seconds=coalesce(%s,seconds),actions_state=case when %s='done' then 'pending' else actions_state end where id=%s""",
                    ("queued" if retry else state, text if text else None, psycopg.types.json.Jsonb(segments) if segments is not None else None, language, error,
                     seconds if not job["seconds"] or job["seconds"] < 2 else None, state, job["id"]))
    return True


def has_heard(con):
    """Whether this database has 2135 (clear, confidence, gist, language, engine on chat_voice_transcript)."""
    return con.execute("""select exists(select 1 from information_schema.columns where table_schema='pulse_priv'
        and table_name='chat_voice_transcript' and column_name='clear') ok""").fetchone()["ok"]


def save_heard(con, message_id, file_id, state, heard, sure):
    text = (heard or {}).get("text")
    text = text[:20000] if text is not None else None
    if sure and heard is not None:
        con.execute("""update pulse_priv.chat_voice_transcript set state=%s,body=%s,model=%s,done_at=now(),clear=%s,confidence=%s,gist=%s,language=%s,engine=%s
            where message_id=%s and file_id=%s""", (state, text, MODEL, heard.get("clear"), heard.get("confidence"), heard.get("gist"), heard.get("language"),
                                                    heard.get("engine"), message_id, file_id))
    else:
        con.execute("update pulse_priv.chat_voice_transcript set state=%s,body=%s,model=%s,done_at=now() where message_id=%s and file_id=%s",
                    (state, text, MODEL, message_id, file_id))


def scrub_guesses(con, org):
    """CHAT-VOICE-FIX: a stored guess that is not English (made before the check above) is dropped, so neither the chat
    nor an AI employee reads it."""
    with con.transaction():
        tenant(con, org)
        rows = con.execute("select message_id,file_id,gist from pulse_priv.chat_voice_transcript where gist is not null").fetchall()
        bad = [r for r in rows if not english(r["gist"])]
        for r in bad:
            con.execute("update pulse_priv.chat_voice_transcript set gist=null where message_id=%s and file_id=%s", (r["message_id"], r["file_id"]))
    return len(bad)


def rehear(con, org, model, indic):
    """CHAT-VOICE-FIX: a transcript made before 2135 (no engine recorded) of the last 60 days, made again in place. Its
    state stays done, so nobody is woken again and nothing is queued."""
    with con.transaction():
        tenant(con, org)
        job = con.execute("""select t.message_id,t.file_id from pulse_priv.chat_voice_transcript t where t.org_id=pulse.current_org() and t.state='done'
            and t.engine is null and t.done_at>now()-interval '60 days' order by t.done_at desc limit 1 for update skip locked""").fetchone()
        if not job:
            return 0
        data = con.execute("select bytes from pulse_priv.chat_file where id=%s", (job["file_id"],)).fetchone()
    try:
        heard = hear(model, indic, pcm(bytes(data["bytes"]))) if data else None
    except Exception as e:  # noqa: BLE001
        print(f"voice note re-transcript failed: {str(e)[:200]}", file=sys.stderr)
        heard = None
    with con.transaction():
        tenant(con, org)
        if heard is None:  # not readable again: keep the old words, hidden, and do not try again
            con.execute("update pulse_priv.chat_voice_transcript set clear=false,engine='unreadable' where message_id=%s and file_id=%s", (job["message_id"], job["file_id"]))
        else:
            con.execute("""update pulse_priv.chat_voice_transcript set body=%s,model=%s,clear=%s,confidence=%s,gist=%s,language=%s,engine=%s
                where message_id=%s and file_id=%s""", ((heard.get("text") or "")[:20000], MODEL, heard["clear"], heard["confidence"], heard.get("gist"),
                                                        heard.get("language"), heard["engine"], job["message_id"], job["file_id"]))
        con.execute("insert into pulse.chat_event(org_id,channel_id) select org_id,channel_id from pulse.chat_message where id=%s", (job["message_id"],))
    return 1


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
    model, indic = Lazy(), Indic()
    while True:
        did = 0
        with psycopg.connect(url, row_factory=dict_row, options="-c role=pulse_worker") as con:
            sure = has_heard(con)
            orgs = [r["org"] for r in con.execute("select pulse.list_active_orgs() org").fetchall()]
            # CHAT-VOICE-FIX: playable copies first (quick, and a note must play before it needs a transcript).
            for org in orgs:
                try:
                    did += playable(con, org)
                except psycopg.Error as e:
                    print(f"voice copies failed: {str(e)[:200]}", file=sys.stderr)
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
                    heard = hear(model, indic, pcm(bytes(data["bytes"]))) if sure else None
                    if heard is None:  # a database without 2135: as before
                        segs, info = model.transcribe(pcm(bytes(data["bytes"])), beam_size=1, vad_filter=True)
                        heard = {"text": " ".join(s.text.strip() for s in segs).strip(), "engine": MODEL}
                    state = "done"
                except Exception as e:  # noqa: BLE001  (the note stays playable; the transcript is marked failed)
                    print(f"voice note transcript failed: {str(e)[:200]}", file=sys.stderr)
                    heard, state = None, "failed"
                with con.transaction():
                    tenant(con, org)
                    save_heard(con, job["message_id"], job["file_id"], state, heard, sure)
                    con.execute("insert into pulse.chat_event(org_id,channel_id) select org_id,channel_id from pulse.chat_message where id=%s", (job["message_id"],))
                did += 1
            # CHAT-VOICE-FIX: then one older transcript per company made again with the new engines, in place.
            for org in orgs if sure else []:
                try:
                    scrub_guesses(con, org)
                except psycopg.Error as e:
                    print(f"voice note guesses: {str(e)[:200]}", file=sys.stderr)
                try:
                    did += rehear(con, org, model, indic)
                except psycopg.Error as e:
                    print(f"voice note re-transcript failed: {str(e)[:200]}", file=sys.stderr)
            # CALLS-V2: then one call recording per company.
            for org in orgs:
                try:
                    did += recording(con, org, model)
                except psycopg.Error as e:  # one company's trouble never stops the others
                    print(f"call recording transcript failed: {str(e)[:200]}", file=sys.stderr)
            # KAZUK-REST (1712): then one in-person meeting per company.
            for org in orgs:
                try:
                    did += meeting(con, org, model)
                except psycopg.Error as e:
                    print(f"meeting transcript failed: {str(e)[:200]}", file=sys.stderr)
        if once:
            return
        if did:  # the segments are decoded as they are read, after transcribe() returned
            model.used = time.monotonic()
        else:
            model.rest()
            indic.rest()
            time.sleep(10)


if __name__ == "__main__":
    main()
