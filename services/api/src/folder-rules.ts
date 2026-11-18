import { Ajv2020 } from "ajv/dist/2020.js";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type FolderRuleDocument = { doc_key: string; version: number; body: unknown };

const repositoryRoot = process.env.PULSE_REPO_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../../");
const schema = JSON.parse(readFileSync(resolve(repositoryRoot, "packages/schemas/config/folder_rules.json"), "utf8"));
const validator = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
const defaultExclusions = schema.properties.exclusions.default as string[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function copyLegacyFileName(value: unknown, target: Record<string, unknown>) {
  if (!isRecord(value)) {
    target._invalid_file_name = value;
    return;
  }
  if ("legacy_type_hints" in value && !("legacy_type_hints" in target)) {
    target.legacy_type_hints = value.legacy_type_hints;
  }
  if ("legacy_version_tokens" in value && !("legacy_version_tokens" in target)) {
    target.legacy_version_tokens = value.legacy_version_tokens;
  }
  const unknown = Object.keys(value).filter(key => !["legacy_type_hints", "legacy_version_tokens"].includes(key));
  if (unknown.length) target._invalid_file_name = unknown;
}

function normalizeDocument(body: unknown): Record<string, unknown> {
  if (!isRecord(body)) return { schema_version: 1, _invalid_document: body };
  const document = { ...body };
  const nested = document.folder_rules;
  delete document.folder_rules;
  if (nested !== undefined) {
    if (!isRecord(nested)) document._invalid_folder_rules = nested;
    else for (const [key, value] of Object.entries(nested)) {
      if (key === "creative_type_rules") {
        if (!("creative_types" in document)) document.creative_types = value;
      }
      else if (key === "file_name") copyLegacyFileName(value, document);
      else if (!(key in document)) document[key] = value;
    }
  }

  if ("creative_type_rules" in document) {
    if ("creative_types" in document) document._duplicate_creative_types = true;
    else document.creative_types = document.creative_type_rules;
    delete document.creative_type_rules;
  }
  if ("file_name" in document) {
    copyLegacyFileName(document.file_name, document);
    delete document.file_name;
  }
  if (!("schema_version" in document)) document.schema_version = 1;
  return document;
}

function merge(target: Record<string, unknown>, source: Record<string, unknown>) {
  for (const [key, value] of Object.entries(source)) {
    if (isRecord(value) && isRecord(target[key])) merge(target[key] as Record<string, unknown>, value);
    else target[key] = structuredClone(value);
  }
}

function regexErrors(document: Record<string, unknown>, label: string): string[] {
  const errors: string[] = [];
  const compile = (pattern: unknown, path: string) => {
    if (typeof pattern !== "string") return;
    try { new RegExp(pattern.replace(/\(\?P<([A-Za-z][A-Za-z0-9_]*)>/g, "(?<$1>")); }
    catch { errors.push(`${label} ${path}: invalid regular expression`); }
  };
  const compileRules = (value: unknown, path: string) => {
    if (!Array.isArray(value)) return;
    value.forEach((rule, index) => { if (isRecord(rule)) compile(rule.match, `${path}/${index}/match`); });
  };
  compileRules(document.index_rules, "/index_rules");
  if (Array.isArray(document.exclusions)) document.exclusions.forEach((pattern, i) => compile(pattern, `/exclusions/${i}`));
  if (Array.isArray(document.protected_paths)) {
    document.protected_paths.forEach((pattern, i) => compile(pattern, `/protected_paths/${i}`));
  }
  if (isRecord(document.design_type_rules)) {
    compileRules(document.design_type_rules.folder_path, "/design_type_rules/folder_path");
    if (Array.isArray(document.design_type_rules.exclude)) {
      document.design_type_rules.exclude.forEach((pattern, i) => compile(pattern, `/design_type_rules/exclude/${i}`));
    }
  }
  if (isRecord(document.creative_types)) {
    compileRules(document.creative_types.folder_path, "/creative_types/folder_path");
    compileRules(document.creative_types.file_name, "/creative_types/file_name");
  }
  if (isRecord(document.legacy_type_hints)) {
    Object.keys(document.legacy_type_hints).forEach(pattern => compile(pattern, "/legacy_type_hints/<pattern>"));
  }
  compileRules(document.project_paths, "/project_paths");
  compileRules(document.subfolders, "/subfolders");
  if (Array.isArray(document.legacy_version_tokens)) {
    document.legacy_version_tokens.forEach((pattern, i) => compile(pattern, `/legacy_version_tokens/${i}`));
  }
  return errors;
}

function schemaErrors(document: Record<string, unknown>, label: string): string[] {
  validator(document);
  return (validator.errors ?? []).map(error => {
    const detail = typeof error.params?.additionalProperty === "string"
      ? `unexpected property "${error.params.additionalProperty}"`
      : error.message ?? "invalid value";
    return `${label} ${error.instancePath || "/"}: ${detail}`;
  });
}

function counts(body: Record<string, unknown>) {
  const design = isRecord(body.design_type_rules) ? body.design_type_rules : {};
  const creative = isRecord(body.creative_types) ? body.creative_types : {};
  const length = (value: unknown) => Array.isArray(value) ? value.length : 0;
  const keys = (value: unknown) => isRecord(value) ? Object.keys(value).length : 0;
  return {
    index_rules: length(body.index_rules),
    exclusions: length(body.exclusions),
    design_type_rules: length(design.folder_path),
    creative_types: length(creative.folder_path) + length(creative.file_name) + keys(creative.parsed_type_codes),
    legacy_type_hints: keys(body.legacy_type_hints),
    project_paths: length(body.project_paths),
    pods: keys(body.pods),
    subfolders: length(body.subfolders),
  };
}

/**
 * Summarize active folder rules using the same normalization, validation, merge order and counts as the worker
 * loader. Documents are ordered by doc_key then version; objects merge recursively and later arrays replace earlier
 * arrays. The response includes configuration keys and counts only, never file names or paths.
 */
export function folderRulesSummary(rows: FolderRuleDocument[], orgId: string) {
  const documents = rows.map(row => ({ doc_key: row.doc_key, version: row.version }));
  const errors: string[] = [];
  const merged: Record<string, unknown> = { schema_version: 1 };
  for (const row of rows) {
    const document = normalizeDocument(row.body);
    const label = `${row.doc_key}@${row.version}`;
    errors.push(...schemaErrors(document, label), ...regexErrors(document, label));
    merge(merged, document);
  }
  if (rows.length && !("exclusions" in merged)) merged.exclusions = [...defaultExclusions];
  if (!rows.length) errors.push("no active folder_rules documents");
  else if (!errors.length) {
    errors.push(...schemaErrors(merged, "merged rules"), ...regexErrors(merged, "merged rules"));
  }
  return { org: orgId, documents, valid: errors.length === 0, errors, counts: counts(merged) };
}
