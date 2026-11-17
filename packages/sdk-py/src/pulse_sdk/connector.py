"""connector.v1 (R52): the contract between Pulse and a company's connector (packages/schemas/connector/).

A company's connector reads that company's sources with that company's own credential and delivers only the entities
its admin granted. A connector never names the company: a pushed batch finds it through its install id (pulse_route
'connector'), and EA Connect's worker reads an install's roots inside that install's company. This module validates
manifests and batches, names the provider scope each entity needs, fingerprints credentials (a credential belongs to
one company: migration 0470 claims its fingerprint), finds a company's secret by the install's company, and turns an
accepted record into the registered event. No secret, token or cursor value is ever returned or logged from here.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import uuid
from datetime import UTC, datetime
from functools import lru_cache
from pathlib import Path
from typing import Any

import jsonschema

from . import registry as reg
from .envelope import make_event
from .paths import schemas_dir
from .ulid import deterministic_ulid

CONTRACT = "connector.v1"
ENABLED_ENV = "PULSE_CONNECTORS"
SECRETS_DIR_ENV = "PULSE_CONNECTOR_SECRETS_DIR"
SOURCE_PREFIX = "/collectors/connector"   # the envelope allows /collectors|agent|api|edge|system sources
SUPPORTED_SCHEMAS = frozenset({1})       # entity data schema versions this Pulse accepts (registry v1 data)
_REF = re.compile(r"[a-z0-9][a-z0-9-]{0,39}")
_PLACEHOLDER = re.compile(r"<[^<>]+>")


class SecretUnavailable(Exception):
    """The company's credential cannot be used: missing, unreadable, readable by others, or not a credential."""
    code = "credential_unavailable"


def on() -> bool:
    """Ingestion through connectors runs only when the server says so (default off)."""
    return os.environ.get(ENABLED_ENV) == "1"


@lru_cache
def _document(name: str) -> dict[str, Any]:
    return json.loads((schemas_dir() / "connector" / name).read_text(encoding="utf-8"))


def manifest_schema() -> dict[str, Any]:
    return _document("manifest.v1.json")


def batch_schema() -> dict[str, Any]:
    return _document("batch.v1.json")


def ea_connect_manifest() -> dict[str, Any]:
    """Pulse's own EA Connect manifest (product code; a company's installation holds the granted copy)."""
    return json.loads(json.dumps(_document("ea-connect.json")))


def entity_scopes() -> dict[str, str]:
    """The provider scope each entity needs."""
    return dict(manifest_schema()["x-entity-scopes"])


def _problems(schema: dict[str, Any], doc: Any, what: str) -> list[str]:
    validator = jsonschema.Draft202012Validator(schema, format_checker=jsonschema.FormatChecker())
    return [f"{'/'.join(str(p) for p in err.absolute_path) or what}: {err.message}"
            for err in sorted(validator.iter_errors(doc), key=lambda e: list(e.absolute_path))]


def manifest_problems(manifest: Any) -> list[str]:
    """Why a manifest is not a valid connector.v1 manifest; empty when it is."""
    problems = _problems(manifest_schema(), manifest, "manifest")
    if problems:
        return problems
    scopes = [s["scope"] for s in manifest["scopes"]]
    types = [e["type"] for e in manifest["entities"]]
    if len(set(scopes)) != len(scopes):
        problems.append("scopes: name each scope once")
    if len(set(types)) != len(types):
        problems.append("entities: name each entity once")
    needs = entity_scopes()
    problems += [f"entities: {t} needs the scope {needs[t]}" for t in types if needs[t] not in scopes]
    return problems


def batch_problems(batch: Any) -> list[str]:
    return _problems(batch_schema(), batch, "batch")


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def fingerprint_google(client_email: str) -> str:
    """A Google service account's identity (its address, hashed): the same account is the same credential, whichever
    key file of it is used."""
    return _sha(f"google-sa:{client_email.strip().lower()}")


def fingerprint_ed25519(public_key_b64: str) -> str:
    """A plugin key's identity; matches pulse.connector_create (sha256 of 'ed25519:' || key)."""
    return _sha(f"ed25519:{public_key_b64}")


def cursor_hash(cursor: str | None) -> str | None:
    return _sha(cursor) if cursor is not None else None


def _private(path: Path) -> bool:
    mode = path.stat().st_mode
    return not mode & (stat.S_IRWXG | stat.S_IRWXO)


def company_secret(org_id: uuid.UUID | str, ref: str, base: str | None = None) -> Path:
    """`<PULSE_CONNECTOR_SECRETS_DIR>/<company id>/<ref>.json`. The company's folder is named by the install's company,
    never by a caller, so one company's install cannot reach another company's file. A folder or file that others can
    read is refused rather than used."""
    folder = base or os.environ.get(SECRETS_DIR_ENV)
    if not folder or not _REF.fullmatch(ref or ""):
        raise SecretUnavailable()
    company = Path(folder) / str(uuid.UUID(str(org_id)))
    path = company / f"{ref}.json"
    try:
        # A link could point into another company's folder: only real files in the company's own folder count.
        if company.is_symlink() or path.is_symlink() or not (_private(company) and _private(path)):
            raise SecretUnavailable()
    except OSError as exc:
        raise SecretUnavailable() from exc
    return path


def google_fingerprint_of(path: Path) -> str:
    """The fingerprint of a Google service-account key file (its address only is read for this)."""
    try:
        key = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, UnicodeDecodeError) as exc:
        raise SecretUnavailable() from exc
    email = key.get("client_email") if isinstance(key, dict) else None
    if not isinstance(key, dict) or key.get("type") != "service_account" or not isinstance(email, str) \
            or "@" not in email:
        raise SecretUnavailable()
    return fingerprint_google(email)


def source_uri(install_id: uuid.UUID | str, source_id: uuid.UUID | str) -> str:
    return f"{SOURCE_PREFIX}/{install_id}/{source_id}"


def parse_time(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(UTC)


def record_event(registry: reg.Registry, *, org_id: uuid.UUID | str, install_id: uuid.UUID | str,
                 source_id: uuid.UUID | str, manifest_version: str, record: dict[str, Any]) -> dict[str, Any]:
    """The registered event for one accepted record. Pulse sets the company (the install's), the source, the id
    (deterministic: same root, key, time and type, same id), the subject and the purpose; the plugin supplies data."""
    et = registry.get(record["type"])
    if et is None:
        raise KeyError(record["type"])
    at = parse_time(record["time"])
    source = source_uri(install_id, source_id)
    return make_event(
        org_id=org_id, id=deterministic_ulid(at, source, record["key"], record["type"]), source=source,
        type=record["type"], time=at, subject=_PLACEHOLDER.sub(record["item"], et.subject, count=1),
        purpose=list(et.purposes), sensitivity=et.sensitivity, visibility=et.visibility, data=record["data"],
        datacontenttype="application/json", dataschema=f"schema:{record['type']}/{record['schema']}",
        collectorver=manifest_version,
    )


def sign_batch(key: Any, install_id: uuid.UUID | str, body: bytes, timestamp: int | None = None,
               nonce: str | None = None) -> dict[str, str]:
    """The headers of one signed plugin batch (a reference for plugin authors): the device-batch signature
    (pulse_sdk.signing) over the install id, with the plugin's own Ed25519 private key."""
    from .signing import sign_headers

    headers = sign_headers(key, str(install_id), body, timestamp, nonce)
    headers["X-Pulse-Connector"] = headers.pop("X-Pulse-Device")
    return headers
