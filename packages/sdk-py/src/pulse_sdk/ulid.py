"""ULIDs for CloudEvents ids (02 §3.2).

Collector-derived events use a deterministic ULID: 48-bit timestamp = event time in milliseconds, 80 bits = the
first 80 bits of sha256("source|source_ref|type|ordinal"), so re-normalising raw_inbox reproduces the same ids and
the log's idempotency key turns re-runs into no-ops. Declared events (API, bot) use random ULIDs.
"""

from __future__ import annotations

import hashlib
import os
import time as _time
from datetime import datetime

ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"  # Crockford base32


def _encode(value: int) -> str:
    chars = []
    for _ in range(26):
        chars.append(ALPHABET[value & 31])
        value >>= 5
    return "".join(reversed(chars))


def _ms(when: datetime) -> int:
    if when.tzinfo is None:
        raise ValueError("event time must be timezone-aware (UTC)")
    return int(when.timestamp() * 1000)


def from_parts(ms: int, random80: int) -> str:
    if not 0 <= ms < 1 << 48:
        raise ValueError("timestamp out of ULID range")
    return _encode((ms << 80) | (random80 & ((1 << 80) - 1)))


def new_ulid(when: datetime | None = None) -> str:
    ms = _ms(when) if when else int(_time.time() * 1000)
    return from_parts(ms, int.from_bytes(os.urandom(10), "big"))


def deterministic_ulid(when: datetime, source: str, source_ref: str, event_type: str, ordinal: int = 0) -> str:
    digest = hashlib.sha256(f"{source}|{source_ref}|{event_type}|{ordinal}".encode()).digest()
    return from_parts(_ms(when), int.from_bytes(digest[:10], "big"))


def timestamp_ms(ulid: str) -> int:
    value = 0
    for ch in ulid:
        value = (value << 5) | ALPHABET.index(ch)
    return value >> 80
