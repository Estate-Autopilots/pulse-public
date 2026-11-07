"""Pure parsers and classifiers for folder and file delivery signals."""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from pathlib import PurePosixPath
from typing import Any

from pulse_sdk.cid import parse as _parse_sdk_cid
from pulse_sdk.cid import stem as _cid_stem

from .folder_rules import FolderRules, normalise

BLUEPRINT_SCRIPT_RE = re.compile(r"\b(script|vid ?#?\d*|vov ?#?\d*|hook)\b", re.IGNORECASE)
MEDIA_MIMES = ("video/", "image/", "application/pdf")
DESIGN_EXPORT_EXTENSIONS = {
    ".ai", ".bmp", ".gif", ".jpeg", ".jpg", ".pdf", ".png", ".psd", ".svg", ".tif", ".tiff", ".webp",
}
DOCUMENT_MIMES = ("text/", "application/pdf", "application/msword", "application/vnd.openxmlformats")
DOCUMENT_EXTENSIONS = {".doc", ".docx", ".md", ".odt", ".rtf", ".txt", ".xls", ".xlsx"}


def _basename(value: str) -> str:
    return value.replace("\\", "/").rsplit("/", 1)[-1]


def _without_extension(value: str) -> str:
    return _cid_stem(value)


def _cid_dict(cid: Any) -> dict[str, Any] | None:
    if cid is None:
        return None
    project_registry = cid.base[len(cid.tenant) :].split("-", 1)[0]
    return {
        "cid": str(cid),
        "asset_cid": cid.base,
        "tenant": cid.tenant,
        "project_registry": project_registry,
        "type_code": cid.type_code,
        "asset_number": cid.num,
        "version": cid.version,
        "variant": cid.variant,
    }


def parse_cid(basename_without_extension: str) -> dict[str, Any] | None:
    """Adapt the shared SDK CID value to the delivery-classifier's dictionary contract."""
    return _cid_dict(_parse_sdk_cid(basename_without_extension))


def parse_cid_filename(filename: str) -> dict[str, Any] | None:
    """Parse a CID from a filename by removing its final extension first."""
    return _cid_dict(_parse_sdk_cid(filename))


def normalize_folder_name(name: str) -> str:
    """Compatibility adapter to the canonical Appendix F.1 folder normalizer."""
    return normalise(name)


def _rules_config(tenant_config: Mapping[str, Any]) -> Mapping[str, Any]:
    return tenant_config.get("folder_rules", tenant_config)


def _path_segments(folder_path: str | Sequence[str] | None) -> list[str]:
    if folder_path is None:
        return []
    if isinstance(folder_path, str):
        return [part for part in folder_path.replace("\\", "/").split("/") if part]
    return [str(part) for part in folder_path if str(part)]


def classify_folder(folder_path: str | Sequence[str] | None, tenant_config: Mapping[str, Any]) -> dict[str, Any]:
    """Adapt canonical Appendix F.1 folder rules to the classifier's explanation contract."""
    segments = _path_segments(folder_path)
    folder_rules = FolderRules.from_config(_rules_config(tenant_config))
    normalized = [normalise(segment) for segment in segments]
    role, default_version_kind = folder_rules.classify(normalized) if normalized else ("other", None)
    matched_rule = folder_rules.match(normalized[0]) if normalized else None
    for name in normalized[1:]:
        nested_rule = folder_rules.match(name)
        if nested_rule and nested_rule.nested:
            matched_rule = nested_rule
    result: dict[str, Any] = {
        "stage": segments[0] if segments else None,
        "role": role,
        "default_version_kind": default_version_kind,
        "matched_pattern": matched_rule.pattern.pattern if matched_rule else None,
        "normalized_path": normalized,
        "confidence": 0.95 if matched_rule else 0.15,
    }
    return result


def _filename_rules(tenant_config: Mapping[str, Any]) -> Mapping[str, Any]:
    folder_rules = _rules_config(tenant_config)
    return folder_rules.get("file_name", tenant_config.get("file_name", {}))


def _version_hint(stem: str, tokens: Sequence[str]) -> tuple[int | None, str | None]:
    for token in tokens:
        match = re.search(str(token), stem, flags=re.IGNORECASE)
        if not match:
            continue
        token_text = match.group(0)
        number_match = re.search(r"(?i)(?:\bv\s*|\brev(?:ised)?\s*|\()(\d{1,3})", token_text)
        return (int(number_match.group(1)) if number_match else None, token_text)
    return None, None


def parse_legacy_name(filename: str, tenant_config: Mapping[str, Any]) -> dict[str, Any]:
    """Parse configured legacy type/version hints without guessing unmatched names."""
    stem = _without_extension(filename)
    cid = parse_cid(stem)
    if cid:
        return {"kind": "cid", "parsed_cid": cid, "type_code": cid["type_code"], "version": cid["version"], "confidence": 0.95}

    hints = _filename_rules(tenant_config)
    type_code = None
    matched_hint = None
    for pattern, code in hints.get("legacy_type_hints", {}).items():
        match = re.search(str(pattern), stem, flags=re.IGNORECASE)
        if match:
            type_code, matched_hint = str(code), str(pattern)
            break
    number, token = _version_hint(stem, hints.get("legacy_version_tokens", []))
    confidence = 0.65 if type_code else (0.2 if token else 0.1)
    why = (
        [f"Configured legacy type hint {matched_hint!r} matched {type_code}."]
        if type_code
        else ["No CID or configured legacy type hint matched; asset identity is unresolved."]
    )
    return {
        "kind": "legacy" if type_code else "unknown",
        "name": stem,
        "type_code": type_code,
        "version": number,
        "version_token": token,
        "matched_hint": matched_hint,
        "confidence": confidence,
        "why": why,
    }


def _creative_type_rules(tenant_config: Mapping[str, Any]) -> Mapping[str, Any]:
    """Return the tenant-owned creative taxonomy rules beside the folder rules."""
    folder_rules = _rules_config(tenant_config)
    if "creative_types" in folder_rules:
        return folder_rules["creative_types"]
    if "creative_type_rules" in folder_rules:
        return folder_rules["creative_type_rules"]
    if "creative_types" in tenant_config:
        return tenant_config["creative_types"]
    return tenant_config.get("creative_type_rules", {})


def classify_creative_type(file_event: Mapping[str, Any], tenant_config: Mapping[str, Any]) -> dict[str, Any]:
    """Classify a delivery using explicit tenant rules; preserve unknowns as ``other``.

    Folder rules are strongest, then explicit filename rules, then the type code from
    the shared CID/legacy parsers. Rules are data so tenants can tune classification
    without changing this package. No default keyword guesses are applied.
    """
    taxonomy = _creative_type_rules(tenant_config)
    name = str(_event_value(file_event, "name", "file_name") or "")
    stem = _without_extension(_basename(name))
    folder_path = _event_value(file_event, "folder_path", "folders", "path")
    segments = [normalise(part) for part in _path_segments(folder_path)]

    def matched(type_key: Any, source: str, evidence: str, rule: Any) -> dict[str, Any] | None:
        key = str(type_key or "")
        if key not in {"model_video", "vov", "founder_video", "testimonial", "walkthrough"}:
            return None
        return {
            "type": key,
            "label": {
                "model_video": "Model video",
                "vov": "VOV",
                "founder_video": "Founder video",
                "testimonial": "Testimonial",
                "walkthrough": "Walkthrough",
            }[key],
            "classified": True,
            "source": source,
            "evidence": evidence,
            "rule": rule,
        }

    # A specific delivery folder is the clearest signal; config order breaks ties.
    for rule in taxonomy.get("folder_path", []):
        pattern = str(rule.get("match", ""))
        for segment in segments:
            if pattern and re.fullmatch(pattern, segment, flags=re.IGNORECASE):
                result = matched(rule.get("type"), "folder_path", segment, pattern)
                if result:
                    return result

    # Filename rules use search so a configured phrase can appear beside an ID/version.
    for rule in taxonomy.get("file_name", []):
        pattern = str(rule.get("match", ""))
        if pattern and re.search(pattern, stem, flags=re.IGNORECASE):
            result = matched(rule.get("type"), "file_name", stem, pattern)
            if result:
                return result

    # Use established parsers for coded names, with a tenant-owned code mapping.
    parsed = parse_cid(stem) or parse_legacy_name(name, tenant_config)
    type_code = parsed.get("type_code")
    if type_code:
        type_key = taxonomy.get("parsed_type_codes", {}).get(str(type_code).upper())
        result = matched(type_key, "parsed_type_code", str(type_code).upper(), str(type_code).upper())
        if result:
            return result

    return {
        "type": "other",
        "label": "Other (unclassified)",
        "classified": False,
        "source": None,
        "evidence": None,
        "rule": None,
    }


def _design_type_rules(tenant_config: Mapping[str, Any]) -> Mapping[str, Any]:
    folder_rules = _rules_config(tenant_config)
    return folder_rules.get("design_type_rules", tenant_config.get("design_type_rules", {}))


def classify_design_type(file_event: Mapping[str, Any], tenant_config: Mapping[str, Any]) -> dict[str, Any]:
    """Classify a supported image/design export using explicit tenant-owned rules.

    Folder rules take precedence over filename rules. An unmatched export is kept
    in ``other`` so it remains countable without guessing its purpose.
    """
    taxonomy = _design_type_rules(tenant_config)
    name = str(_event_value(file_event, "name", "file_name") or "")
    stem = _without_extension(_basename(name))
    folder_path = _event_value(file_event, "folder_path", "folders", "path")
    segments = [normalise(part).replace("_", " ") for part in _path_segments(folder_path)]
    allowed = {"single_image_ad", "carousel", "brochure", "logo", "pitch_deck"}
    labels = {
        "single_image_ad": "Single-image ad",
        "carousel": "Carousel",
        "brochure": "Brochure",
        "logo": "Logo",
        "pitch_deck": "Pitch deck",
    }

    def matched(type_key: Any, source: str, evidence: str, rule: Any) -> dict[str, Any] | None:
        key = str(type_key or "")
        if key not in allowed:
            return None
        return {"type": key, "label": labels[key], "classified": True,
                "source": source, "evidence": evidence, "rule": rule}

    exclusions = taxonomy.get("exclude", [])
    for segment in reversed(segments):
        if isinstance(exclusions, list):
            for pattern in exclusions:
                pattern = str(pattern)
                if not pattern:
                    continue
                try:
                    if re.search(r"\b(?:" + pattern + r")\b", segment, flags=re.IGNORECASE):
                        return {"type": "other", "label": "Other (unclassified)", "classified": False,
                                "source": None, "evidence": None, "rule": None}
                except re.error:
                    continue

        for rule in taxonomy.get("folder_path", []):
            pattern = str(rule.get("match", ""))
            try:
                matches = pattern and re.search(r"\b(?:" + pattern + r")\b", segment, flags=re.IGNORECASE)
            except re.error:
                matches = None
            if matches:
                result = matched(rule.get("type"), "folder_path", segment, pattern)
                if result:
                    return result

    for rule in taxonomy.get("file_name", []):
        pattern = str(rule.get("match", ""))
        try:
            matches = pattern and re.search(pattern, stem, flags=re.IGNORECASE)
        except re.error:
            matches = None
        if matches:
            result = matched(rule.get("type"), "file_name", stem, pattern)
            if result:
                return result

    return {"type": "other", "label": "Other (unclassified)", "classified": False,
            "source": None, "evidence": None, "rule": None}


def _event_value(file_event: Mapping[str, Any], *keys: str) -> Any:
    data = file_event.get("data", {})
    for key in keys:
        if key in file_event:
            return file_event[key]
        if isinstance(data, Mapping) and key in data:
            return data[key]
    return None


def _asset_index(tenant_config: Mapping[str, Any]) -> tuple[bool, list[Mapping[str, Any]]]:
    if "asset_index" not in tenant_config:
        return False, []
    index = tenant_config["asset_index"]
    if isinstance(index, Mapping):
        return True, [{"cid": key, **(value if isinstance(value, Mapping) else {})} for key, value in index.items()]
    return True, list(index or [])


def _registry_digits(value: Any) -> str | None:
    if value is None:
        return None
    digits = re.sub(r"\D", "", str(value))
    return digits.lstrip("0") or "0" if digits else None


def _is_document(name: str, mime: str) -> bool:
    extension = PurePosixPath(_basename(name)).suffix.lower()
    return mime.startswith(DOCUMENT_MIMES) or extension in DOCUMENT_EXTENSIONS


def classify(file_event: Mapping[str, Any], tenant_config: Mapping[str, Any]) -> dict[str, Any]:
    """Classify a Drive-like file event and return an explanation with its evidence strength."""
    name = str(_event_value(file_event, "name", "file_name") or "")
    mime = str(_event_value(file_event, "mime", "mime_type") or "application/octet-stream").lower()
    folder_path = _event_value(file_event, "folder_path", "folders", "path")
    folder = classify_folder(folder_path, tenant_config)
    role = str(folder["role"])
    stage = folder["stage"]
    design_export = mime.startswith(("image/", "application/pdf")) or PurePosixPath(_basename(name)).suffix.lower() in DESIGN_EXPORT_EXTENSIONS
    media = mime.startswith(MEDIA_MIMES) or design_export
    result: dict[str, Any] = {
        "asset": None,
        "version": None,
        "creative_type": None,
        "creative_type_classified": False,
        "creative_type_rule": None,
        "creative_type_source": None,
        "design_type": None,
        "design_type_classified": False,
        "design_type_rule": None,
        "design_type_source": None,
        "stage": stage,
        "folder_role": role,
        "delivered": False,
        "confidence": folder["confidence"],
        "why": [],
        "review_required": False,
    }
    if folder["matched_pattern"]:
        result["why"].append(f"Folder matched configured rule {folder['matched_pattern']!r}: {role}.")
    elif stage:
        result["why"].append("No configured folder rule matched; the folder role is other.")
    else:
        result["why"].append("No folder path was supplied below the bound project root.")

    if role == "deliverables":
        if not media:
            result["why"].append(f"MIME type {mime!r} is not a candidate deliverable media type.")
            return result
        result["delivered"] = True
        if mime.startswith(MEDIA_MIMES):
            result["why"].append(f"MIME type {mime!r} is eligible as a candidate deliverable.")
        else:
            result["why"].append(
                f"File extension {PurePosixPath(_basename(name)).suffix.lower()!r} is eligible as a design export."
            )
        if design_export:
            design_type = classify_design_type(file_event, tenant_config)
            result["design_type"] = design_type["type"]
            result["design_type_classified"] = design_type["classified"]
            result["design_type_rule"] = design_type["rule"]
            result["design_type_source"] = design_type["source"]
            result["why"].append(
                f"Design type {design_type['label']!r} matched {design_type['source']} rule "
                f"{design_type['rule']!r}." if design_type["classified"]
                else "No tenant design-type rule matched; classified as other (unclassified)."
            )
        creative_type = classify_creative_type(file_event, tenant_config)
        result["creative_type"] = creative_type["type"]
        result["creative_type_classified"] = creative_type["classified"]
        result["creative_type_rule"] = creative_type["rule"]
        result["creative_type_source"] = creative_type["source"]
        result["why"].append(
            f"Creative type {creative_type['label']!r} matched {creative_type['source']} rule "
            f"{creative_type['rule']!r}." if creative_type["classified"]
            else "No tenant creative-type rule matched; classified as other (unclassified)."
        )
        stem = _without_extension(name)
        cid = parse_cid(stem)
        if cid:
            has_index, assets = _asset_index(tenant_config)
            entry = next(
                (
                    item
                    for item in assets
                    if (indexed := parse_cid(_without_extension(str(item.get("cid", "")))))
                    and indexed["asset_cid"] == cid["asset_cid"]
                ),
                None,
            )
            if has_index and entry is None:
                result["confidence"] = 0.2
                result["review_required"] = True
                result["why"].append(f"CID {cid['asset_cid']} is not in the supplied asset index; identity remains unresolved for review.")
            elif entry is not None:
                event_project = _registry_digits(_event_value(file_event, "project_registry", "project_reg"))
                asset_project = _registry_digits(entry.get("project_registry"))
                result["asset"] = dict(entry)
                if event_project and asset_project and event_project != asset_project:
                    result["review_required"] = True
                    result["why"].append("CID belongs to a different project; attached to its indexed asset and flagged for review.")
                else:
                    result["why"].append(f"CID matched indexed asset {cid['asset_cid']}.")
                result["confidence"] = min(folder["confidence"], 0.95)
            else:
                result["asset"] = {"cid": cid["asset_cid"], "type_code": cid["type_code"]}
                result["confidence"] = min(folder["confidence"], 0.95)
                result["why"].append(f"Filename matched the CID syntax for {cid['asset_cid']}.")
            result["version"] = {
                "number": cid["version"],
                "kind": folder["default_version_kind"],
                "variant": cid["variant"],
            }
            return result

        legacy = parse_legacy_name(name, tenant_config)
        drive_file_id = _event_value(file_event, "file_id", "drive_file_id")
        if drive_file_id:
            result["asset"] = {
                "key": f"gdrive:{drive_file_id}",
                "type": legacy["type_code"] or "unknown",
                "legacy_name": legacy["name"],
            }
            if legacy["type_code"]:
                result["asset"]["type_code"] = legacy["type_code"]
            else:
                result["why"].append("Unresolved legacy asset is provisionally keyed by Drive file id.")
        elif legacy["type_code"]:
            result["asset"] = {"legacy_name": legacy["name"], "type_code": legacy["type_code"]}
        else:
            result["why"].append("No Drive file id was supplied; unresolved legacy asset has no stable file key.")
        result["confidence"] = min(folder["confidence"], legacy["confidence"])
        result["why"].extend(legacy["why"])
        result["version"] = {
            "number": legacy["version"],
            "kind": folder["default_version_kind"],
            "variant": None,
            "label": legacy["version_token"],
        }
        return result

    if role.startswith("input:"):
        kind = role.split(":", 1)[1]
        if kind == "blueprint_folder" and _is_document(name, mime):
            kind = "approved_script" if BLUEPRINT_SCRIPT_RE.search(normalize_folder_name(_without_extension(name))) else "blueprint"
        result["input"] = {"kind": kind, "received": True}
        result["why"].append(f"File is recorded as received input {kind!r}.")
    elif role == "ignore":
        result["why"].append("Folder rule explicitly ignores this path.")
    return result


def version_order_key(version: Mapping[str, Any]) -> tuple[int, str, str]:
    """Sort by explicit version number, then upload time/name for stable ties and unnumbered versions."""
    number = version.get("number")
    return (int(number) if number is not None else 0, str(version.get("uploaded_at", "")), str(version.get("name", "")))


def sort_versions(versions: Sequence[Mapping[str, Any]]) -> list[Mapping[str, Any]]:
    """Return versions ordered by the stable key used by the delivery projector."""
    return sorted(versions, key=version_order_key)
