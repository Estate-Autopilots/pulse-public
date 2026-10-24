"""Versioned compressed payloads for captured text and facts.

A payload is addressed by the SHA-256 of its uncompressed bytes and stored with its codec, schema and both lengths.
Every payload is decompressed and compared before it is written, and every read checks the codec, the length and the
hash, so a damaged payload is reported as corrupt instead of returning different text. zlib is the codec because both
the Python worker and the Node API decode it without extra dependencies.
"""

from __future__ import annotations

import hashlib
import json
import zlib
from dataclasses import dataclass
from typing import Any

CODEC = "zlib"
TEXT_SCHEMA = "pulse.drive.text/1"
FACTS_SCHEMA = "pulse.drive.facts/1"
SCHEMAS = (TEXT_SCHEMA, FACTS_SCHEMA)
LEVEL = 9


class PayloadCorrupt(Exception):
    """The stored bytes do not decode to the recorded length and hash."""


@dataclass(frozen=True)
class Payload:
    sha256: str
    schema: str
    codec: str
    raw_length: int
    data: bytes

    @property
    def stored_length(self) -> int:
        return len(self.data)


def canonical_json(value: Any) -> bytes:
    """Facts as canonical JSON: the same facts always give the same bytes and hash."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
                      allow_nan=False).encode("utf-8")


def encode(raw: bytes, schema: str, codec: str = CODEC) -> Payload:
    if schema not in SCHEMAS:
        raise ValueError(f"unknown payload schema {schema}")
    if codec != CODEC:
        raise ValueError(f"unknown codec {codec}")
    payload = Payload(hashlib.sha256(raw).hexdigest(), schema, codec, len(raw), zlib.compress(raw, LEVEL))
    if decode(payload.codec, payload.data, payload.sha256, payload.raw_length) != raw:   # never store a lossy payload
        raise PayloadCorrupt("round trip differs")
    return payload


def decode(codec: str, data: bytes, sha256: str, raw_length: int) -> bytes:
    """The exact uncompressed bytes, or PayloadCorrupt. Decompression stops one byte past the recorded length, so a
    damaged or hostile payload cannot expand without bound."""
    if codec != CODEC:
        raise PayloadCorrupt(f"unknown codec {codec}")
    try:
        inflater = zlib.decompressobj()
        raw = inflater.decompress(bytes(data), raw_length + 1)
        if not inflater.eof or inflater.unconsumed_tail or inflater.unused_data:
            raise PayloadCorrupt("stream does not end where it should")
    except zlib.error as exc:
        raise PayloadCorrupt("stream does not decode") from exc
    if len(raw) != raw_length or hashlib.sha256(raw).hexdigest() != sha256:
        raise PayloadCorrupt("length or hash differs")
    return raw


def text_payload(text: str) -> Payload:
    return encode(text.encode("utf-8"), TEXT_SCHEMA)


def facts_payload(facts: dict[str, Any]) -> Payload:
    return encode(canonical_json(facts), FACTS_SCHEMA)
