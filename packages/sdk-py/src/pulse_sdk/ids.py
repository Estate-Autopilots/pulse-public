"""Deterministic ids for projection rows.

A projection row's id is a UUID v5 of the tenant, the row kind and its natural key, so rebuilding a projection
from the log gives the same ids (02 §5) and rows in other tables that point at them stay valid.
"""

from __future__ import annotations

import uuid

# Fixed namespace for Pulse projection ids. Never change it: every stored projection id depends on it.
NAMESPACE = uuid.UUID("5b0f8d2e-9c4a-4e57-a1d3-7f2c6b9e0a41")


def entity_id(org_id: uuid.UUID | str, kind: str, *key: object) -> uuid.UUID:
    """uuid5(NAMESPACE, "<org>|<kind>|<key parts>")."""
    parts = [str(org_id), kind, *("" if k is None else str(k) for k in key)]
    return uuid.uuid5(NAMESPACE, "|".join(parts))


def parse_ref(ref: str | None) -> tuple[str, str, str] | None:
    """Split a canonical reference ``<kind>:<namespace>:<key>`` (02 §3.2); None if malformed."""
    if not isinstance(ref, str) or not ref:
        return None
    kind, sep, rest = ref.partition(":")
    namespace, sep2, key = rest.partition(":")
    if not (sep and sep2 and kind and namespace and key):
        return None
    return kind, namespace, key


def ref_uuid(ref: str | None, kind: str) -> uuid.UUID | None:
    """The uuid in ``<kind>:pulse:<uuid>``, or None."""
    parsed = parse_ref(ref)
    if not parsed or parsed[0] != kind or parsed[1] != "pulse":
        return None
    try:
        return uuid.UUID(parsed[2])
    except ValueError:
        return None
