"""Signed device batches (05 §8.3).

Headers: X-Pulse-Device, X-Pulse-Timestamp (unix seconds), X-Pulse-Nonce (16 random bytes, base64url),
X-Pulse-Signature = base64(Ed25519(device_id "\\n" timestamp "\\n" nonce "\\n" hex(sha256(body)))).
Public keys are stored as base64 of the 32 raw bytes.
"""

from __future__ import annotations

import base64
import hashlib
import os
import time

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey


def message(device_id: str, timestamp: str, nonce: str, body: bytes) -> bytes:
    return f"{device_id}\n{timestamp}\n{nonce}\n{hashlib.sha256(body).hexdigest()}".encode()


def generate_keypair() -> tuple[Ed25519PrivateKey, str]:
    key = Ed25519PrivateKey.generate()
    raw = key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    return key, base64.b64encode(raw).decode()


def new_nonce() -> str:
    return base64.urlsafe_b64encode(os.urandom(16)).rstrip(b"=").decode()


def sign_headers(key: Ed25519PrivateKey, device_id: str, body: bytes, timestamp: int | None = None,
                 nonce: str | None = None) -> dict[str, str]:
    ts = str(int(timestamp if timestamp is not None else time.time()))
    nonce = nonce or new_nonce()
    sig = key.sign(message(device_id, ts, nonce, body))
    return {
        "X-Pulse-Device": device_id,
        "X-Pulse-Timestamp": ts,
        "X-Pulse-Nonce": nonce,
        "X-Pulse-Signature": base64.b64encode(sig).decode(),
    }


def verify(public_key_b64: str, signature_b64: str, msg: bytes) -> bool:
    try:
        key = Ed25519PublicKey.from_public_bytes(base64.b64decode(public_key_b64, validate=True))
        key.verify(base64.b64decode(signature_b64, validate=True), msg)
        return True
    except (InvalidSignature, ValueError, TypeError):
        return False
