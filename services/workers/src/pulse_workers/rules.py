"""Worker media helpers and compatibility exports for Appendix F.1 folder rules."""

from __future__ import annotations

from pathlib import PurePosixPath

from pulse_rules.folder_rules import FolderRules, normalise

MEDIA_PREFIXES = ("video/", "image/")
MEDIA_EXACT = ("application/pdf",)
DESIGN_EXTENSIONS = {".ai", ".psd"}


def is_media(mime: str | None, name: str | None = None) -> bool:
    """Return whether a file is a media delivery, including Drive's generic PSD/AI exports."""
    extension = PurePosixPath((name or "").replace("\\", "/")).suffix.lower()
    return bool(mime) and (mime.startswith(MEDIA_PREFIXES) or mime in MEDIA_EXACT) or extension in DESIGN_EXTENSIONS


__all__ = ["FolderRules", "is_media", "normalise"]
