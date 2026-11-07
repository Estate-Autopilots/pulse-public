"""Audio for a plan: voice lines, SFX on logged actions and an upbeat bed ducked under the voice, mastered by ffmpeg
loudnorm (two passes) to -14 LUFS integrated, -1 dBTP. Mixing is done in numpy at 48 kHz so every cue lands on its
exact frame (1 frame = 1600 samples)."""

from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

import numpy as np

SR = 48_000
SPF = SR // 30  # samples per frame


def load(path: Path) -> np.ndarray:
    raw = subprocess.run(["ffmpeg", "-loglevel", "error", "-i", str(path), "-f", "f32le", "-ac", "2", "-ar", str(SR), "-"],
                         check=True, capture_output=True).stdout
    return np.frombuffer(raw, np.float32).reshape(-1, 2).copy()


def db(x: float) -> float:
    return 10 ** (x / 20)


def place(track: np.ndarray, clip: np.ndarray, at: int, gain: float = 1.0) -> None:
    if at >= len(track):
        return
    n = min(len(clip), len(track) - at)
    track[at:at + n] += clip[:n] * gain


def envelope(x: np.ndarray, attack_ms: float = 15, release_ms: float = 280) -> np.ndarray:
    """Peak-following envelope of a mono signal, per 10 ms block, then expanded to samples."""
    block = SR // 100
    mono = np.abs(x).max(axis=1)
    n = len(mono) // block + 1
    pad = np.zeros(n * block, np.float32)
    pad[: len(mono)] = mono
    peaks = pad.reshape(n, block).max(axis=1)
    a, r = np.exp(-10 / attack_ms), np.exp(-10 / release_ms)
    env = np.zeros(n, np.float32)
    v = 0.0
    for i, p in enumerate(peaks):
        v = a * v + (1 - a) * p if p > v else r * v + (1 - r) * p
        env[i] = v
    return np.repeat(env, block)[: len(x)]


def bed(music: np.ndarray, length: int, xfade: int = SR) -> np.ndarray:
    """Loop the music bed to `length` samples, crossfading `xfade` samples at each seam."""
    out = np.zeros((length, 2), np.float32)
    ramp = np.linspace(0, 1, xfade, dtype=np.float32)[:, None]
    pos, first = 0, True
    while pos < length:
        seg = music.copy()
        if not first:
            seg[:xfade] *= ramp
        seg[-xfade:] *= 1 - ramp
        n = min(len(seg), length - pos)
        out[pos: pos + n] += seg[:n]
        pos += len(seg) - xfade
        first = False
    return out


def mix(plan: dict, kit: dict, sfx_files: dict[str, Path], music_file: Path | None, out_dir: Path,
        music_db: float = -15.0, duck_db: float = -11.0) -> dict:
    """Write voice/sfx/music stems and the premix (WAV, 48 kHz); return the stem paths."""
    n = plan["frames"] * SPF
    voice = np.zeros((n, 2), np.float32)
    for v in plan["voice"]:
        place(voice, load(Path(v["file"])), v["f"] * SPF)
    fx = np.zeros((n, 2), np.float32)
    cache: dict[str, np.ndarray] = {}
    for s in plan["sfx"]:
        clip = cache.setdefault(s["name"], load(sfx_files[s["name"]]))
        place(fx, clip, s["f"] * SPF, db(kit["sfx"][s["name"]].get("gain_db", -10)))
    music = np.zeros((n, 2), np.float32)
    if music_file:
        m = bed(load(music_file), n)
        env = envelope(voice)
        duck = np.where(env > 0.02, db(duck_db), 1.0).astype(np.float32)
        # Smooth the gain so the bed breathes instead of pumping (60 ms).
        k = int(SR * 0.06)
        duck = np.convolve(duck, np.ones(k, np.float32) / k, mode="same")
        fade = np.ones(n, np.float32)
        fi, fo = int(SR * 0.25), int(SR * 0.9)
        fade[:fi] = np.linspace(0, 1, fi)
        fade[-fo:] = np.linspace(1, 0, fo)
        music = m * (db(music_db) * duck * fade)[:, None]
    out_dir.mkdir(parents=True, exist_ok=True)
    paths = {}
    for name, arr in (("voice", voice), ("sfx", fx), ("music", music)):
        paths[name] = out_dir / f"{name}.wav"
        write_wav(paths[name], arr)
    premix = voice + fx + music
    peak = float(np.abs(premix).max() or 1)
    if peak > 0.98:
        premix *= 0.98 / peak
    paths["premix"] = out_dir / "premix.wav"
    write_wav(paths["premix"], premix)
    return paths


def write_wav(path: Path, arr: np.ndarray) -> None:
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-f", "f32le", "-ac", "2", "-ar", str(SR), "-i", "-",
                    "-c:a", "pcm_s24le", str(path)], input=arr.astype(np.float32).tobytes(), check=True)


def loudnorm(src: Path, dst: Path, target: float = -14.0, tp: float = -1.0, lra: float = 11.0) -> dict:
    """Two-pass EBU R128 loudness normalisation; returns the measured first pass."""
    first = subprocess.run(["ffmpeg", "-hide_banner", "-i", str(src), "-af", f"loudnorm=I={target}:TP={tp}:LRA={lra}:print_format=json",
                            "-f", "null", "-"], capture_output=True, text=True).stderr
    m = json.loads(re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", first, re.S).group(0))
    af = (f"loudnorm=I={target}:TP={tp}:LRA={lra}:measured_I={m['input_i']}:measured_TP={m['input_tp']}:"
          f"measured_LRA={m['input_lra']}:measured_thresh={m['input_thresh']}:offset={m['target_offset']}:linear=true")
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(src), "-af", af, "-ar", str(SR), "-c:a", "pcm_s24le", str(dst)], check=True)
    return m


def mux(video: Path, audio: Path, out: Path) -> None:
    subprocess.run(["nice", "-n", "19", "ffmpeg", "-loglevel", "error", "-y", "-i", str(video), "-i", str(audio), "-map", "0:v", "-map", "1:a",
                    "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", str(SR), "-shortest", "-movflags", "+faststart", str(out)], check=True)
