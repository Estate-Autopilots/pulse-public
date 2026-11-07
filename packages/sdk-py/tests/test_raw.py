import hashlib

import pytest
import zstandard

from pulse_sdk.raw import MAX_RAW_BYTES, RawTooLarge, _encode


def test_encode_hashes_and_compresses_original_bytes():
    original = b"synthetic raw bytes " * 100
    digest, codec, stored = _encode(original, "text/plain")
    assert digest.hex() == hashlib.sha256(original).hexdigest()
    assert codec == "zstd" and zstandard.ZstdDecompressor().decompress(stored) == original


@pytest.mark.parametrize("media_type", ["application/pdf", "image/jpeg", "image/png", "video/mp4",
                                         "xlsx", "docx", "zip"])
def test_already_compressed_formats_are_stored_verbatim(media_type):
    original = b"synthetic compressed-format bytes"
    digest, codec, stored = _encode(original, media_type)
    assert digest == hashlib.sha256(original).digest()
    assert codec == "none" and stored == original


def test_encode_rejects_oversized_original():
    with pytest.raises(RawTooLarge):
        _encode(b"x" * (MAX_RAW_BYTES + 1), "application/pdf")
