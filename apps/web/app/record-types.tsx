// PEOPLE-CONTACTS part 4 (owner, 11 Oct 2026): an organisation's own contact and client types (GET /api/v0/types,
// migration 0213), shown the same way everywhere: a coloured dot and the organisation's own label; a type's own
// fields in the edit form and on the profile. Keys never change; labels, colours and fields are the organisation's.
import type { CSSProperties } from "react";
import type { FieldDef } from "./records";
import css from "./record-types.module.css";

export type TypeField = { key: string; label: string; type: "text" | "number" | "date" | "url" | "tel" | "email" | "choice"; options?: string[] };
export type RecordType = { entity: "contact" | "client"; key: string; label: string; plural: string; color: string; hint: string | null; fields: TypeField[]; sort: number; system: boolean; archived: boolean; count: number };
/** Hue and saturation of each colour name the database allows. */
export const TYPE_COLORS: Record<string, [number, number]> = { slate: [220, 12], blue: [214, 82], violet: [262, 70], rose: [347, 74], amber: [38, 90], green: [146, 56], teal: [176, 62], orange: [22, 88], indigo: [234, 64], pink: [322, 70] };
export const typeStyle = (color: string) => { const [h, s] = TYPE_COLORS[color] ?? TYPE_COLORS.slate; return { "--type-h": h, "--type-s": `${s}%` } as CSSProperties; };
export const findType = (types: RecordType[] | undefined, entity: "contact" | "client", key: string | null | undefined) => types?.find((t) => t.entity === entity && t.key === key);
export const typeLabel = (types: RecordType[] | undefined, entity: "contact" | "client", key: string | null | undefined) => key ? findType(types, entity, key)?.label ?? key.replaceAll("_", " ") : null;

/** The type as a quiet coloured label. */
export function TypeBadge({ types, entity, value, empty }: { types?: RecordType[]; entity: "contact" | "client"; value: string | null | undefined; empty?: string }) {
  if (!value) return empty ? <span className={css.unset}>{empty}</span> : null;
  const t = findType(types, entity, value);
  return <span className={css.badge} style={typeStyle(t?.color ?? "slate")} title={t?.hint ?? undefined} data-archived={t?.archived ? "" : undefined}><i aria-hidden="true" />{t?.label ?? value.replaceAll("_", " ")}</span>;
}
/** Choices for a type field: current types, plus the record's own type if it was archived since. */
export const typeOptions = (types: RecordType[] | undefined, entity: "contact" | "client", current?: string | null) =>
  (types ?? []).filter((t) => t.entity === entity && (!t.archived || t.key === current)).map((t) => ({ value: t.key, label: t.label, hint: t.hint ?? undefined }));
/** A type's own fields, as edit-form fields ("custom.<key>"), under one heading. */
export function customFields(type: RecordType | undefined): FieldDef[] {
  return (type?.fields ?? []).map((f, i) => ({ key: `custom.${f.key}`, label: f.label, section: i === 0 ? `${type!.label} details` : undefined,
    type: f.type === "choice" ? "select" as const : f.type, options: f.type === "choice" ? (f.options ?? []).map((o) => ({ value: o, label: o })) : undefined }));
}
export const customValues = (type: RecordType | undefined, custom: Record<string, unknown> | null | undefined) =>
  Object.fromEntries((type?.fields ?? []).map((f) => [`custom.${f.key}`, custom?.[f.key] === undefined || custom?.[f.key] === null ? null : String(custom[f.key])]));
/** The filled-in values of a type's own fields, as label/value rows (nothing when none is filled in). */
export function CustomFacts({ type, custom }: { type: RecordType | undefined; custom: Record<string, unknown> | null | undefined }) {
  const rows = (type?.fields ?? []).filter((f) => custom?.[f.key] !== undefined && custom?.[f.key] !== null && custom?.[f.key] !== "");
  if (!rows.length) return null;
  return <>{rows.map((f) => { const v = String(custom![f.key]); return <div key={f.key} className={css.fact}><dt>{f.label}</dt><dd>{f.type === "url" ? <a href={v} target="_blank" rel="noreferrer">{v.replace(/^https?:\/\//, "")}</a> : f.type === "email" ? <a href={`mailto:${v}`}>{v}</a> : f.type === "tel" ? <a href={`tel:${v}`}>{v}</a> : v}</dd></div>; })}</>;
}
