"""PR-PIPELINE: the copy checks of a creative (spelling and privacy). The visual checks (contrast, 360px legibility,
crop safety) are measured in the browser by render.mjs. Pure functions, tested in tests/test_pr_pipeline_tools.py."""
from __future__ import annotations

import os
import re
import shutil
import subprocess
from functools import lru_cache
from pathlib import Path

HERE = Path(__file__).resolve().parent
PHONE = re.compile(r"(?<![\w.])\+?\d[\d\s().-]{8,}\d(?!\w)")
EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
PRIVATE = re.compile(r"\b(salar\w*|payroll|pay ?slips?|payouts?|appraisals?|increments?|bonus\w*|incentives?|reimburs\w*|resign\w*|terminat\w*|"
                     r"disciplin\w*|medical|health|pregnan\w*|family|wife|husband|daughter|son|loans?|bank|ifsc|aadha\w*|pan card|passport|"
                     r"passwords?|otp|penalt\w*|confidential|home address|date of birth)\b", re.IGNORECASE)
WORD = re.compile(r"[A-Za-z][A-Za-z'’-]*[A-Za-z]|[A-Za-z]")


def privacy(texts: list[str]) -> dict:
    """No phone numbers, e-mail addresses, pay, HR, health or family words in a creative."""
    found = []
    for t in texts:
        for rx, what in ((PHONE, "phone number"), (EMAIL, "e-mail address"), (PRIVATE, "private word")):
            for m in rx.finditer(t or ""):
                found.append(f"{what}: {m.group(0)[:40]}")
    return {"ok": not found, "found": found[:10]}


@lru_cache(maxsize=1)
def _words() -> tuple[frozenset, str]:
    for p in (os.environ.get("PR_PIPELINE_WORDS"), str(Path.home() / ".local/share/pulse-pr-pipeline/words.txt"), "/usr/share/dict/words"):
        if p and Path(p).is_file():
            return frozenset(w.strip().lower() for w in Path(p).read_text(encoding="utf-8", errors="ignore").split()), p
    return frozenset(), ""


def allowlist(extra: list[str] = ()) -> set:
    words = set()
    f = HERE / "allowlist.txt"
    if f.is_file():
        words |= {w.strip().lower() for w in f.read_text(encoding="utf-8").split() if w.strip() and not w.startswith("#")}
    for e in extra:
        words |= {w.lower() for w in WORD.findall(e or "")}
    return words


def known(word: str, dictionary: frozenset) -> bool:
    w = word.lower().replace("’", "'").strip("'-")
    if not w or w in dictionary:
        return True
    # Plurals and possessives only: the word list carries the other inflections ("shipped"), so "shiped" stays unknown.
    for base in (w.removesuffix("'s"), w.removesuffix("s"), w.removesuffix("es"), w.removesuffix("ies") + "y"):
        if base and base in dictionary:
            return True
    return all(known(p, dictionary) for p in w.split("-")) if "-" in w else False


def spelling(texts: list[str], extra_words: list[str] = (), dictionary: frozenset | None = None) -> dict:
    """Words not in the dictionary (hunspell when installed, else a word list). Acronyms, numbers, brand words and the
    allowlist pass. Without any dictionary the check is skipped (ok, with a note)."""
    allow = allowlist(extra_words)
    tokens = [m for t in texts for m in WORD.findall(t or "")]
    tokens = [t for t in tokens if not (t.isupper() and len(t) <= 6) and len(t) > 2 and t.lower() not in allow]
    if dictionary is None and shutil.which("hunspell"):
        r = subprocess.run(["hunspell", "-l", "-d", os.environ.get("PR_PIPELINE_HUNSPELL", "en_US")], input="\n".join(tokens),
                           capture_output=True, text=True, timeout=30, check=False)
        if r.returncode == 0:
            bad = sorted(set(r.stdout.split()))
            return {"ok": not bad, "unknown": bad[:20], "dictionary": "hunspell"}
    d, src = (dictionary, "given") if dictionary is not None else _words()
    if not d:
        return {"ok": True, "skipped": "no dictionary on this server", "unknown": []}
    bad = sorted({t for t in tokens if not known(t, d)})
    return {"ok": not bad, "unknown": bad[:20], "dictionary": Path(src).name if src != "given" else src}
