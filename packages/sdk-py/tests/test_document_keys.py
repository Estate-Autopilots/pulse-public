"""Open real TypeScript envelopes byte-exact; only synthetic keys/values enter these tests."""

import base64
import json
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from pulse_sdk import document_keys as keys

FIXTURE = json.loads((Path(__file__).parent / "fixtures/document-keys-v1.json").read_text())


@pytest.mark.parametrize("vector", FIXTURE["vectors"])
def test_typescript_vector_and_fail_closed(vector):
    ring = keys.parse_keyring(FIXTURE["keyring"])
    kid, wrapped, data, context = (vector["keyId"], base64.b64decode(vector["dataKey"]),
                                   base64.b64decode(vector["data"]), vector["context"])
    assert keys.open(ring, kid, wrapped, data, context) == base64.b64decode(vector["plain"])
    wrong = keys.parse_keyring(f"{kid} {base64.b64encode(bytes(32)).decode()}\n")
    for r, k, w, d, ctx in [(wrong, kid, wrapped, data, context), (ring, kid, wrapped, data, context + "/wrong"),
                            (ring, "missing", wrapped, data, context)]:
        with pytest.raises(keys.DocumentKeyError):
            keys.open(r, k, w, d, ctx)
    for which in ("key", "data"):
        original = wrapped if which == "key" else data
        for changed in (b"", b"\x02" + original[1:], original[:-1], original[:-1] + bytes([original[-1] ^ 1])):
            with pytest.raises(keys.DocumentKeyError):
                keys.open(ring, kid, changed if which == "key" else wrapped,
                          changed if which == "data" else data, context)


def test_keyring_sources_rotation_and_safe_diagnostics(tmp_path, monkeypatch):
    path = tmp_path / "synthetic.key"
    path.write_text(FIXTURE["keyring"])
    path.chmod(0o600)
    monkeypatch.setenv("PULSE_DOCUMENT_KEY_FILE", str(path))
    ring = keys.load_keyring()
    assert ring.active == "synthetic-active" and len(ring.fingerprints()) == 2
    monkeypatch.setenv("SYNTHETIC_RING", FIXTURE["keyring"])
    monkeypatch.setenv("PULSE_DOCUMENT_KEY_FILE", "env:SYNTHETIC_RING")
    assert keys.load_keyring() == ring == keys.load_keyring(f"file:{path}")
    for encoded in [line.split()[1] for line in FIXTURE["keyring"].splitlines()]:
        assert encoded not in repr(ring) and encoded not in json.dumps(ring.fingerprints())
    path.chmod(0o604)
    with pytest.raises(keys.DocumentKeyError, match="world access"):
        keys.load_keyring(path)
    with pytest.raises(keys.DocumentKeyError, match="unavailable"):
        keys.load_keyring("env:SYNTHETIC_MISSING")


@pytest.mark.parametrize("size", [16, 24])
def test_authenticated_non_aes256_data_key_refused(size):
    ring = keys.parse_keyring(FIXTURE["keyring"])
    kid, context, nonce, short_key = ring.active, "synthetic/context", bytes(12), bytes(size)
    wrapped = b"\x01" + nonce + AESGCM(ring.keys[kid]).encrypt(
        nonce, short_key, f"pulse.data-key.v1\n{kid}\n{context}".encode())
    data = b"\x01" + nonce + AESGCM(short_key).encrypt(nonce, b"synthetic", f"pulse.sealed.v1\n{context}".encode())
    with pytest.raises(keys.DocumentKeyError):
        keys.open(ring, kid, wrapped, data, context)


@pytest.mark.parametrize("text", ["", "# only comment", "bad", "bad !!!", "bad " + "AA==",
                                FIXTURE["keyring"] * 2, "invalid/id " + "A" * 43 + "= extra"])
def test_invalid_keyring_refused(text):
    with pytest.raises(keys.DocumentKeyError):
        keys.parse_keyring(text)


def test_manifest_security_guard_rejects_missing_context_and_credentials():
    from pulse_sdk.org_transfer import column_security_problems, load

    entries = load()
    # Synthetic catalogue generated from declarations; the DB integration test checks real schema drift.
    columns = {e["table"]: set(e.get("credentials", {})) for e in entries}
    for e in entries:
        for col, s in e.get("sealed", {}).items():
            columns[e["table"]].update([col, s["key_id"].split(".")[0], s["data_key"].split(".")[0]])
    assert column_security_problems(columns, entries) == []
    row = next(e for e in entries if e["table"] == "pulse.ai_connection")
    del row["sealed"]["secret_sealed"]
    del row["credentials"]["secret_sealed"]["on_import"]
    columns["pulse.ai_connection"].add("token_hash")
    problems = column_security_problems(columns, entries)
    assert "pulse.ai_connection.secret_sealed: missing sealed context" in problems
    assert "pulse.ai_connection.secret_sealed: invalid credential decision" in problems
    assert "pulse.ai_connection.token_hash: missing credential decision" in problems
