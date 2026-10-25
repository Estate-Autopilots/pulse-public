"""Synthetic organisation-transfer envelope acceptance, including verify-before-decrypt."""

import base64
import json
import struct
from pathlib import Path

import pytest
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ed25519, x25519

from pulse_sdk import transfer_archive as archive


@pytest.fixture(autouse=True)
def require_safe_tmp_path(tmp_path):
    if Path("/tmp") == tmp_path.resolve() or Path("/tmp") in tmp_path.resolve().parents:
        pytest.fail("transfer tests require tmp_path outside /tmp; run TMPDIR=/var/tmp /usr/local/bin/ea-heavy …")


@pytest.fixture
def keys():
    return x25519.X25519PrivateKey.generate(), ed25519.Ed25519PrivateKey.generate()


@pytest.mark.parametrize("size", [0, 1, archive.CHUNK, archive.CHUNK + 1, 2 * archive.CHUNK + 131])
def test_stream_roundtrip_and_no_plaintext_files(tmp_path, keys, size):
    identity, signing = keys
    marker = b"synthetic sealed document plaintext, never on disk\n"
    plain = (marker * (size // len(marker) + 1))[:size]
    path = tmp_path / "org.transfer"
    header = archive.write_archive(path, identity.public_key(), signing,
                                   (plain[i:i + 7919] for i in range(0, size, 7919)), required_bytes=size + 4096)
    assert header["recipient"] == archive.fingerprint(identity)
    assert header["signer"] == archive.fingerprint(signing)
    assert path.stat().st_mode & 0o777 == 0o600
    with archive.open_archive(path, identity, signing.public_key()) as blocks:
        result = list(blocks)
    assert b"".join(result) == plain and all(len(block) <= archive.CHUNK for block in result)
    assert list(tmp_path.iterdir()) == [path]
    assert marker not in path.read_bytes()


def test_signature_checked_before_decryption_and_wrong_keys_fail(tmp_path, keys, monkeypatch):
    identity, signing = keys
    path = tmp_path / "org.transfer"
    archive.write_archive(path, identity.public_key(), signing, [b"synthetic ID"], required_bytes=4096)
    with pytest.raises(ValueError, match="key fingerprint"):
        with archive.open_archive(path, x25519.X25519PrivateKey.generate(), signing.public_key()):
            pytest.fail("wrong identity admitted")
    original = path.read_bytes()
    size = struct.unpack(">I", original[len(archive.MAGIC):len(archive.MAGIC) + 4])[0]
    prefix_size = len(archive.MAGIC) + 4 + size

    def forbidden(*args):
        pytest.fail("key derivation/decryption attempted before signature verification")

    monkeypatch.setattr(archive, "_cipher", forbidden)
    with pytest.raises(ValueError, match="signature check failed"):
        with archive.open_archive(path, identity, ed25519.Ed25519PrivateKey.generate().public_key()):
            pytest.fail("wrong signer admitted")
    for offset in (prefix_size + archive.FRAME.size, len(original) - 65, len(original) - 1):
        changed = bytearray(original)
        changed[offset] ^= 1
        path.write_bytes(changed)
        with pytest.raises(ValueError, match="signature check failed"):
            with archive.open_archive(path, identity, signing.public_key()):
                pytest.fail("tampered ciphertext/signature admitted")


def test_truncation_reordering_missing_final_marker_and_trailing_bytes_fail(tmp_path, keys):
    identity, signing = keys
    path = tmp_path / "org.transfer"
    archive.write_archive(path, identity.public_key(), signing, [b"a" * archive.CHUNK, b"b" * archive.CHUNK],
                          required_bytes=3 * archive.CHUNK)
    original = path.read_bytes()
    start = len(archive.MAGIC) + 4 + struct.unpack(">I", original[len(archive.MAGIC):len(archive.MAGIC) + 4])[0]
    frame_size = archive.FRAME.size + archive.CHUNK + 16
    first, second = original[start:start + frame_size], original[start + frame_size:start + 2 * frame_size]
    reordered = original[:start] + second + first + original[start + 2 * frame_size:]
    for changed in (original[:4], original[:-1], original[:-64], original[:start + 2 * frame_size] + original[-64:],
                    original + b"extra", reordered):
        path.write_bytes(changed)
        with pytest.raises(ValueError):
            with archive.open_archive(path, identity, signing.public_key()) as blocks:
                list(blocks)


@pytest.mark.parametrize("header", [[], None, 1, "header"])
def test_non_object_header_fails_with_value_error(tmp_path, keys, header):
    identity, signing = keys
    encoded = json.dumps(header).encode()
    path = tmp_path / "malformed.transfer"
    path.write_bytes(archive.MAGIC + struct.pack(">I", len(encoded)) + encoded)
    with pytest.raises(ValueError, match="JSON object"):
        with archive.open_archive(path, identity, signing.public_key()):
            pytest.fail("non-object header admitted")


def test_second_pass_rejects_frames_from_another_signed_header(tmp_path, keys):
    identity, signing = keys
    path, replacement = tmp_path / "original", tmp_path / "replacement"
    for output in (path, replacement):
        archive.write_archive(output, identity.public_key(), signing, [b"x" * archive.CHUNK],
                              required_bytes=2 * archive.CHUNK)
    other = replacement.read_bytes()
    start = len(archive.MAGIC) + 4 + struct.unpack(">I", other[len(archive.MAGIC):len(archive.MAGIC) + 4])[0]
    with archive.open_archive(path, identity, signing.public_key()) as blocks:
        with path.open("r+b", buffering=0) as writer:
            writer.seek(start)
            writer.write(other[start:])
        with pytest.raises(InvalidTag):
            list(blocks)


def test_output_safety_and_failed_stream_cleanup(tmp_path, keys, monkeypatch):
    identity, signing = keys
    path = tmp_path / "org.transfer"
    path.write_bytes(b"preserve existing output")
    with pytest.raises(FileExistsError):
        archive.write_archive(path, identity.public_key(), signing, [], required_bytes=0)
    assert path.read_bytes() == b"preserve existing output"
    link = tmp_path / "link"
    link.symlink_to(path)
    with pytest.raises(FileExistsError):
        archive.write_archive(link, identity.public_key(), signing, [], required_bytes=0)
    with pytest.raises(ValueError, match="outside /tmp"):
        archive.write_archive("/tmp/forbidden-org-transfer", identity.public_key(), signing, [], required_bytes=0)

    def broken():
        yield b"sensitive plaintext only in memory"
        raise RuntimeError("source failed")

    failed = tmp_path / "failed"
    with pytest.raises(RuntimeError, match="source failed"):
        archive.write_archive(failed, identity.public_key(), signing, broken(), required_bytes=0)
    assert not failed.exists()
    monkeypatch.setattr(archive.shutil, "disk_usage", lambda p: type("Usage", (), {"free": 0})())
    with pytest.raises(ValueError, match="insufficient space"):
        archive.write_archive(failed, identity.public_key(), signing, [], required_bytes=1)
    assert not failed.exists()


def test_key_files_env_references_and_randomized_envelopes(tmp_path, keys, monkeypatch):
    identity, signing = keys
    public = tmp_path / "recipient.pem"
    public.write_bytes(identity.public_key().public_bytes(serialization.Encoding.PEM,
                                                        serialization.PublicFormat.SubjectPublicKeyInfo))
    assert archive.fingerprint(archive.load_key(public, "x25519")) == archive.fingerprint(identity)
    monkeypatch.setenv("TEST_TRANSFER_PRIVATE", base64.b64encode(signing.private_bytes_raw()).decode())
    assert archive.fingerprint(archive.load_key("env:TEST_TRANSFER_PRIVATE", "ed25519", private=True)) == (
        archive.fingerprint(signing))
    with pytest.raises(ValueError, match="incorrect transfer key type"):
        archive.load_key(public, "ed25519")
    paths = [tmp_path / "one", tmp_path / "two"]
    headers = [archive.write_archive(p, identity.public_key(), signing, [b"same"], required_bytes=4096) for p in paths]
    assert headers[0]["ephemeral"] != headers[1]["ephemeral"]
    assert paths[0].read_bytes() != paths[1].read_bytes()
    assert json.dumps(headers).count(archive.fingerprint(signing)) == 2
