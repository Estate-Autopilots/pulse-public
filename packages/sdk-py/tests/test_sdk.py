"""SDK unit tests (no database): ids, ULIDs, CIDs, registry, validation, envelope mapping, signing, manifests."""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime, timedelta

import pytest

from pulse_sdk import cid, ids, registry, signing, ulid
from pulse_sdk.collector import Manifest
from pulse_sdk.envelope import make_event, to_row
from pulse_sdk.paths import schemas_dir
from pulse_sdk.validate import EventValidator

ORG = uuid.UUID("7c1e3a52-0f5e-4d0b-9a35-2f4b8f3f8a10")
DEVICE = uuid.UUID("a0000000-0000-0000-0000-0000000000ab")
NOW = datetime(2026, 10, 5, 12, 0, tzinfo=UTC)
V = EventValidator()


def render(**over):
    ev = make_event(org_id=ORG, id=ulid.new_ulid(NOW), source=f"/agent/{DEVICE}", type="agent.render.detected",
                    time=NOW - timedelta(hours=1), subject="file:local:EA0584-HK03-v2.mp4", purpose="delivery",
                    sensitivity=1, visibility="team",
                    data={"name": "EA0584-HK03-v2.mp4", "size": 48211933, "md5": "9e107d9d372bb6826bd81d3542a419d6",
                          "sha256": "0" * 64}, actor=f"device:pulse:{DEVICE}", actorkind="device")
    ev.update(over)
    return ev


# ------------------------------------------------------------------------------------------------- ids, ULIDs
def test_entity_ids_are_deterministic_and_tenant_scoped():
    a = ids.entity_id(ORG, "version", "x", 1, None)
    assert a == ids.entity_id(ORG, "version", "x", 1, None)
    assert a != ids.entity_id(uuid.uuid4(), "version", "x", 1, None)
    assert ids.ref_uuid(f"person:pulse:{ORG}", "person") == ORG
    assert ids.ref_uuid("person:google:x", "person") is None


def test_deterministic_ulid():
    a = ulid.deterministic_ulid(NOW, "/collectors/gdrive_audit/1/ws", "evt-1", "drive.file.uploaded", 0)
    assert a == ulid.deterministic_ulid(NOW, "/collectors/gdrive_audit/1/ws", "evt-1", "drive.file.uploaded", 0)
    assert a != ulid.deterministic_ulid(NOW, "/collectors/gdrive_audit/1/ws", "evt-1", "drive.file.uploaded", 1)
    assert len(a) == 26 and set(a) <= set(ulid.ALPHABET)
    assert ulid.timestamp_ms(a) == int(NOW.timestamp() * 1000)
    with pytest.raises(ValueError):
        ulid.deterministic_ulid(NOW.replace(tzinfo=None), "s", "r", "t")


# ------------------------------------------------------------------------------------------------------- CIDs
def test_cid_fixtures():
    fx = json.loads((schemas_dir() / "fixtures" / "cid.json").read_text())
    for case in fx["valid"]:
        c = cid.parse(case["name"])
        assert c is not None, case["name"]
        assert (c.tenant, c.project, c.type_code, c.num, c.version, c.variant, c.base) == (
            case["tenant"], case["project"], case["type"], case["num"], case["version"], case["variant"], case["base"])
    for name in fx["invalid"]:
        assert cid.parse(name) is None, name


def test_cid_prefix_parser_accepts_ad_labels_and_rejects_partial_cids():
    parsed = cid.parse_prefix("EA0584-HK03-v2 · Reels")
    assert parsed is not None and (parsed.base, parsed.version) == ("EA0584-HK03", 2)
    assert cid.parse_prefix("EA0584-HK03-v2") == parsed
    assert cid.parse_prefix("EA0584-HK03-v2-not-a-cid") is None


# --------------------------------------------------------------------------------------------------- registry
def test_registry_loads_and_matches_the_canonical_lists():
    reg = registry.default()
    assert reg.version == 1 and len(reg.types) >= 60
    et = reg.get("agent.render.detected")
    assert et.purposes == ("delivery",) and et.retention == "work_record" and not et.ephemeral
    assert reg.get("agent.usage.hourly").ephemeral
    assert et.data_required == ("name", "size", "md5", "sha256")
    assert registry.subject_regex("identity:pulse:<entity_type>:<entity_id>") == r"^identity:pulse:.+:.+$"
    assert all(t.purposes and set(t.purposes) <= set(registry.CANONICAL_PURPOSES) for t in reg.types.values())


# ------------------------------------------------------------------------------------------------- validation
def test_valid_event_passes():
    assert V.errors(render(), now=NOW) == []


@pytest.mark.parametrize("over,needle", [
    ({"purpose": ""}, "purpose"),
    ({"purpose": "marketing"}, "purpose"),
    ({"purpose": "delivery,outcomes"}, "purpose"),
    ({"visibility": "org"}, "visibility"),
    ({"sensitivity": 0}, "sensitivity"),
    ({"sensitivity": 3}, "sensitivity"),
    ({"type": "agent.keystrokes.logged"}, "type"),
    ({"source": "/collectors/gdrive_audit/1/ws"}, "source"),
    ({"subject": "nonsense"}, "subject"),
    ({"time": "2026-10-05T12:00:00"}, "time"),
    ({"time": "2026-10-07T12:00:01Z"}, "future"),
    ({"orgid": "not-a-uuid"}, "orgid"),
    ({"data": {"name": "x"}}, "data"),
    ({"window_title": "Bank statement.pdf"}, "additional"),
    ({"data": {"name": "a.mp4", "size": 1, "md5": "0" * 32, "sha256": "0" * 64, "title": "x"}}, "undeclared"),
    ({"data": {"name": "a.mp4", "size": 1, "md5": "0" * 32, "sha256": "0" * 64, "url": "https://x"}}, "undeclared"),
    ({"data": {"name": "a.mp4", "size": 1, "md5": "0" * 32, "sha256": "0" * 64, "keys": ["ctrl+k"]}}, "undeclared"),
    ({"data": {"name": "a.mp4", "size": 1, "md5": "not-a-hash", "sha256": "0" * 64}}, "data.md5"),
    ({"data": {"name": "a.mp4", "size": -1, "md5": "0" * 32, "sha256": "0" * 64}}, "data.size"),
    ({"data": {"name": "a.mp4", "size": 1, "md5": "0" * 32, "sha256": "0" * 64, "cid": 7}}, "data.cid"),
    ({"data": {"name": "x" * 300, "size": 1, "md5": "0" * 32, "sha256": "0" * 64}}, "data.name"),
    ({"data": {"name": "a\u0000.mp4", "size": 1, "md5": "0" * 32, "sha256": "0" * 64}}, "nul"),
    ({"subject": "file:local:" + "x" * 600}, "512"),
])


def test_rejections(over, needle):
    errors = V.errors(render(**over), now=NOW)
    assert any(needle in e.lower() for e in errors), errors


def test_missing_purpose_is_rejected():
    ev = render()
    del ev["purpose"]
    assert any(e.startswith("purpose") for e in V.errors(ev, now=NOW))


def test_agent_payloads_cannot_carry_titles_or_urls():
    ev = make_event(org_id=ORG, id=ulid.new_ulid(NOW), source=f"/agent/{DEVICE}", type="agent.usage.hourly",
                    time=NOW, subject=f"device:pulse:{DEVICE}", purpose="activity_context", sensitivity=1,
                    visibility="person", data={"hour_start": NOW.isoformat(), "active_s": 10, "idle_s": 0,
                                               "categories": {"editing": 10, "chrome.exe": 5}})
    assert any("chrome.exe" in e or "additional" in e.lower() for e in V.errors(ev, now=NOW))


def test_to_row_maps_extensions():
    row = to_row(render(project=f"project:pulse:{ORG}", purpose="delivery"))
    assert row["org_id"] == ORG and row["purpose"] == ["delivery"] and row["project_id"] == ORG
    assert row["actor_kind"] == "device" and row["time"].tzinfo is not None


# ---------------------------------------------------------------------------------------------------- signing
def test_signing_roundtrip_and_tamper():
    key, pub = signing.generate_keypair()
    body = b'[{"a": 1}]'
    h = signing.sign_headers(key, str(DEVICE), body, timestamp=1_700_000_000, nonce="n1")
    msg = signing.message(str(DEVICE), h["X-Pulse-Timestamp"], h["X-Pulse-Nonce"], body)
    assert signing.verify(pub, h["X-Pulse-Signature"], msg)
    assert not signing.verify(pub, h["X-Pulse-Signature"], msg + b"x")
    assert not signing.verify(pub, "not base64!", msg)


def test_manifest():
    m = Manifest.from_dict({"name": "gdrive_changes", "version": "1.2.3", "source_kind": "pull",
                            "provider": "google_workspace", "emits": ["drive.file.created"], "purposes": ["delivery"],
                            "sensitivity": 1})
    assert m.source("ws-ea") == "/collectors/gdrive_changes/1/ws-ea"
    with pytest.raises(ValueError):
        Manifest.from_dict({"name": "meta_leads", "version": "1.0.0", "source_kind": "push", "provider": "meta",
                            "emits": [], "purposes": ["outcomes"], "sensitivity": 1})


def test_date_time_format_is_enforced():
    """ADR-0012: a timestamp field cannot smuggle a URL (rfc3339-validator makes jsonschema check date-time)."""
    ev = make_event(org_id=ORG, id=ulid.new_ulid(NOW), source=f"/agent/{DEVICE}", type="agent.usage.hourly",
                    time=NOW, subject=f"device:pulse:{DEVICE}", purpose="activity_context", sensitivity=1,
                    visibility="person", data={"hour_start": "https://example.com/watch?v=1", "active_s": 10,
                                               "idle_s": 0, "categories": {"editing": 10}})
    assert any("data.hour_start" in e for e in V.errors(ev, now=NOW))


def test_every_registry_field_is_typed():
    for et in registry.default().types.values():
        props = et.data_schema["properties"]
        assert set(props) == set(et.data_required) | set(et.data_optional)
        assert all(p for p in props.values()), et.type
        assert et.data_schema["additionalProperties"] is False
