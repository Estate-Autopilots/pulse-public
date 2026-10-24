"""Ingest checks that answer before touching the database (the database paths are in tests/core)."""

from __future__ import annotations

import time
import uuid

from pulse_ingest.core import MAX_BODY, ingest_device_batch
from pulse_sdk.signing import generate_keypair, sign_headers

DEVICE = str(uuid.UUID(int=7))


def call(headers, body=b"[]"):
    return ingest_device_batch(None, headers, body)      # no connection: these paths must not reach the database


def test_missing_headers():
    assert call({}).status == 401


def test_stale_or_malformed_timestamp():
    key, _ = generate_keypair()
    assert call(sign_headers(key, DEVICE, b"[]", timestamp=int(time.time()) - 3600)).status == 401
    h = sign_headers(key, DEVICE, b"[]")
    h["X-Pulse-Timestamp"] = "soon"
    assert call(h).status == 401
    h = sign_headers(key, DEVICE, b"[]")
    h["X-Pulse-Device"] = "not-a-uuid"
    assert call(h).status == 401


def test_oversized_body_is_refused_before_anything_else():
    key, _ = generate_keypair()
    big = b"[" + b" " * MAX_BODY + b"]"
    assert call(sign_headers(key, DEVICE, big), big).status == 413
    # JSON shape and batch size are checked only after the signature (tests/core/test_ingest.py)
