"""Edit plan: frame-exact decisions for one reel in one language, from the storyboard, the action log and the voice.

Every number here is an integer frame at 30 fps. The plan is plain JSON, so the render, the audio mix, the editor
timelines, the cue sheet and the QA all read the same decisions:

- beats: source take, the source-frame map (1x around every logged action, idle stretches sped up to 3x and, past
  that, jump-cut), and camera keyframes that punch in on the logged element box.
- captions: word cards with each word's first and last frame.
- sfx: tap on each logged tap frame, pop on appear events and hook text, whoosh on take changes, chime on payoff.
- voice: where each line starts.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

FPS = 30
PROTECT_BEFORE, PROTECT_AFTER = 6, 16  # frames kept at 1x around every logged action
MAX_SPEED = 3.0
LEAD, TAIL = 2, 5  # voice starts LEAD frames into a beat; the beat holds TAIL frames after the voice ends
PRE_CUT = 3  # cut this many frames before the beat's first action
AHEAD = 45  # frames past a shot whose tap targets captions keep clear of
DRIFT = 0.07  # zoom added over a shot after its last action (a slow push-in instead of a still)


@dataclass
class Seg:
    out: int  # first output frame (beat-relative)
    n: int  # output frames
    src: float  # first source frame
    speed: float  # source frames per output frame (0 = freeze/hold)

    def src_at(self, i: int) -> int:
        return int(math.floor(self.src + (i - self.out) * self.speed + 1e-6))


def frames(seconds: float) -> int:
    return int(math.ceil(seconds * FPS - 1e-6))


def time_map(src_in: int, src_out: int, events: list[int], target: int, max_speed: float = MAX_SPEED) -> list[Seg]:
    """Fit source frames [src_in, src_out) into `target` output frames.

    Frames near events play at 1x. Idle stretches are sped up evenly (at most max_speed); if that is still too long,
    the middle of the longest idle stretches is cut. If the source is short, the last frame holds.
    """
    src_in, src_out = int(src_in), int(max(src_out, src_in + 1))
    keep: list[tuple[int, int]] = []
    for f in sorted(events):
        a, b = max(src_in, f - PROTECT_BEFORE), min(src_out, f + PROTECT_AFTER)
        if a < b:
            if keep and a <= keep[-1][1]:
                keep[-1] = (keep[-1][0], max(keep[-1][1], b))
            else:
                keep.append((a, b))
    # Alternating spans: (start, end, protected)
    spans: list[tuple[int, int, bool]] = []
    cur = src_in
    for a, b in keep:
        if a > cur:
            spans.append((cur, a, False))
        spans.append((a, b, True))
        cur = b
    if cur < src_out:
        spans.append((cur, src_out, False))
    fixed = sum(b - a for a, b, p in spans if p)
    idle = sum(b - a for a, b, p in spans if not p)
    room = max(0, target - fixed)
    segs: list[Seg] = []
    out = 0
    if fixed + idle <= target:  # short: 1x, then hold the last frame
        for a, b, _ in spans:
            segs.append(Seg(out, b - a, a, 1.0))
            out += b - a
        if out < target:
            segs.append(Seg(out, target - out, src_out - 1, 0.0))
        return [s for s in segs if s.n > 0]
    speed = idle / room if room else math.inf
    if speed <= max_speed:
        budget = room
        idle_left = idle
        for a, b, p in spans:
            if p:
                segs.append(Seg(out, b - a, a, 1.0))
                out += b - a
            else:
                n = round((b - a) / idle_left * budget) if idle_left else 0
                n = max(1, n) if b > a and budget > 0 else n
                n = min(n, budget)
                budget -= n
                idle_left -= b - a
                if n:
                    segs.append(Seg(out, n, a, (b - a) / n))
                out += n
    else:  # cut the middle of idle spans so the rest plays at max_speed
        for a, b, p in spans:
            if p:
                segs.append(Seg(out, b - a, a, 1.0))
                out += b - a
            else:
                share = (b - a) / idle if idle else 0
                n = int(room * share)
                if n <= 0:
                    continue
                take = int(n * max_speed)
                if take >= b - a:
                    segs.append(Seg(out, n, a, (b - a) / n))
                else:  # keep the head and the tail of the idle span, cut its middle (a jump cut)
                    h = n // 2
                    segs.append(Seg(out, h, a, max_speed))
                    segs.append(Seg(out + h, n - h, b - (n - h) * max_speed, max_speed))
                out += n
    # Rounding: pad with a hold or trim to the exact target.
    total = sum(s.n for s in segs)
    if total < target:
        last = segs[-1]
        segs.append(Seg(total, target - total, last.src_at(last.out + last.n - 1), 0.0))
    elif total > target:
        over = total - target
        while over and segs:
            s = segs[-1]
            cut = min(over, s.n)
            s.n -= cut
            over -= cut
            if s.n == 0:
                segs.pop()
    return segs


def blank_ranges(spread: list[float], flat: list[float] | None = None, max_spread: float = 5.0,
                 min_flat: float = 0.885, max_run: int = 15) -> list[list[int]]:
    """Source frame ranges [a, b) that are blank: a loading page between two routes.

    Per frame, from a small greyscale thumbnail: `spread` is the standard deviation and `flat` the share of pixels
    within 6 levels of the median (a blank page keeps only its header and tab bar, so it is mostly one tone). Only short
    runs count (at most max_run frames): a long, plain stretch is a real screen, not a flash."""
    flat = flat or [0.0] * len(spread)
    out: list[list[int]] = []
    for i, (sd, fl) in enumerate(zip(spread, flat)):
        if sd < max_spread or fl >= min_flat:
            if out and out[-1][1] == i:
                out[-1][1] = i + 1
            else:
                out.append([i, i + 1])
    return [r for r in out if r[1] - r[0] <= max_run]


def avoid_blank(src: int, blank: list[list[int]]) -> int:
    """A blank source frame shows the last good frame before it instead (or the first after, at the very start)."""
    for a, b in blank:
        if a <= src < b:
            return a - 1 if a > 0 else b
    return src


def out_frame_of(segs: list[Seg], src: int) -> int:
    """First output frame showing source frame `src` (or the nearest after it)."""
    for s in segs:
        for i in range(s.out, s.out + s.n):
            if s.src_at(i) >= src:
                return i
    return segs[-1].out + segs[-1].n - 1 if segs else 0


FIT_MARGIN = 60  # take px kept free on each side of an element that appears


def fit_zoom(box_w: float, src_w: int = 1170) -> float:
    """The most zoom that still shows a box of width box_w (take px) whole, with a margin."""
    return src_w / (box_w + 2 * FIT_MARGIN)


def ease(t: float) -> float:
    """Spring-like ease out (fast start, slight settle)."""
    t = min(max(t, 0.0), 1.0)
    return 1 - (1 - t) ** 3 * math.cos(t * 1.2)


def camera_at(keys: list[dict], f: int) -> tuple[float, float, float]:
    """(cx, cy, z) at beat-relative frame f from keyframes [{f, cx, cy, z, ease}] (eased between keys)."""
    if not keys:
        return (585.0, 1266.0, 1.0)
    if f <= keys[0]["f"]:
        k = keys[0]
        return (k["cx"], k["cy"], k["z"])
    for a, b in zip(keys, keys[1:]):
        if a["f"] <= f <= b["f"]:
            span = max(1, b["f"] - a["f"])
            t = ease((f - a["f"]) / span)
            return tuple(a[k] + (b[k] - a[k]) * t for k in ("cx", "cy", "z"))  # type: ignore[return-value]
    k = keys[-1]
    return (k["cx"], k["cy"], k["z"])


def clamp_camera(cx: float, cy: float, z: float, src_w: int, src_h: int, aspect: float) -> tuple[float, float, float, float]:
    """Crop window (x, y, w, h) in source pixels for camera (cx, cy, z); aspect = out_w / out_h."""
    w = src_w / z
    h = w / aspect
    if h > src_h:
        h = src_h
        w = h * aspect
    x = min(max(cx - w / 2, 0), src_w - w)
    y = min(max(cy - h / 2, 0), src_h - h)
    return (x, y, w, h)


def combine(plans: list[dict], titles: list[str], lang: str, name: str) -> dict:
    """One long-form plan from several reel plans: chapters back to back (each keeps its own hook as the chapter
    opener), one end card. Take ids are prefixed with the reel id so the renderer can find each reel's takes."""
    out = {"id": name, "lang": lang, "fps": FPS, "beats": [], "captions": [], "sfx": [], "voice": [], "title": name}
    t = 0
    for k, (p, title) in enumerate(zip(plans, titles)):
        body = p["end"]["start"]
        bid = lambda x: f"{k + 1}:{p['id']}:{x}" if x else x  # noqa: E731 - shot ids repeat across reels ("hook", "done")
        for b in p["beats"]:
            nb = dict(b, id=bid(b["id"]), start=b["start"] + t, take=f"{p['id']}/{b['take']}", chapter=title)
            if k and b is p["beats"][0]:
                nb["transition"] = "whip"
            out["beats"].append(nb)
        out["captions"] += [dict(c, beat=bid(c.get("beat")), f0=c["f0"] + t, f1=c["f1"] + t,
                                 words=[dict(w, f0=w["f0"] + t, f1=w["f1"] + t) for w in c["words"]]) for c in p["captions"]]
        out["sfx"] += [dict(s, beat=bid(s.get("beat")), f=s["f"] + t) for s in p["sfx"] if s.get("beat") != "end"]
        if k:
            out["sfx"].append({"f": max(0, t - 4), "name": "whoosh", "beat": bid(p["beats"][0]["id"])})
        out["voice"] += [dict(v, beat=bid(v["beat"]), f=v["f"] + t) for v in p["voice"]]
        t += body
    last = plans[-1]
    out["end"] = {"start": t, "frames": 36, "text": last["end"]["text"]}
    out["sfx"].append({"f": t, "name": "pop", "beat": "end"})
    out["sfx"].sort(key=lambda s: s["f"])
    out["frames"] = t + 36
    return out


def build(story: dict, logs: dict[str, dict], voice: dict[str, dict], lang: str) -> dict:
    """Plan for one reel in one language.

    logs: take id -> action log (capture.mjs). voice: beat id -> {"file", "seconds", "words": [Word as dict]}.
    """
    scale = 3.0
    takes_by_id = {t["id"]: t for t in story.get("takes", [])}
    beats_out = []
    captions = []
    sfx = []
    voice_cues = []
    t = 0
    prev_take = None
    for bi, beat in enumerate(story["beats"]):
        log = logs[beat["take"]]
        ev = log["events"]
        marks = {e["mark"]: e for e in ev if e.get("mark")}
        a_ev, b_ev = marks[beat["from"]], marks[beat["to"]]
        src_in = max(0, a_ev["frame"] + beat.get("from_offset", -PRE_CUT))
        src_out = min(log["frames"], b_ev["frame"] + beat.get("to_offset", 0))
        inside = [e for e in ev if src_in <= e["frame"] < src_out and e["type"] in ("tap", "type", "appear", "typed")]
        v = voice.get(beat["id"])
        lead = beat.get("lead", 0 if bi == 0 else LEAD)
        vlen = frames(v["seconds"]) if v else 0
        target = max(beat.get("min_frames", 20), lead + vlen + beat.get("tail", TAIL))
        if beat.get("max_frames"):
            target = min(target, max(beat["max_frames"], lead + vlen + 2))
        segs = time_map(src_in, src_out, [e["frame"] for e in inside], target)
        # Camera keys: punch in on each event's box.
        keys = []
        for e in inside:
            if not e.get("box") or e.get("zoom") == 0:
                continue
            x, y, w, h = (c * scale for c in e["box"])
            z = e.get("zoom") or (1.32 if e["type"] == "tap" else 1.18)
            if e["type"] != "tap":  # an element that appears stays whole in frame: never cut its text at the edge
                z = max(1.0, min(z, fit_zoom(w)))
            of = out_frame_of(segs, e["frame"])
            keys.append({"f": max(0, of - 2), "cx": x + w / 2, "cy": y + h / 2, "z": z, "event": e["i"]})
        cam = beat.get("camera")
        if cam:  # storyboard override: fixed framing
            keys = [{"f": 0, **cam}]
        if keys:
            first = dict(keys[0])
            start = {"f": 0, "cx": first["cx"], "cy": first["cy"], "z": max(1.0, first["z"] - 0.12)}
            if keys[0]["f"] > 0:
                keys.insert(0, start)
            # Slow push-in to the end of the shot, so a held frame never sits dead still.
            keys.append({**keys[-1], "f": target - 1, "z": keys[-1]["z"] + DRIFT})
        else:
            keys = [{"f": 0, "cx": 585.0, "cy": 1266.0, "z": 1.0}, {"f": target - 1, "cx": 585.0, "cy": 1266.0, "z": 1.0 + DRIFT}]
        # Boxes the captions must not cover (take px, with the output frame where each matters).
        # ...including the next tap just after the shot (the button the voice is about to name).
        ahead = [e for e in ev if src_in <= e["frame"] < src_out + AHEAD and e["type"] in ("tap", "type", "appear")]
        avoid = [{"f": min(out_frame_of(segs, e["frame"]), target - 1), "box": [c * scale for c in e["box"]], "type": e["type"]}
                 for e in ahead if e.get("box")]
        take_def = takes_by_id.get(beat["take"], {})
        blur = []
        for spec in take_def.get("blur", []):
            ev_b = marks.get(spec["mark"])
            if ev_b and (spec.get("box") or ev_b.get("box")):
                pad = spec.get("pad", 6)
                x, y, w, h = spec.get("box") or ev_b["box"]  # an explicit CSS-px box, or the mark's element
                blur.append([ev_b["frame"] + spec.get("from_offset", -2), log["frames"] + 1,
                             (x - pad) * scale, (y - pad) * scale, (w + 2 * pad) * scale, (h + 2 * pad) * scale])
        transition = "whip" if prev_take and prev_take != beat["take"] else ("start" if bi == 0 else "cut")
        beats_out.append({"id": beat["id"], "take": beat["take"], "start": t, "frames": target, "src_in": src_in,
                          "src_out": src_out, "segs": [s.__dict__ for s in segs], "camera": keys,
                          "hook": (beat.get("hook") or {}).get(lang), "transition": transition,
                          "payoff": bool(beat.get("payoff")), "avoid": avoid, "blur": blur,
                          "blank": log.get("blank", [])})
        # Sound cues on logged actions (global frames).
        for e in inside:
            of = t + out_frame_of(segs, e["frame"])
            name = e.get("sfx") or {"tap": "tap", "appear": "pop"}.get(e["type"])
            if name and name != "none":
                sfx.append({"f": max(0, of - (1 if name == "tap" else 0)), "name": name, "event": e["i"], "beat": beat["id"]})
        if transition == "whip":
            sfx.append({"f": max(0, t - 4), "name": "whoosh", "beat": beat["id"]})
        if beat.get("hook"):
            sfx.append({"f": t, "name": "pop", "beat": beat["id"]})
        if beat.get("payoff"):
            sfx.append({"f": t + max(0, target - 24), "name": "chime", "beat": beat["id"]})
        if v:
            voice_cues.append({"f": t + lead, "file": v["file"], "beat": beat["id"], "frames": vlen})
            from .words import cards, Word  # local import keeps plan importable without words in tests

            ws = [Word(**w) for w in v["words"]]
            for card in cards(ws):
                captions.append({"beat": beat["id"], "f0": t + lead + int(card[0].start * FPS), "f1": t + lead + frames(card[-1].end),
                                 "words": [{"text": w.text, "key": w.key, "f0": t + lead + int(w.start * FPS),
                                            "f1": t + lead + frames(w.end)} for w in card]})
        prev_take = beat["take"]
        t += target
    # Cards never overlap and each stays until the next one starts (or for a short beat after the line).
    for a, b in zip(captions, captions[1:]):
        a["f1"] = min(max(a["f1"], a["f0"] + 6), b["f0"])
    end = story.get("end", {})
    end_frames = end.get("frames", 24)
    total = t + end_frames
    sfx.append({"f": t, "name": "pop", "beat": "end"})
    sfx.sort(key=lambda s: s["f"])
    return {"id": story["id"], "lang": lang, "fps": FPS, "frames": total, "beats": beats_out, "captions": captions,
            "sfx": sfx, "voice": voice_cues, "end": {"start": t, "frames": end_frames, "text": (end.get("text") or {}).get(lang, "Pulse")},
            "title": story["title"].get(lang) if isinstance(story["title"], dict) else story["title"]}
