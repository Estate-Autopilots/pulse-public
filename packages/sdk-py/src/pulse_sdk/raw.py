"""Content-addressed, append-only raw object storage (finance P1)."""

from __future__ import annotations

import hashlib
import json
import uuid
from collections.abc import Mapping
from datetime import datetime

import psycopg
import zstandard
from psycopg.types.json import Jsonb

MAX_RAW_BYTES = 8 * 1024 * 1024
_CAPTURE_NAMESPACE = uuid.UUID("279fe60e-fdf7-5ad7-971b-f2729e51615d")
_COMPRESSED = {
    "pdf", "jpeg", "jpg", "png", "mp4", "xlsx", "docx", "zip", "application/pdf", "image/jpeg",
    "image/png", "video/mp4", "application/zip", "application/x-zip-compressed",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
}


class RawTooLarge(ValueError):
    """The input or stored representation exceeds the 8 MiB object limit."""


class RawStoreFull(RuntimeError):
    """The database-wide raw byte cap has been reached."""


class RawObjectNotFound(LookupError):
    """No raw object is visible for this tenant and SHA-256."""


class RawIntegrityError(RuntimeError):
    """Stored bytes failed decompression, length, or SHA-256 verification."""


def _encode(data: bytes | bytearray | memoryview, media_type: str) -> tuple[bytes, str, bytes]:
    if not isinstance(data, (bytes, bytearray, memoryview)):
        raise TypeError("raw data must be bytes-like")
    original = bytes(data)
    if len(original) > MAX_RAW_BYTES:
        raise RawTooLarge(f"raw input exceeds {MAX_RAW_BYTES} bytes")
    kind = media_type.split(";", 1)[0].strip().lower()
    encoded, codec = original, "none"
    if kind not in _COMPRESSED:
        candidate = zstandard.ZstdCompressor().compress(original)
        if len(candidate) <= MAX_RAW_BYTES:
            encoded, codec = candidate, "zstd"
    return hashlib.sha256(original).digest(), codec, encoded


def put(conn: psycopg.Connection, org_id, data: bytes, media_type: str, sensitivity: str) -> tuple[str, bool]:
    """Store an original once. The connection must already be scoped to ``org_id``."""
    digest, codec, encoded = _encode(data, media_type)
    sha256 = digest.hex()
    try:
        with conn.transaction():
            inserted = conn.execute(
                """insert into pulse.raw_object(org_id,sha256,size,media_type,codec,stored_length,storage,locator,
                                                       sensitivity)
                   values (%s,%s,%s,%s,%s,%s,'pg',null,%s) on conflict (org_id,sha256) do nothing""",
                (org_id, sha256, memoryview(data).nbytes, media_type, codec, len(encoded), sensitivity),
            ).rowcount == 1
            if inserted:
                conn.execute("insert into pulse_priv.raw_blob(org_id,sha256,data,stored_length) values (%s,%s,%s,%s)",
                             (org_id, sha256, encoded, len(encoded)))
    except psycopg.Error as exc:
        primary = getattr(exc.diag, "message_primary", "") or ""
        if exc.sqlstate == "53100" and "raw store full" in primary:
            raise RawStoreFull(primary) from exc
        raise
    return sha256, inserted


def _capture_id(org_id, dataset_key: str, source_key: str, external_id: str, version: str | None,
                sha256: str) -> uuid.UUID:
    natural_key = json.dumps([str(org_id), dataset_key, source_key, external_id, version, sha256],
                             separators=(",", ":"), ensure_ascii=False)
    return uuid.uuid5(_CAPTURE_NAMESPACE, natural_key)


def capture(conn: psycopg.Connection, org_id, dataset_key: str, source_key: str, external_id: str, sha256: str,
            *, account_ref: str | None = None, path: str | None = None, version: str | None = None,
            etag: str | None = None, md5: str | None = None, captured_at: datetime | None = None,
            cursor: dict | list | None = None) -> bool:
    """Append one idempotent source observation; returns whether a row was added."""
    capture_id = _capture_id(org_id, dataset_key, source_key, external_id, version, sha256)
    with conn.transaction():
        return conn.execute(
            """insert into pulse_priv.raw_capture(id,org_id,dataset_key,source_key,account_ref,external_id,path,
                       version,etag,md5,captured_at,sha256,cursor)
                 values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,coalesce(%s,now()),%s,%s) on conflict (id) do nothing""",
            (capture_id, org_id, dataset_key, source_key, account_ref, external_id, path, version, etag, md5,
             captured_at, sha256, Jsonb(cursor if cursor is not None else {})),
        ).rowcount == 1


def get(conn: psycopg.Connection, org_id, sha256: str) -> bytes:
    """Return verified original bytes; missing and cross-tenant objects have the same result."""
    with conn.transaction():
        row = conn.execute(
            """select b.data,o.codec,o.size from pulse.raw_object o join pulse_priv.raw_blob b using(org_id,sha256)
                 where o.org_id=%s and o.sha256=%s""", (org_id, sha256),
        ).fetchone()
    if row is None:
        raise RawObjectNotFound(f"raw object {sha256} not found")
    if isinstance(row, Mapping):
        data, codec, size = row["data"], row["codec"], row["size"]
    else:
        data, codec, size = row[0], row[1], row[2]
    try:
        original = zstandard.ZstdDecompressor().decompress(data) if codec == "zstd" else bytes(data)
    except zstandard.ZstdError as exc:
        raise RawIntegrityError(f"raw object {sha256} cannot be decompressed") from exc
    if len(original) != size or hashlib.sha256(original).hexdigest() != sha256:
        raise RawIntegrityError(f"raw object {sha256} failed integrity verification")
    return original
