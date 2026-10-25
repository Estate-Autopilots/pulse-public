"""Version 1 signed, chunk-encrypted organisation-transfer stream. No plaintext files."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import shutil
import struct
from contextlib import contextmanager
from pathlib import Path

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ed25519, x25519
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

CHUNK = 1024 * 1024
MAGIC = b"PULSEOT1\n"
SUITE = "X25519-HKDF-SHA256-AES256GCM-Ed25519"
KDF_INFO = b"pulse.org-transfer.v1/kdf\0"
AAD_DOMAIN = b"pulse.org-transfer.v1/aad\0"
SIGN_DOMAIN = b"pulse.org-transfer.v1/sig\0"
FRAME = struct.Struct(">BI")


def fingerprint(key) -> str:
    if hasattr(key, "public_key"):
        key = key.public_key()
    return hashlib.sha256(key.public_bytes_raw()).hexdigest()


def load_key(reference: str | Path, kind: str, *, private: bool = False):
    """PEM or base64 raw 32-byte key, from a file or explicit env:NAME (never inline secrets)."""
    reference = str(reference)
    data = (os.environ[reference[4:]].encode() if reference.startswith("env:")
            else Path(reference.removeprefix("file:")).read_bytes())
    cls = {("x25519", False): x25519.X25519PublicKey, ("x25519", True): x25519.X25519PrivateKey,
           ("ed25519", False): ed25519.Ed25519PublicKey, ("ed25519", True): ed25519.Ed25519PrivateKey}[kind, private]
    if data.startswith(b"-----BEGIN"):
        key = (serialization.load_pem_private_key(data, password=None) if private
               else serialization.load_pem_public_key(data))
    else:
        raw = base64.b64decode(data.strip(), validate=True)
        key = cls.from_private_bytes(raw) if private else cls.from_public_bytes(raw)
    if not isinstance(key, cls):
        raise ValueError("incorrect transfer key type")
    return key


def _read(stream, size):
    value = stream.read(size)
    if len(value) != size:
        raise ValueError("truncated transfer archive")
    return value


def _cipher(shared, header):
    return AESGCM(HKDF(algorithm=hashes.SHA256(), length=32, salt=base64.b64decode(header["salt"], validate=True),
                       info=KDF_INFO).derive(shared))


def _nonce(header, counter, final):
    return base64.b64decode(header["nonce"], validate=True) + struct.pack(">IB", counter, final)


def _frame(stream, counter):
    if counter >= 2**32:
        raise ValueError("transfer chunk counter exhausted")
    frame = _read(stream, FRAME.size)
    final, length = FRAME.unpack(frame)
    if final not in (0, 1) or not 16 <= length <= CHUNK + 16 or (not final and length != CHUNK + 16):
        raise ValueError("invalid transfer chunk framing")
    return final, frame + _read(stream, length)


def write_archive(path: Path, recipient, signing_key, chunks, *, required_bytes: int):
    """Encrypt an iterable of byte blocks; required_bytes is the caller's conservative output estimate."""
    path = Path(path)
    if Path("/tmp") == path.resolve() or Path("/tmp") in path.resolve().parents:
        raise ValueError("transfer output must be outside /tmp")
    if required_bytes < 0 or shutil.disk_usage(path.parent).free < required_bytes + 2 * CHUNK:
        raise ValueError("insufficient space for transfer archive")
    ephemeral = x25519.X25519PrivateKey.generate()
    header = {"version": 1, "suite": SUITE, "ephemeral": base64.b64encode(
        ephemeral.public_key().public_bytes_raw()).decode(), "salt": base64.b64encode(os.urandom(32)).decode(),
        "nonce": base64.b64encode(os.urandom(7)).decode(), "recipient": fingerprint(recipient),
        "signer": fingerprint(signing_key)}
    encoded = json.dumps(header, sort_keys=True, separators=(",", ":")).encode()
    prefix = MAGIC + struct.pack(">I", len(encoded)) + encoded
    cipher, digest = _cipher(ephemeral.exchange(recipient), header), hashlib.sha256()
    # O_EXCL also refuses symlinks and existing files. Never truncate an operator's file.
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "wb") as out:
            out.write(prefix)
            counter, pending = 0, bytearray()

            def emit(plain, final):
                nonlocal counter
                if counter >= 2**32:
                    raise ValueError("transfer chunk counter exhausted")
                encrypted = cipher.encrypt(_nonce(header, counter, final), plain,
                                           AAD_DOMAIN + prefix + struct.pack(">IB", counter, final))
                frame = FRAME.pack(final, len(encrypted)) + encrypted
                out.write(frame)
                digest.update(frame)
                counter += 1

            for block in chunks:
                block = memoryview(block)
                while block:
                    take = min(CHUNK - len(pending), len(block))
                    pending.extend(block[:take])
                    block = block[take:]
                    if len(pending) == CHUNK:
                        emit(bytes(pending), 0)
                        pending.clear()
            emit(bytes(pending), 1)
            out.write(signing_key.sign(SIGN_DOMAIN + prefix + digest.digest()))
            out.flush()
            os.fsync(out.fileno())
    except BaseException:
        path.unlink(missing_ok=True)
        raise
    return header


@contextmanager
def open_archive(path: Path, identity, signer):
    """Verify the entire signed ciphertext before deriving a key or yielding decrypted blocks.

    The caller must consume the iterator to completion to authenticate the final marker. Keep
    the context open while consuming it; the same file descriptor is used for both passes.
    The second pass re-reads disk, so bytes may change after signature verification. Each frame
    remains AES-GCM-bound to the verified in-memory header: only its signed writer knew the
    ephemeral private key. Import readers must preserve this AAD binding.
    """
    with Path(path).open("rb") as stream:
        prefix = _read(stream, len(MAGIC) + 4)
        length = struct.unpack(">I", prefix[-4:])[0]
        if prefix[:-4] != MAGIC or not 1 <= length <= 16384:
            raise ValueError("invalid transfer header")
        encoded = _read(stream, length)
        prefix += encoded
        header = json.loads(encoded)
        if not isinstance(header, dict):
            raise ValueError("transfer header must be a JSON object")
        if header.get("version") != 1 or header.get("suite") != SUITE:
            raise ValueError("unsupported transfer archive")
        start, counter, digest = stream.tell(), 0, hashlib.sha256()
        while True:
            final, frame = _frame(stream, counter)
            digest.update(frame)
            counter += 1
            if final:
                break
        signature = _read(stream, 64)
        if stream.read(1):
            raise ValueError("trailing transfer data")
        try:
            signer.verify(signature, SIGN_DOMAIN + prefix + digest.digest())
        except InvalidSignature:
            raise ValueError("archive signature check failed") from None
        if header.get("signer") != fingerprint(signer) or header.get("recipient") != fingerprint(identity):
            raise ValueError("archive key fingerprint mismatch")
        if any(len(base64.b64decode(header[k], validate=True)) != n
               for k, n in (("salt", 32), ("nonce", 7), ("ephemeral", 32))):
            raise ValueError("invalid transfer key parameters")
        cipher = _cipher(identity.exchange(x25519.X25519PublicKey.from_public_bytes(
            base64.b64decode(header["ephemeral"], validate=True))), header)
        stream.seek(start)

        def plaintext():
            counter = 0
            while True:
                final, frame = _frame(stream, counter)
                yield cipher.decrypt(_nonce(header, counter, final), frame[FRAME.size:],
                                     AAD_DOMAIN + prefix + struct.pack(">IB", counter, final))
                counter += 1
                if final:
                    break

        yield plaintext()
