"""Deterministic, explainable delivery-detection rules."""

from .rules import (
    classify,
    classify_creative_type,
    classify_design_type,
    classify_folder,
    normalize_folder_name,
    parse_cid,
    parse_cid_filename,
    parse_legacy_name,
    sort_versions,
    version_order_key,
)

__all__ = [
    "classify",
    "classify_creative_type",
    "classify_design_type",
    "classify_folder",
    "normalize_folder_name",
    "parse_cid",
    "parse_cid_filename",
    "parse_legacy_name",
    "sort_versions",
    "version_order_key",
]
