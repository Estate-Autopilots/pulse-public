export const EDITOR_CREATIVE_TYPES = [
  "model_video",
  "vov",
  "founder_video",
  "testimonial",
  "walkthrough",
  "other",
] as const;

export type EditorCreativeType = (typeof EDITOR_CREATIVE_TYPES)[number];
export type WeeklyEditorTarget = { per_week: number | null; placeholder: boolean };
export type EditorTarget = { target: number | null; placeholder: boolean };

export const BRAND_ASSET_TYPES = ["logo", "colour_palette", "brochure", "pitch_deck", "brand_identity"] as const;
export type BrandAssetType = (typeof BRAND_ASSET_TYPES)[number];
export const BRAND_ASSET_DELIVERABLE_TYPES: Record<BrandAssetType, string> = {
  logo: "LG", colour_palette: "CL", brochure: "BR", pitch_deck: "PD", brand_identity: "BI",
};
export type DesignerDailyTarget = { per_day: number | null; placeholder: boolean };
export type BrandAssetWindow = { days: { min: number | null; max: number | null }; placeholder: boolean };
export type DesignerTargets = {
  singleImage: DesignerDailyTarget;
  roles: string[];
  windows: Record<BrandAssetType, BrandAssetWindow>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function targetValue(value: unknown, fallback: WeeklyEditorTarget, path: string): WeeklyEditorTarget {
  if (value === undefined) return fallback;
  if (!isRecord(value)) throw new Error(`Invalid weekly editor target at ${path}`);
  const perWeek = value.per_week;
  const placeholder = value.placeholder;
  if (perWeek !== null && (!Number.isInteger(perWeek) || Number(perWeek) < 0)) {
    throw new Error(`Invalid per_week value at ${path}`);
  }
  if (typeof placeholder !== "boolean") throw new Error(`Invalid placeholder value at ${path}`);
  return { per_week: perWeek as number | null, placeholder };
}

/** Resolve shared tenant targets and optional person-specific overrides. */
export function loadEditorTargets(config: unknown, personId: string): Record<EditorCreativeType, EditorTarget> {
  const body = isRecord(config) ? config : {};
  const shared = isRecord(body.editors) ? body.editors : {};
  const overrides = isRecord(body.person_overrides) ? body.person_overrides : {};
  const person = isRecord(overrides[personId]) ? overrides[personId] as Record<string, unknown> : {};
  const personEditors = isRecord(person.editors) ? person.editors : person;
  const empty = { per_week: null, placeholder: true };
  const result = {} as Record<EditorCreativeType, EditorTarget>;
  for (const type of EDITOR_CREATIVE_TYPES) {
    const base = targetValue(shared[type], empty, `editors.${type}`);
    const override = personEditors[type];
    const resolved = override === undefined
      ? base
      : targetValue(override, base, `person_overrides.${personId}.${type}`);
    result[type] = { target: resolved.per_week, placeholder: resolved.placeholder };
  }
  return result;
}

/** Resolve the tenant's single-image benchmark and brand asset completion windows. */
export function loadDesignerTargets(config: unknown): {
  singleImage: DesignerDailyTarget;
  roles: string[];
  windows: Record<BrandAssetType, BrandAssetWindow>;
} {
  const body = isRecord(config) ? config : {};
  const designers = isRecord(body.designers) ? body.designers : {};
  const rawRoles = designers.roles;
  if (rawRoles !== undefined && (!Array.isArray(rawRoles) || rawRoles.length > 20
    || rawRoles.some(role => typeof role !== "string" || !role.trim() || role.trim().length > 80))) {
    throw new Error("Invalid designer roles at designers.roles");
  }
  const roles = rawRoles === undefined ? [] : [...new Set((rawRoles as string[]).map(role => role.trim().toLocaleLowerCase("en")))];
  if (rawRoles !== undefined && roles.length !== rawRoles.length) {
    throw new Error("Duplicate designer roles at designers.roles");
  }
  const singleImage = isRecord(designers.single_image) ? designers.single_image : undefined;
  const rawTarget = singleImage?.per_day;
  const rawPlaceholder = singleImage?.placeholder;
  if (rawTarget !== undefined && rawTarget !== null && (!Number.isInteger(rawTarget) || Number(rawTarget) < 0)) {
    throw new Error("Invalid per_day value at designers.single_image");
  }
  if (singleImage && typeof rawPlaceholder !== "boolean") {
    throw new Error("Invalid placeholder value at designers.single_image");
  }
  const target: DesignerDailyTarget = {
    per_day: rawTarget === undefined ? null : rawTarget as number | null,
    placeholder: rawPlaceholder === undefined ? true : rawPlaceholder as boolean,
  };
  const rawWindows = isRecord(body.windows) ? body.windows : {};
  const windows = {} as Record<BrandAssetType, BrandAssetWindow>;
  for (const asset of BRAND_ASSET_TYPES) {
    const value = rawWindows[asset];
    if (value === undefined) {
      windows[asset] = { days: { min: null, max: null }, placeholder: true };
      continue;
    }
    if (!isRecord(value) || !isRecord(value.days) || typeof value.placeholder !== "boolean") {
      throw new Error(`Invalid brand asset window at windows.${asset}`);
    }
    const min = value.days.min;
    const max = value.days.max;
    for (const [name, bound] of [["min", min], ["max", max]] as const) {
      if (bound !== null && (!Number.isInteger(bound) || Number(bound) < 0)) {
        throw new Error(`Invalid ${name} days value at windows.${asset}`);
      }
    }
    if (min !== null && max !== null && Number(min) > Number(max)) {
      throw new Error(`Invalid days range at windows.${asset}`);
    }
    windows[asset] = { days: { min: min as number | null, max: max as number | null },
      placeholder: value.placeholder };
  }
  return { singleImage: target, roles, windows };
}

export function singleImageExpectation(target: DesignerDailyTarget, delivered: number, days: number) {
  const expected = target.per_day === null ? null : target.per_day * days;
  return {
    perDay: target.per_day,
    expected,
    delivered,
    gap: expected === null ? null : Math.max(0, expected - delivered),
    placeholder: target.placeholder,
  };
}

export function designerTargetForRole(target: DesignerDailyTarget, roles: readonly string[], role: string | null | undefined): DesignerDailyTarget {
  const normalizedRole = role?.trim().toLocaleLowerCase("en");
  return normalizedRole && roles.includes(normalizedRole) ? target : { per_day: null, placeholder: true };
}

/** Counts only tenant workdays, excluding mandatory holidays and (when requested) future dates. */
export function countedWorkdays(from: string, to: string, today: string, workDays: readonly number[], holidays: ReadonlySet<string>, capAtToday: boolean): number {
  const end = capAtToday && today < to ? today : to;
  if (end < from) return 0;
  let count = 0;
  for (let date = from; date <= end; date = new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10)) {
    const dayOfWeek = new Date(`${date}T00:00:00Z`).getUTCDay() || 7;
    if (workDays.includes(dayOfWeek) && !holidays.has(date)) count += 1;
  }
  return count;
}

export function brandAssetForDeliverableType(value: string): BrandAssetType | undefined {
  return BRAND_ASSET_TYPES.find(asset => value === asset || value === BRAND_ASSET_DELIVERABLE_TYPES[asset]);
}

type TypeRule = { match?: unknown; type?: unknown };
const isEditorType = (value: unknown): value is Exclude<EditorCreativeType, "other"> =>
  typeof value === "string" && (EDITOR_CREATIVE_TYPES as readonly string[]).includes(value) && value !== "other";

export function ruleMatches(pattern: unknown, value: string, full: boolean): boolean {
  if (typeof pattern !== "string" || !pattern) return false;
  try {
    const regex = new RegExp(full ? `^(?:${pattern})$` : pattern, "i");
    return regex.test(value);
  } catch {
    return false;
  }
}

export const DESIGN_DELIVERY_TYPES = ["single_image_ad", "carousel", "brochure", "logo", "pitch_deck"] as const;
export type DesignDeliveryType = (typeof DESIGN_DELIVERY_TYPES)[number] | "other";

const DESIGN_EXPORT_EXTENSIONS = new Set([
  ".ai", ".bmp", ".gif", ".jpeg", ".jpg", ".pdf", ".png", ".psd", ".svg", ".tif", ".tiff", ".webp",
]);

export function isDesignExport(mime: string | null | undefined, name: string): boolean {
  const contentType = (mime ?? "").toLowerCase();
  if (contentType.startsWith("video/")) return false;
  const basename = name.replaceAll("\\", "/").split("/").at(-1) ?? name;
  const dot = basename.lastIndexOf(".");
  const extension = dot < 0 ? "" : basename.slice(dot).toLowerCase();
  return contentType.startsWith("image/") || contentType === "application/pdf" || DESIGN_EXPORT_EXTENSIONS.has(extension);
}

function normalizedFolderSegment(segment: string): string {
  return segment.toLowerCase().replace(/^\s*#?\d+\s*[).:-]?\s*/, "").replaceAll("&", " and ").replace(/\s+/g, " ").trim();
}

function normalizedDesignFolderSegment(segment: string): string {
  return normalizedFolderSegment(segment).replace(/_+/g, " ");
}

function designFolderRuleMatches(pattern: unknown, value: string): boolean {
  if (typeof pattern !== "string" || !pattern) return false;
  try {
    return new RegExp(`\\b(?:${pattern})\\b`, "i").test(value);
  } catch {
    return false;
  }
}

function designRulesAt(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const nested = isRecord(value.folder_rules) ? value.folder_rules : value;
  const taxonomy = isRecord(nested.design_type_rules) ? nested.design_type_rules : value.design_type_rules;
  return isRecord(taxonomy) ? taxonomy : {};
}

export function classifyDesignType(path: string, name: string, folderRules: unknown): DesignDeliveryType {
  const taxonomy = designRulesAt(folderRules);
  const segments = path.replaceAll("\\", "/").split("/").filter(Boolean).map(normalizedDesignFolderSegment);
  const basename = name.replaceAll("\\", "/").split("/").at(-1) ?? name;
  const stem = basename.replace(/\.[^.]+$/, "");
  const exclusions = Array.isArray(taxonomy.exclude) ? taxonomy.exclude : [];
  const folderRulesList = Array.isArray(taxonomy.folder_path) ? taxonomy.folder_path as TypeRule[] : [];
  for (const segment of [...segments].reverse()) {
    if (exclusions.some(pattern => designFolderRuleMatches(pattern, segment))) return "other";
    for (const rule of folderRulesList) {
      if (!isRecord(rule) || !DESIGN_DELIVERY_TYPES.includes(rule.type as (typeof DESIGN_DELIVERY_TYPES)[number])) continue;
      if (designFolderRuleMatches(rule.match, segment)) return rule.type as DesignDeliveryType;
    }
  }
  const nameRules = Array.isArray(taxonomy.file_name) ? taxonomy.file_name as TypeRule[] : [];
  for (const rule of nameRules) {
    if (isRecord(rule) && DESIGN_DELIVERY_TYPES.includes(rule.type as (typeof DESIGN_DELIVERY_TYPES)[number])
      && ruleMatches(rule.match, stem, false)) return rule.type as DesignDeliveryType;
  }
  return "other";
}

function rulesAt(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const nested = isRecord(value.folder_rules) ? value.folder_rules : value;
  return isRecord(nested.creative_type_rules) ? nested.creative_type_rules : {};
}

/** Uses the tenant-owned EST-207 rules; unclassified deliveries remain `other`. */
export function classifyEditorCreativeType(path: string, name: string, folderRules: unknown): EditorCreativeType {
  const taxonomy = rulesAt(folderRules);
  const segments = path.replaceAll("\\", "/").split("/").filter(Boolean);
  const folderRulesList = Array.isArray(taxonomy.folder_path) ? taxonomy.folder_path as TypeRule[] : [];
  for (const rule of folderRulesList) {
    if (!isRecord(rule) || !isEditorType(rule.type) || typeof rule.match !== "string") continue;
    if (segments.some(segment => ruleMatches(rule.match, segment, true))) return rule.type;
  }

  const stem = name.replace(/\\/g, "/").split("/").at(-1)?.replace(/\.[^.]+$/, "") ?? name;
  const nameRules = Array.isArray(taxonomy.file_name) ? taxonomy.file_name as TypeRule[] : [];
  for (const rule of nameRules) {
    if (isRecord(rule) && isEditorType(rule.type) && ruleMatches(rule.match, stem, false)) return rule.type;
  }

  const codes = isRecord(taxonomy.parsed_type_codes) ? taxonomy.parsed_type_codes : {};
  const hints = isRecord(folderRules) && isRecord(folderRules.file_name)
    ? folderRules.file_name
    : isRecord(folderRules) && isRecord(folderRules.folder_rules) && isRecord(folderRules.folder_rules.file_name)
      ? folderRules.folder_rules.file_name
      : {};
  const legacyHints = isRecord(hints.legacy_type_hints) ? hints.legacy_type_hints : {};
  for (const [pattern, code] of Object.entries(legacyHints)) {
    if (ruleMatches(pattern, stem, false) && isEditorType(codes[String(code).toUpperCase()])) {
      return codes[String(code).toUpperCase()] as Exclude<EditorCreativeType, "other">;
    }
  }
  for (const [code, type] of Object.entries(codes)) {
    if (isEditorType(type) && ruleMatches(`(?:^|[^A-Z0-9])${code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\d{0,3}(?=[^A-Z0-9]|$)`, stem, false)) {
      return type;
    }
  }
  return "other";
}
