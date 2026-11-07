"""ElevenLabs client for reels: v3 voice with character timings, sound effects, music, quota and a spend ledger.

The key comes from ELEVENLABS_API_KEY at run time (a wrapper injects it from the secret store). It is never
printed, logged or written. Every request is cached by a hash of everything that shapes the audio, so a re-run
spends nothing twice. Every paid call is written to the ledger (credits measured from the subscription counter
before and after) and refused once the run's budget would be crossed.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

API = "https://api.elevenlabs.io"


class ElError(RuntimeError):
    pass


class BudgetError(ElError):
    pass


def _key() -> str:
    key = os.environ.get("ELEVENLABS_API_KEY", "")
    if not key:
        raise ElError("ELEVENLABS_API_KEY is not set; run through the with-elevenlabs wrapper")
    return key


def _request(method: str, path: str, body: bytes | None = None, headers: dict[str, str] | None = None,
             timeout: float = 180.0) -> bytes:
    h = {"xi-api-key": _key(), **(headers or {})}
    req = urllib.request.Request(API + path, data=body, headers=h, method=method)  # noqa: S310 (fixed https base)
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310
                return resp.read()
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")[:300]
            if e.code in (429, 500, 502, 503) and attempt < 2:
                time.sleep(3 + attempt * 5)
                continue
            raise ElError(f"ElevenLabs {method} {path.split('?')[0]} -> {e.code}: {detail}") from None
        except urllib.error.URLError as e:
            if attempt < 2:
                time.sleep(3 + attempt * 5)
                continue
            raise ElError(f"ElevenLabs unreachable: {e.reason}") from None
    raise ElError("unreachable")


def quota() -> dict:
    sub = json.loads(_request("GET", "/v1/user/subscription"))
    used, limit = sub.get("character_count") or 0, sub.get("character_limit") or 0
    return {"tier": sub.get("tier"), "used": used, "limit": limit, "left": limit - used,
            "resets_unix": sub.get("next_character_count_reset_unix")}


@dataclass
class Ledger:
    """Credits spent by this run. budget: the most this run may spend; floor_left: abort below this quota."""

    path: Path
    budget: int
    max_share: float = 0.05
    entries: list[dict] = field(default_factory=list)

    def __post_init__(self) -> None:
        if self.path.exists():
            self.entries = json.loads(self.path.read_text(encoding="utf-8"))["entries"]

    @property
    def spent(self) -> int:
        return sum(e["credits"] for e in self.entries)

    def check(self, estimate: int, q: dict) -> None:
        cap = min(self.budget, int(q["limit"] * self.max_share))
        if self.spent + estimate > cap:
            raise BudgetError(f"budget: spent {self.spent} + ~{estimate} would pass the cap {cap}")
        if q["left"] < estimate * 4:
            raise BudgetError("quota is lower than expected; stopping")

    def add(self, kind: str, label: str, credits: int, chars: int = 0) -> None:
        self.entries.append({"kind": kind, "label": label, "credits": credits, "chars": chars,
                             "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps({"budget": self.budget, "spent": self.spent, "entries": self.entries},
                                        indent=1), encoding="utf-8")


def _paid(ledger: Ledger | None, kind: str, label: str, estimate: int, call, chars: int = 0):
    """Run a paid call, measuring the real credits from the subscription counter (list price as a floor)."""
    if ledger is None:
        return call()
    before = quota()
    ledger.check(estimate, before)
    out = call()
    after = quota()
    # The subscription counter can lag (sound effects showed 0): book the larger of measured and list price.
    ledger.add(kind, label, max(estimate, after["used"] - before["used"]), chars)
    return out


def _hash(obj) -> str:
    return hashlib.sha256(json.dumps(obj, ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:24]


def tts(text: str, voice_id: str, cache: Path, *, model: str = "eleven_v3", language_code: str | None = None,
        settings: dict | None = None, seed: int = 11, ledger: Ledger | None = None, label: str = "") -> tuple[Path, dict]:
    """Voice for one line plus its character alignment (cached by everything that shapes the audio)."""
    body = {"text": text, "model_id": model, "voice_settings": settings or {"stability": 0.5}, "seed": seed}
    if language_code:
        body["language_code"] = language_code
    k = _hash(body | {"voice": voice_id, "fmt": "mp3_44100_192"})
    audio, meta = cache / f"tts-{k}.mp3", cache / f"tts-{k}.json"
    if audio.exists() and meta.exists():
        return audio, json.loads(meta.read_text(encoding="utf-8"))
    cache.mkdir(parents=True, exist_ok=True)

    def call():
        return json.loads(_request(
            "POST", f"/v1/text-to-speech/{voice_id}/with-timestamps?output_format=mp3_44100_192",
            json.dumps(body, ensure_ascii=False).encode("utf-8"),
            {"Content-Type": "application/json", "Accept": "application/json"}))

    data = _paid(ledger, "tts", label or text[:40], len(text), call, len(text))
    audio.write_bytes(base64.b64decode(data["audio_base64"]))
    info = {"text": text, "voice_id": voice_id, "model": model, "chars": len(text),
            "alignment": data.get("alignment"), "normalized_alignment": data.get("normalized_alignment")}
    meta.write_text(json.dumps(info, ensure_ascii=False), encoding="utf-8")
    return audio, info


def sound(prompt: str, seconds: float, cache: Path, *, influence: float = 0.5, ledger: Ledger | None = None,
          label: str = "") -> Path:
    body = {"text": prompt, "duration_seconds": seconds, "prompt_influence": influence}
    out = cache / f"sfx-{_hash(body)}.mp3"
    if out.exists():
        return out
    cache.mkdir(parents=True, exist_ok=True)
    raw = _paid(ledger, "sfx", label or prompt[:40], 200, lambda: _request(
        "POST", "/v1/sound-generation?output_format=mp3_44100_192", json.dumps(body).encode(),
        {"Content-Type": "application/json"}))
    out.write_bytes(raw)
    return out


def music(prompt: str, seconds: float, cache: Path, *, ledger: Ledger | None = None, label: str = "") -> Path:
    estimate = int(-(-seconds * 900 // 60))  # list price: 900 credits per minute
    body = {"prompt": prompt, "music_length_ms": int(seconds * 1000), "force_instrumental": True}
    out = cache / f"music-{_hash(body)}.mp3"
    if out.exists():
        return out
    cache.mkdir(parents=True, exist_ok=True)
    raw = _paid(ledger, "music", label or prompt[:40], estimate, lambda: _request(
        "POST", "/v1/music?output_format=mp3_44100_192", json.dumps(body).encode(),
        {"Content-Type": "application/json"}, timeout=600))
    out.write_bytes(raw)
    return out
