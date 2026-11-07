"""Tenant-owned folder rules and their validated, versioned database loader."""

from __future__ import annotations

import copy
import json
import os
import re
import unicodedata
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator


def _schema_path() -> Path:
    candidates = []
    if os.environ.get("PULSE_REPO_ROOT"):
        candidates.append(Path(os.environ["PULSE_REPO_ROOT"]))
    candidates.append(Path.cwd())
    candidates.extend(Path(__file__).resolve().parents)
    for root in candidates:
        candidate = root / "packages/schemas/config/folder_rules.json"
        if candidate.is_file():
            return candidate
    raise FileNotFoundError("cannot find packages/schemas/config/folder_rules.json; set PULSE_REPO_ROOT")


def _schema() -> dict[str, Any]:
    with _schema_path().open(encoding="utf-8") as file:
        schema = json.load(file)
    Draft202012Validator.check_schema(schema)
    return schema


_SCHEMA = _schema()
_VALIDATOR = Draft202012Validator(_SCHEMA)
_DEFAULT_EXCLUSIONS = copy.deepcopy(_SCHEMA["properties"]["exclusions"]["default"])
DEFAULT_EXCLUSIONS = tuple(_DEFAULT_EXCLUSIONS)


def normalise(name: str | None) -> str:
    """Appendix F.1 name normalisation used by both worker projections and classifiers."""
    value = (name or "").lower()
    value = re.sub(r"^\s*#?\d+\s*[).:-]?\s*", "", value, count=1)
    return " ".join(value.replace("&", " and ").split())


def source_norm(value: str | None) -> str:
    """Normalise a Drive folder identity the same way as the company seed."""
    text = unicodedata.normalize("NFKC", value or "").casefold().replace("’", "'")
    text = re.sub(r"\(.*?\)", " ", text)
    text = "".join(char if char.isalnum() or unicodedata.category(char).startswith("M") or char in "+ " else " "
                   for char in text)
    return re.sub(r"\s+", " ", text).strip()


@dataclass(frozen=True)
class ProjectPathMatch:
    """A configured project root and its named semantic captures."""

    root: str
    captures: Mapping[str, str]
    rule_index: int | None = None


def project_path_match(path: str, rules: tuple[Mapping[str, Any], ...] | list[Mapping[str, Any]]) -> ProjectPathMatch | None:
    """Return the path through the end of the configured project capture."""
    cleaned = "/".join(part.strip() for part in path.split("/") if part.strip())
    for rule_index, rule in enumerate(rules):
        pattern = re.compile(str(rule["match"]), re.IGNORECASE)
        match = pattern.search(cleaned)
        if not match:
            continue
        aliases = rule.get("captures", {})
        names = match.re.groupindex
        project_group = aliases.get("project", "project")
        if project_group not in names:
            raise ValueError("project_paths patterns must capture a project field")
        captures = {}
        for field in ("client", "project", "year", "month", "deliverable"):
            group = aliases.get(field, field)
            if group in names:
                value = match.group(group)
                if value is not None:
                    captures[field] = value.strip()
        return ProjectPathMatch(cleaned[:match.end(project_group)].strip("/"), captures, rule_index)
    return None


def project_root(path: str, rules: tuple[Mapping[str, Any], ...] | list[Mapping[str, Any]]) -> ProjectPathMatch | None:
    """Return a project root only when the indexed path has a child beneath it."""
    matched = project_path_match(path, rules)
    if not matched:
        return None
    path_parts = [part.strip() for part in path.split("/") if part.strip()]
    root_parts = [part.strip() for part in matched.root.split("/") if part.strip()]
    return matched if len(root_parts) < len(path_parts) else None


@dataclass(frozen=True)
class Rule:
    pattern: re.Pattern[str]
    role: str
    version_kind: str | None
    nested: bool


class FolderRules:
    """Appendix F.1 stage-folder classifier, constructed from validated subfolder rules."""

    def __init__(self, rules: list[Rule]):
        self.rules = rules

    @classmethod
    def from_config(cls, doc: Mapping[str, Any] | None) -> FolderRules:
        rules = []
        for item in (doc or {}).get("subfolders", []):
            rules.append(Rule(
                pattern=re.compile(item["match"], re.IGNORECASE),
                role=str(item["role"]),
                version_kind=item.get("default_version_kind"),
                nested=bool(item.get("nested", False)),
            ))
        return cls(rules)

    def match(self, normalised_name: str) -> Rule | None:
        for rule in self.rules:
            if rule.pattern.fullmatch(normalised_name):
                return rule
        return None

    def classify(self, path: list[str]) -> tuple[str, str | None]:
        if not path:
            return "root", None
        stage = self.match(path[0])
        role, kind = (stage.role, stage.version_kind) if stage else ("other", None)
        for name in path[1:]:
            rule = self.match(name)
            if rule and rule.nested:
                role, kind = rule.role, rule.version_kind
        return role, kind


@dataclass(frozen=True)
class DocumentRef:
    doc_key: str
    version: int

    def as_dict(self) -> dict[str, Any]:
        return {"doc_key": self.doc_key, "version": self.version}


@dataclass(frozen=True)
class IndexRule:
    match: str
    kind: str
    doc_key: str
    pattern: re.Pattern[str]


@dataclass(frozen=True)
class FolderRuleSet:
    """Validated merged folder-rule documents for one organisation."""

    org_id: str
    documents: tuple[DocumentRef, ...]
    index_rules: tuple[IndexRule, ...]
    exclusions: tuple[str, ...]
    design_type_rules: Mapping[str, Any]
    creative_types: Mapping[str, Any]
    legacy_type_hints: Mapping[str, Any]
    legacy_version_tokens: tuple[str, ...]
    project_paths: tuple[Mapping[str, Any], ...]
    pods: Mapping[str, Any]
    folder_rules: FolderRules
    body: Mapping[str, Any]
    protected_paths: tuple[str, ...] = ()

    def summary(self) -> dict[str, Any]:
        creative = self.creative_types
        return {
            "org": self.org_id,
            "documents": [item.as_dict() for item in self.documents],
            "valid": True,
            "errors": [],
            "counts": {
                "index_rules": len(self.index_rules),
                "exclusions": len(self.exclusions),
                "design_type_rules": len(self.design_type_rules.get("folder_path", [])),
                "creative_types": sum(len(creative.get(key, [])) for key in ("folder_path", "file_name"))
                + len(creative.get("parsed_type_codes", {})),
                "legacy_type_hints": len(self.legacy_type_hints),
                "project_paths": len(self.project_paths),
                "pods": len(self.pods),
                "subfolders": len(self.folder_rules.rules),
            },
        }


class FolderRulesError(ValueError):
    """An active tenant folder-rules document is missing or invalid."""

    def __init__(self, summary: Mapping[str, Any]):
        self.summary = dict(summary)
        details = "; ".join(summary.get("errors", [])) or "folder rules are invalid"
        super().__init__(details)


def _legacy_document(body: Any) -> dict[str, Any]:
    if not isinstance(body, Mapping):
        return {"schema_version": 1, "_invalid_document": body}

    document = dict(body)
    nested_present = "folder_rules" in document
    nested = document.pop("folder_rules", None)
    if nested_present:
        if not isinstance(nested, Mapping):
            document["_invalid_folder_rules"] = nested
        else:
            for key, value in nested.items():
                if key == "creative_type_rules":
                    document.setdefault("creative_types", value)
                elif key == "file_name":
                    if isinstance(value, Mapping):
                        if "legacy_type_hints" in value:
                            document.setdefault("legacy_type_hints", value["legacy_type_hints"])
                        if "legacy_version_tokens" in value:
                            document.setdefault("legacy_version_tokens", value["legacy_version_tokens"])
                        unknown = set(value) - {"legacy_type_hints", "legacy_version_tokens"}
                        if unknown:
                            document["_invalid_file_name"] = sorted(unknown)
                    else:
                        document["_invalid_file_name"] = value
                else:
                    document.setdefault(key, value)

    if "creative_type_rules" in document:
        if "creative_types" in document:
            document["_duplicate_creative_types"] = True
        else:
            document["creative_types"] = document.pop("creative_type_rules")
        document.pop("creative_type_rules", None)

    if "file_name" in document:
        file_name = document.pop("file_name")
        if isinstance(file_name, Mapping):
            if "legacy_type_hints" in file_name:
                document.setdefault("legacy_type_hints", file_name["legacy_type_hints"])
            if "legacy_version_tokens" in file_name:
                document.setdefault("legacy_version_tokens", file_name["legacy_version_tokens"])
            unknown = set(file_name) - {"legacy_type_hints", "legacy_version_tokens"}
            if unknown:
                document["_invalid_file_name"] = sorted(unknown)
        else:
            document["_invalid_file_name"] = file_name

    document.setdefault("schema_version", 1)
    return document


def _merge(target: dict[str, Any], source: Mapping[str, Any]) -> None:
    """Merge objects recursively; arrays and scalar values are replaced by the later document."""
    for key, value in source.items():
        if isinstance(value, Mapping) and isinstance(target.get(key), dict):
            _merge(target[key], value)
        else:
            target[key] = copy.deepcopy(value)


def _schema_errors(document: Mapping[str, Any], label: str) -> list[str]:
    errors = []
    ordered = sorted(_VALIDATOR.iter_errors(document), key=lambda item: tuple(map(str, item.absolute_path)))
    for error in ordered:
        path = "/" + "/".join(str(part) for part in error.absolute_path) if error.absolute_path else "/"
        errors.append(f"{label} {path}: {error.message}")
    return errors


def _regex_errors(document: Mapping[str, Any], label: str) -> list[str]:
    errors: list[str] = []

    def compile_pattern(pattern: Any, path: str) -> None:
        if not isinstance(pattern, str):
            return
        try:
            re.compile(pattern)
        except re.error as exc:
            errors.append(f"{label} {path}: invalid regular expression ({exc.msg})")

    index_rules = document.get("index_rules", [])
    for index, rule in enumerate(index_rules if isinstance(index_rules, list) else []):
        if isinstance(rule, Mapping):
            compile_pattern(rule.get("match"), f"/index_rules/{index}/match")
    exclusions = document.get("exclusions", [])
    for index, pattern in enumerate(exclusions if isinstance(exclusions, list) else []):
        compile_pattern(pattern, f"/exclusions/{index}")
    protected = document.get("protected_paths", [])
    for index, pattern in enumerate(protected if isinstance(protected, list) else []):
        compile_pattern(pattern, f"/protected_paths/{index}")
    for category in ("design_type_rules", "creative_types"):
        section = document.get(category)
        if not isinstance(section, Mapping):
            continue
        if category == "design_type_rules":
            folder_path = section.get("folder_path", [])
            for index, rule in enumerate(folder_path if isinstance(folder_path, list) else []):
                if isinstance(rule, Mapping):
                    compile_pattern(rule.get("match"), f"/{category}/folder_path/{index}/match")
            excluded = section.get("exclude", [])
            for index, pattern in enumerate(excluded if isinstance(excluded, list) else []):
                compile_pattern(pattern, f"/{category}/exclude/{index}")
        else:
            for rule_kind in ("folder_path", "file_name"):
                rules = section.get(rule_kind, [])
                for index, rule in enumerate(rules if isinstance(rules, list) else []):
                    if isinstance(rule, Mapping):
                        compile_pattern(rule.get("match"), f"/{category}/{rule_kind}/{index}/match")
    legacy_hints = document.get("legacy_type_hints")
    if isinstance(legacy_hints, Mapping):
        for pattern in legacy_hints:
            compile_pattern(pattern, "/legacy_type_hints/<pattern>")
    for section, rules in (("project_paths", document.get("project_paths", [])),
                           ("subfolders", document.get("subfolders", []))):
        for index, rule in enumerate(rules if isinstance(rules, list) else []):
            if isinstance(rule, Mapping):
                pattern = rule.get("match")
                compile_pattern(pattern, f"/{section}/{index}/match")
                if section == "project_paths" and isinstance(pattern, str):
                    try:
                        groups = re.compile(pattern).groupindex
                    except re.error:
                        continue
                    captures = rule.get("captures", {})
                    if not isinstance(captures, Mapping):
                        continue  # the schema reports the invalid shape
                    project_group = captures.get("project", "project")
                    if project_group not in groups:
                        errors.append(f"{label} /{section}/{index}: pattern must provide a named project capture")
                    for field, group in captures.items():
                        if field in {"client", "project", "year", "month", "deliverable"} and group not in groups:
                            errors.append(f"{label} /{section}/{index}/captures/{field}: unknown named capture {group!r}")
    version_tokens = document.get("legacy_version_tokens", [])
    for index, pattern in enumerate(version_tokens if isinstance(version_tokens, list) else []):
        compile_pattern(pattern, f"/legacy_version_tokens/{index}")
    return errors


def _counts(body: Mapping[str, Any]) -> dict[str, int]:
    design = body.get("design_type_rules")
    creative = body.get("creative_types")
    return {
        "index_rules": len(body.get("index_rules", [])) if isinstance(body.get("index_rules"), list) else 0,
        "exclusions": len(body.get("exclusions", [])) if isinstance(body.get("exclusions"), list) else 0,
        "design_type_rules": len(design.get("folder_path", [])) if isinstance(design, Mapping)
        and isinstance(design.get("folder_path"), list) else 0,
        "creative_types": (
            sum(len(creative.get(key, [])) for key in ("folder_path", "file_name")
                if isinstance(creative.get(key), list))
            + (len(creative.get("parsed_type_codes", {}))
               if isinstance(creative.get("parsed_type_codes"), Mapping) else 0)
        ) if isinstance(creative, Mapping) else 0,
        "legacy_type_hints": len(body.get("legacy_type_hints", {}))
        if isinstance(body.get("legacy_type_hints"), Mapping) else 0,
        "project_paths": len(body.get("project_paths", []))
        if isinstance(body.get("project_paths"), list) else 0,
        "pods": len(body.get("pods", {})) if isinstance(body.get("pods"), Mapping) else 0,
        "subfolders": len(body.get("subfolders", [])) if isinstance(body.get("subfolders"), list) else 0,
    }


def _compile(rows: list[Mapping[str, Any]], org_id: Any) -> tuple[FolderRuleSet | None, dict[str, Any]]:
    documents = tuple(DocumentRef(str(row["doc_key"]), int(row["version"])) for row in rows)
    org = str(org_id)
    errors: list[str] = []
    normalized: list[tuple[Mapping[str, Any], dict[str, Any]]] = []
    for row, ref in zip(rows, documents, strict=True):
        document = _legacy_document(row.get("body"))
        label = f"{ref.doc_key}@{ref.version}"
        errors.extend(_schema_errors(document, label))
        errors.extend(_regex_errors(document, label))
        normalized.append((ref, document))

    merged: dict[str, Any] = {"schema_version": 1}
    index_doc_key = ""
    for ref, document in normalized:
        _merge(merged, document)
        if "index_rules" in document:
            index_doc_key = ref.doc_key

    # The historical default applies only when no active document defines exclusions.
    if rows and "exclusions" not in merged:
        merged["exclusions"] = copy.deepcopy(_DEFAULT_EXCLUSIONS)

    if not rows:
        errors.append("no active folder_rules documents")
    elif not errors:
        errors.extend(_schema_errors(merged, "merged rules"))
        errors.extend(_regex_errors(merged, "merged rules"))

    summary = {
        "org": org,
        "documents": [item.as_dict() for item in documents],
        "valid": not errors,
        "errors": errors,
        "counts": _counts(merged),
    }
    if errors:
        return None, summary

    rules = tuple(IndexRule(item["match"], item["kind"], index_doc_key,
                            re.compile(item["match"], re.IGNORECASE))
                  for item in merged.get("index_rules", []))
    design_rules = merged.get("design_type_rules", {})
    creative_types = merged.get("creative_types", {})
    legacy_hints = merged.get("legacy_type_hints", {})
    path_rules = merged.get("project_paths", [])
    pods = merged.get("pods", {})
    result = FolderRuleSet(
        org_id=org,
        documents=documents,
        index_rules=rules,
        exclusions=tuple(merged.get("exclusions", [])),
        design_type_rules=design_rules,
        creative_types=creative_types,
        legacy_type_hints=legacy_hints,
        legacy_version_tokens=tuple(merged.get("legacy_version_tokens", [])),
        project_paths=tuple(path_rules),
        pods=pods,
        folder_rules=FolderRules.from_config(merged),
        body=merged,
        protected_paths=tuple(merged.get("protected_paths", [])),
    )
    return result, summary


def _active_rows(conn: Any, org_id: Any) -> list[Mapping[str, Any]]:
    return conn.execute(
        """select doc_key, version, body from pulse.tenant_config
           where org_id = %s and doc_kind = 'folder_rules' and is_active
           order by doc_key, version""",
        (org_id,),
    ).fetchall()


def load(conn: Any, org_id: Any) -> FolderRuleSet:
    """Load and validate active rules for one org.

    Active documents merge in ascending ``(doc_key, version)`` order. Objects merge recursively, so later
    keys override earlier values; arrays and scalars are replaced by the later document. Missing fields do not
    clear earlier values. The historical exclusions default is applied once after merging only when no active
    document defines exclusions.
    """
    rules, summary = _compile(_active_rows(conn, org_id), org_id)
    if rules is None:
        raise FolderRulesError(summary)
    return rules


def check(conn: Any, org_id: Any) -> dict[str, Any]:
    """Return the CLI/API validation summary without exposing file names or paths."""
    _, summary = _compile(_active_rows(conn, org_id), org_id)
    return summary
