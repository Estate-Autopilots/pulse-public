"""Read TypeScript document-keys.ts v1 envelopes. Never prints keys or opened values."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import stat
from dataclasses import dataclass, field
from pathlib import Path

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

KEY_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,31}")


class DocumentKeyError(ValueError):
    """A keyring/envelope refusal containing no key material or plaintext."""


@dataclass(frozen=True)
class Keyring:
    active: str
    keys: dict[str, bytes] = field(repr=False)

    def fingerprints(self) -> dict[str, str]:
        return {kid: hashlib.sha256(key).hexdigest() for kid, key in self.keys.items()}


def parse_keyring(text: str) -> Keyring:
    keys = {}
    for raw in text.split("\n"):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        if (len(parts) != 2 or not KEY_ID.fullmatch(parts[0]) or parts[0] in keys
                or not re.fullmatch(r"[A-Za-z0-9+/]{43}=", parts[1])):
            raise DocumentKeyError("invalid document keyring")
        keys[parts[0]] = base64.b64decode(parts[1], validate=True)
    if not keys:
        raise DocumentKeyError("empty document keyring")
    return Keyring(next(reversed(keys)), keys)


def load_keyring(reference: str | Path | None = None) -> Keyring:
    """PULSE_DOCUMENT_KEY_FILE: path, file:path or env:NAME containing the keyring text."""
    ref = str(reference or os.environ.get("PULSE_DOCUMENT_KEY_FILE") or "/etc/pulse/document-master.key")
    try:
        if ref.startswith("env:"):
            return parse_keyring(os.environ[ref[4:]])
        with Path(ref.removeprefix("file:")).open("r", encoding="utf8") as source:
            info = os.fstat(source.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o007:
                raise DocumentKeyError("document keyring must be a regular file without world access")
            return parse_keyring(source.read())
    except (OSError, KeyError, UnicodeError):
        raise DocumentKeyError("document keyring unavailable") from None


def _decrypt(key: bytes, sealed: bytes, aad: str) -> bytes:
    if len(key) != 32:
        raise DocumentKeyError("sealed value requires an AES-256 key")
    if len(sealed) < 29 or sealed[0] != 1:
        raise DocumentKeyError("unsupported or truncated sealed envelope")
    return AESGCM(key).decrypt(sealed[1:13], sealed[13:], aad.encode("utf8"))


def open(ring: Keyring, key_id: str, data_key: bytes, data: bytes, context: str) -> bytes:
    """Authenticate the wrapped data key and payload against the exact original context."""
    master = ring.keys.get(key_id)
    if master is None:
        raise DocumentKeyError("document key ID unavailable")
    try:
        key = _decrypt(master, data_key, f"pulse.data-key.v1\n{key_id}\n{context}")
        return _decrypt(key, data, f"pulse.sealed.v1\n{context}")
    except (InvalidTag, ValueError):
        raise DocumentKeyError("sealed value authentication failed") from None


if __name__ == "__main__":
    print(json.dumps(load_keyring().fingerprints(), sort_keys=True))
