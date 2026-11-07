"""What may be extracted from a Drive file, and running the extractor in its sandbox.

Before any byte is fetched a file is checked by name and folder (chats, WhatsApp exports, government ID material and
the snapshot collector's sensitive paths are excluded), by type (only the approved small set is read; macro-enabled
types are quarantined; everything else is labelled unsupported) and by size. After extraction the text itself is
screened for ID numbers and chat-export lines, so such content is never stored even when its name looked harmless.
"""

from __future__ import annotations

import functools
import importlib.util
import json
import math
import os
import re
import shutil
import signal
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from pulse_gdrive_snapshot.backfill import is_sensitive_path

SANDBOX_ENV = "PULSE_DRIVE_EXTRACT_SANDBOX"         # auto (default) | bwrap | rlimit
SANDBOX_SCRIPT = Path(__file__).with_name("sandbox.py")
DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
GOOGLE_EXPORT_LIMIT = 10 * 1024 * 1024               # Drive refuses to export more than this
DEFAULT_TIMEOUT = 20.0
DEFAULT_MEMORY = 768 * 1024 * 1024
DEFAULT_MAX_TEXT = 8_000_000

# mime -> (format key, export mime for Google-native files, sandbox kind)
FORMATS: dict[str, tuple[str, str | None, str]] = {
    "text/plain": ("text", None, "text"),
    "text/markdown": ("text", None, "text"),
    "text/csv": ("csv", None, "csv"),
    "application/pdf": ("pdf", None, "pdf"),
    DOCX: ("docx", None, "docx"),
    "application/vnd.google-apps.document": ("gdoc", DOCX, "docx"),
    "application/vnd.google-apps.spreadsheet": ("gsheet", "text/csv", "csv"),
    "application/vnd.google-apps.presentation": ("gslides", "text/plain", "text"),
}
FORMAT_KEYS = ("text", "csv", "pdf", "docx", "gdoc", "gsheet", "gslides")
FORMAT_GAPS = {"gsheet": ["first_sheet_only"], "gslides": ["slide_text_only"]}
MACRO_MIMES = {
    "application/vnd.ms-word.document.macroenabled.12", "application/vnd.ms-word.template.macroenabled.12",
    "application/vnd.ms-excel.sheet.macroenabled.12", "application/vnd.ms-excel.template.macroenabled.12",
    "application/vnd.ms-excel.addin.macroenabled.12", "application/vnd.ms-excel.sheet.binary.macroenabled.12",
    "application/vnd.ms-powerpoint.presentation.macroenabled.12",
    "application/vnd.ms-powerpoint.slideshow.macroenabled.12",
}

_CHAT_NAME = re.compile(
    r"(?<![a-z])(?:whats ?app|wa chat|chats? (?:export|history|backup|logs?)|msgstore|telegram|signal backup|"
    r"chat with)(?![a-z])")
_ID_NAME = re.compile(
    r"(?<![a-z])(?:aadh?aa?r|uidai|pan cards?|passports?|voter ids?|voters? cards?|driving licen[cs]es?|"
    r"govt ids?|government ids?|e ?kyc|kyc|ration cards?|identity (?:proofs?|documents?|cards?)|id proofs?)(?![a-z])")
_AADHAAR = re.compile(r"(?<!\d)([2-9]\d{3})[ -](\d{4})[ -](\d{4})(?!\d)")
_AADHAAR_LABELLED = re.compile(r"(?i)aadh?aa?r[^\n\d]{0,40}(?<!\d)([2-9]\d{11})(?!\d)")
# Verhoeff tables: every Aadhaar number ends in this check digit, which keeps invoice and phone numbers out.
_VD = [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5], [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
       [3, 4, 0, 1, 2, 8, 9, 5, 6, 7], [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
       [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3], [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
       [9, 8, 7, 6, 5, 4, 3, 2, 1, 0]]
_VP = [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4], [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
       [8, 9, 1, 6, 0, 4, 3, 5, 2, 7], [9, 4, 5, 3, 1, 2, 7, 6, 0, 8], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
       [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8]]
_PAN = re.compile(r"(?<![A-Za-z0-9])[A-Z]{3}[ABCFGHJLPT][A-Z]\d{4}[A-Z](?![A-Za-z0-9])")
_CHAT_LINE = re.compile(
    r"^\[?\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4},?\s+\d{1,2}:\d{2}(?::\d{2})?(?:\s?[APap]\.?[Mm]\.?)?\]?\s+(?:-\s+)?"
    r"[^:\n]{1,60}:\s", re.M)


class SandboxUnavailable(Exception):
    """bubblewrap was required (PULSE_DRIVE_EXTRACT_SANDBOX=bwrap) but does not work on this host."""


@dataclass(frozen=True)
class Plan:
    """What to do with one file before fetching it: read it (format/export/kind) or record status and reason."""
    status: str | None = None
    reason: str | None = None
    format: str | None = None
    export_mime: str | None = None
    kind: str | None = None


@dataclass
class Outcome:
    status: str
    reason: str | None = None
    text: str | None = None
    facts: dict[str, Any] | None = None
    extractor: str | None = None
    sandbox: str | None = None
    elapsed_ms: int = 0
    gaps: list[str] = field(default_factory=list)


def _segment(part: str) -> str:
    return re.sub(r"[\s_.\-]+", " ", part.strip().casefold())


def excluded_reason(names: list[str]) -> str | None:
    """Why a file named `names[0]` inside folders `names[1:]` never enters extraction, or None."""
    parts = [_segment(n) for n in names if n and n.strip()]
    if any(_CHAT_NAME.search(p) for p in parts):
        return "chat_source"
    if any(_ID_NAME.search(p) for p in parts):
        return "government_id"
    if is_sensitive_path("/".join(reversed([n for n in names if n]))):
        return "sensitive_path"
    return None


def plan(mime: str, size: int | None, names: list[str], formats: list[str], max_bytes: int) -> Plan:
    reason = excluded_reason(names)
    if reason:
        return Plan("excluded", reason)
    lowered = (mime or "").lower()
    if lowered in MACRO_MIMES:
        return Plan("quarantined", "macro")
    known = FORMATS.get(lowered)
    if known is None:
        if lowered.startswith("image/"):
            return Plan("unsupported", "needs_ocr")       # no automatic OCR of private documents
        if lowered.startswith(("audio/", "video/")):
            return Plan("unsupported", "media")
        return Plan("unsupported", "format_not_supported")
    key, export, kind = known
    if key not in formats:
        return Plan("unsupported", "format_not_approved")
    if size is not None and size > max_bytes:
        return Plan("quarantined", "oversized")
    return Plan(format=key, export_mime=export, kind=kind)


def verhoeff_valid(digits: str) -> bool:
    check = 0
    for i, digit in enumerate(reversed(digits)):
        check = _VD[check][_VP[i % 8][int(digit)]]
    return check == 0


def screen(text: str) -> str | None:
    """Content that must not be stored even when the file's name looked harmless."""
    numbers = ["".join(m.groups()) for m in _AADHAAR.finditer(text)] + _AADHAAR_LABELLED.findall(text)
    if any(verhoeff_valid(n) for n in numbers) or _PAN.search(text):
        return "government_id_content"
    if len(_CHAT_LINE.findall(text, 0, 200_000)) >= 3:
        return "chat_content"
    return None


# --------------------------------------------------------------------------------------------------------- sandbox
def _python_paths() -> list[str]:
    """Read-only paths the child needs: the interpreter, the environment's packages and pypdf, and this script."""
    paths = {sys.base_prefix, sys.prefix, str(SANDBOX_SCRIPT.parent)}
    spec = importlib.util.find_spec("pypdf")
    if spec and spec.origin:
        paths.add(str(Path(spec.origin).parent.parent))
    return sorted(p for p in paths if p and p != "/")


def _links(path: str) -> list[tuple[str, str]]:
    """Every symbolic link met while resolving `path` (e.g. a virtualenv's python pointing through a version alias),
    as (target, link), so the sandbox can recreate them next to the read-only binds."""
    links, todo, seen = [], [path], set()
    while todo:
        parts = Path(todo.pop()).parts
        for i in range(1, len(parts) + 1):
            prefix = os.path.join(*parts[:i])
            if os.path.islink(prefix) and prefix not in seen:
                seen.add(prefix)
                target = os.readlink(prefix)
                links.append((target, prefix))
                todo.append(os.path.join(os.path.normpath(os.path.join(os.path.dirname(prefix), target)), *parts[i:]))
                break
    return [(t, link) for t, link in links if link not in ("/lib", "/lib64", "/bin") and not link.startswith("/usr/")]


def _bwrap_prefix() -> list[str]:
    cmd = ["bwrap", "--unshare-all", "--die-with-parent", "--new-session", "--cap-drop", "ALL",
           "--ro-bind", "/usr", "/usr", "--dev", "/dev", "--tmpfs", "/tmp"]
    for link in ("/lib", "/lib64", "/bin"):
        if os.path.islink(link):
            cmd += ["--symlink", os.readlink(link), link]
        elif os.path.isdir(link):
            cmd += ["--ro-bind", link, link]
    for path in _python_paths():
        if not path.startswith("/usr/"):
            cmd += ["--ro-bind", path, path]
    for target, link in _links(sys.executable):
        cmd += ["--symlink", target, link]
    return cmd + ["--chdir", "/tmp", "--"]


@functools.cache
def _bwrap_works() -> bool:
    if not shutil.which("bwrap"):
        return False
    try:
        probe = subprocess.run(_bwrap_prefix() + [sys.executable, "-I", "-c", "import pypdf"], capture_output=True,
                               timeout=20, env=_child_env(), check=False)
    except (OSError, subprocess.SubprocessError):
        return False
    return probe.returncode == 0


def sandbox_mode() -> str:
    wanted = os.environ.get(SANDBOX_ENV, "auto")
    if wanted == "rlimit":
        return "rlimit"
    if _bwrap_works():
        return "bwrap"
    if wanted == "bwrap":
        raise SandboxUnavailable()
    return "rlimit"


def _child_env() -> dict[str, str]:
    return {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"}     # no database URL, credential or token reaches the child


def run_extractor(kind: str, data: bytes, *, timeout: float = DEFAULT_TIMEOUT, memory: int = DEFAULT_MEMORY,
                  max_text: int = DEFAULT_MAX_TEXT, max_input: int | None = None) -> Outcome:
    """Extract in a separate, limited process. A timeout, a crash or anything unexpected quarantines the file."""
    mode = sandbox_mode()
    cpu = max(1, math.ceil(timeout)) + 1
    args = [sys.executable, "-I", str(SANDBOX_SCRIPT), kind, str(max_input or len(data)), str(max_text), str(cpu),
            str(memory)]
    cmd = (_bwrap_prefix() + args) if mode == "bwrap" else args
    started = time.monotonic()
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                            env=_child_env(), cwd="/", start_new_session=True)
    try:
        out, _ = proc.communicate(data, timeout=timeout)
    except subprocess.TimeoutExpired:
        _kill(proc)
        return Outcome("quarantined", "extractor_timeout", sandbox=mode, elapsed_ms=_ms(started))
    except BrokenPipeError:
        _kill(proc)
        out = b""
    elapsed = _ms(started)
    # Killed by its CPU limit: a negative signal number directly, 128 + the signal through bubblewrap.
    if proc.returncode in (-signal.SIGXCPU, -signal.SIGKILL, 128 + signal.SIGXCPU, 128 + signal.SIGKILL):
        return Outcome("quarantined", "extractor_timeout", sandbox=mode, elapsed_ms=elapsed)
    if proc.returncode != 0:
        return Outcome("quarantined", "extractor_crash", sandbox=mode, elapsed_ms=elapsed)
    try:
        result = json.loads(out.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return Outcome("quarantined", "extractor_crash", sandbox=mode, elapsed_ms=elapsed)
    return _validated(result, mode, elapsed)


def _validated(result: Any, mode: str, elapsed: int) -> Outcome:
    bad = Outcome("quarantined", "extractor_crash", sandbox=mode, elapsed_ms=elapsed)
    if not isinstance(result, dict) or not isinstance(result.get("extractor"), str):
        return bad
    status, reason = result.get("status"), result.get("reason")
    if status == "extracted":
        text, facts = result.get("text"), result.get("facts")
        if not isinstance(text, str) or not isinstance(facts, dict):
            return bad
        gaps = [g for g in facts.pop("gaps", []) if isinstance(g, str) and re.fullmatch(r"[a-z_]{1,40}", g)]
        return Outcome("extracted", None, text, facts, result["extractor"], mode, elapsed, gaps)
    if status in ("quarantined", "unsupported") and isinstance(reason, str) and re.fullmatch(r"[a-z_]{1,40}", reason):
        return Outcome(status, reason, extractor=result["extractor"], sandbox=mode, elapsed_ms=elapsed)
    return bad


def _kill(proc: subprocess.Popen) -> None:
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass
    proc.wait()


def _ms(started: float) -> int:
    return int((time.monotonic() - started) * 1000)
