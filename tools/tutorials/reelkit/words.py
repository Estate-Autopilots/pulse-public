"""Word timings from ElevenLabs character alignment, word-by-word caption cards and SRT.

A line has what the voice reads (`say`, may hold v3 audio tags like [excited] and Devanagari) and what the
caption shows (`cap`, Roman script). When they differ (Hinglish), both have the same number of words and caption
word i takes the timing of spoken word i. Tags are never shown or timed.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

TAG = re.compile(r"\[[^\]]*\]")


@dataclass(frozen=True)
class Word:
    text: str  # caption text of the word
    start: float  # seconds from the start of the line audio
    end: float
    key: bool = False  # emphasised word (marked *like this* in the caption)


def spoken_words(say: str) -> list[str]:
    return TAG.sub(" ", say).split()


def caption_words(cap: str) -> list[tuple[str, bool]]:
    out = []
    for w in cap.split():
        key = w.startswith("*") and w.rstrip(".,!?:;").endswith("*")
        out.append((w.replace("*", ""), key))
    return out


def check_line(say: str, cap: str) -> list[str]:
    problems = []
    s, c = spoken_words(say), caption_words(cap)
    if len(s) != len(c):
        problems.append(f"say has {len(s)} words, cap has {len(c)}: {cap!r}")
    if re.search(r"\d", TAG.sub("", cap)):
        problems.append(f"digits on screen (spell them out or drop them): {cap!r}")
    if re.search(r"[₹$€£]", cap + say):
        problems.append("money on screen or in the voice")
    return problems


def word_times(say: str, alignment: dict) -> list[tuple[float, float]]:
    """(start, end) per spoken word, from the character alignment of the text that was sent."""
    chars = alignment["characters"]
    starts = alignment["character_start_times_seconds"]
    ends = alignment["character_end_times_seconds"]
    text = "".join(chars)
    # Blank out tags in the aligned text so they never match a word.
    masked = TAG.sub(lambda m: " " * len(m.group(0)), text)
    out: list[tuple[float, float]] = []
    pos = 0
    for w in spoken_words(say):
        i = masked.find(w, pos)
        if i < 0:  # normalisation changed the word: take the next non-space run
            m = re.compile(r"\S+").search(masked, pos)
            if not m:
                break
            i, j = m.start(), m.end()
        else:
            j = i + len(w)
        out.append((starts[i], ends[j - 1]))
        pos = j
    while len(out) < len(spoken_words(say)):  # never leave a word untimed
        last = out[-1][1] if out else 0.0
        out.append((last, last + 0.2))
    return out


def line_words(say: str, cap: str, alignment: dict) -> list[Word]:
    times = word_times(say, alignment)
    caps = caption_words(cap)
    if len(caps) != len(times):
        raise ValueError(check_line(say, cap)[0])
    words = []
    for (text, key), (a, b) in zip(caps, times):
        words.append(Word(text, a, b, key))
    # Close tiny gaps so the highlight never flickers off between words.
    fixed = []
    for i, w in enumerate(words):
        nxt = words[i + 1].start if i + 1 < len(words) else w.end
        end = nxt if 0 < nxt - w.end < 0.25 else w.end
        fixed.append(Word(w.text, w.start, max(end, w.start + 0.06), w.key))
    return fixed


def cards(words: list[Word], max_words: int = 3, max_chars: int = 18) -> list[list[Word]]:
    """Group words into short caption cards: break after punctuation, at max_words or max_chars."""
    out: list[list[Word]] = []
    cur: list[Word] = []
    for w in words:
        if cur and (len(cur) >= max_words or len(" ".join(x.text for x in cur + [w])) > max_chars):
            out.append(cur)
            cur = []
        cur.append(w)
        if w.text[-1:] in ".,!?:;":
            out.append(cur)
            cur = []
    if cur:
        out.append(cur)
    return out


def srt_time(t: float) -> str:
    ms = int(round(max(t, 0) * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02}:{m:02}:{s:02},{ms:03}"


def srt(entries: list[tuple[float, float, str]]) -> str:
    blocks = []
    for n, (a, b, text) in enumerate(entries, 1):
        blocks.append(f"{n}\n{srt_time(a)} --> {srt_time(b)}\n{text}\n")
    return "\n".join(blocks)


def wrap(text: str, width: int = 42) -> str:
    """At most two lines of `width` characters, split near the middle."""
    if len(text) <= width:
        return text
    words = text.split()
    best, best_cost = text, 10**9
    for i in range(1, len(words)):
        a, b = " ".join(words[:i]), " ".join(words[i:])
        cost = max(len(a), len(b))
        if cost < best_cost:
            best, best_cost = f"{a}\n{b}", cost
    return best
