import Link from "next/link";
import type { ReactNode } from "react";
import { Repeat2 } from "lucide-react";
import type { Stage } from "../lib/api";
import { ago, count, plural } from "../lib/format";
import { RecordForm, type FieldDef } from "../records";
import { Badge, Fact, styles } from "../ui";
import css from "./records.module.css";
import type { ClientType, ContactType, RecordProject } from "./types";
import { customFields, findType, typeOptions, type RecordType } from "../record-types";

export { css };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const month = (value: string) => `${MONTHS[Number(value.slice(5, 7)) - 1]} ${value.slice(0, 4)}`;
export const months = (first: string | null, last: string | null) => !first ? null : !last || first === last ? month(first) : `${month(first)} – ${month(last)}`;
export const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());

export const CLIENT_TYPES: Record<ClientType, string> = { developer: "Developer", channel_partner: "Channel partner", other: "Other" };
export const CONTACT_TYPES: Record<ContactType, string> = { developer: "Developer", channel_partner: "Channel partner", talent: "Model", vendor: "Vendor", other: "Other" };
export const CLIENT_STATUS: Record<string, { label: string; tone: "accent" | "success" | "warning" | "neutral" }> = {
  prospect: { label: "Prospect", tone: "accent" }, active: { label: "Active", tone: "success" }, paused: { label: "Paused", tone: "warning" }, churned: { label: "Churned", tone: "neutral" },
};
const STAGES: Record<Stage, { label: string; tone: "accent" | "success" | "warning" | "neutral" }> = {
  delivering: { label: "Delivering", tone: "success" }, quiet: { label: "Quiet", tone: "warning" }, new: { label: "New", tone: "accent" }, dormant: { label: "Dormant", tone: "neutral" },
  paused: { label: "Paused", tone: "warning" }, done: { label: "Done", tone: "neutral" }, cancelled: { label: "Cancelled", tone: "neutral" },
};
const options = (labels: Record<string, string | { label: string }>) => Object.entries(labels).map(([value, l]) => ({ value, label: typeof l === "string" ? l : l.label }));

export const CLIENT_FIELDS: FieldDef[] = [
  { key: "displayName", label: "Name", required: true, placeholder: "How the team refers to this client" },
  { key: "companyName", label: "Company name", placeholder: "Registered or brand name" },
  { key: "clientType", label: "Type", type: "select", required: true, options: options(CLIENT_TYPES) },
  { key: "status", label: "Status", type: "select", options: options(CLIENT_STATUS) },
  { key: "website", label: "Website", placeholder: "example.com" }, { key: "email", label: "E-mail", type: "email" },
  { key: "phone", label: "Phone", type: "tel" }, { key: "city", label: "City" },
  { key: "notes", label: "Notes", type: "textarea" },
];
export const CONTACT_FIELDS: FieldDef[] = [
  { key: "name", label: "Name", required: true },
  { key: "contactType", label: "Type", type: "select", options: options(CONTACT_TYPES) },
  { key: "designation", label: "Designation", placeholder: "Sales head, founder, model…" }, { key: "city", label: "City" },
  { key: "email", label: "E-mail", type: "email" }, { key: "phone", label: "Phone", type: "tel" },
  { key: "notes", label: "About them", type: "textarea", placeholder: "Who they are to you, how they like to be reached. Dated notes go on their profile." },
];
/** PEOPLE-CONTACTS: the same forms with the organisation's own types (and, for a record of a type, its own fields). */
export const clientFields = (types: RecordType[] | undefined, type?: string | null): FieldDef[] => [
  ...CLIENT_FIELDS.map((f) => f.key === "clientType" ? { ...f, options: typeOptions(types, "client", type) } : f),
  ...customFields(findType(types, "client", type))];
export const contactFields = (types: RecordType[] | undefined, type?: string | null): FieldDef[] => [
  ...CONTACT_FIELDS.map((f) => f.key === "contactType" ? { ...f, options: typeOptions(types, "contact", type) } : f),
  ...customFields(findType(types, "contact", type))];
export const SOURCES: Record<string, string> = { drive_folder_name: "Read from Drive project folder names", manual: "Added in Pulse by a person", sales_xray: "Made from a Sales X-Ray lead by lead sync" };
export const EDIT_NOTE = "A field you change here is kept as you set it; the next sync will not overwrite it. Every change is logged in History.";

/** A recorded value, or an "Add" prompt that opens the edit form for whoever may edit. */
export function Detail({ value, show, add, edit }: { value: string | null; show?: ReactNode; add: string; edit?: { path: string; title: string; fields: readonly FieldDef[]; values: Record<string, string | null> } }) {
  if (value) return <>{show ?? value}</>;
  return edit ? <RecordForm {...edit} label={add} variant="link" note={EDIT_NOTE} /> : <Fact />;
}

export function StageBadge({ stage }: { stage: Stage }) {
  const s = STAGES[stage] ?? { label: stage, tone: "neutral" as const };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

/** Engagements grouped by development: folders that share a project key are one project shot more than once. */
export function groupProjects(projects: RecordProject[]) {
  const groups = new Map<string, RecordProject[]>();
  for (const p of projects) { const key = p.projectKey ?? p.projectId; groups.set(key, [...(groups.get(key) ?? []), p]); }
  return [...groups.values()];
}

export function ProjectsTable({ projects, showClient, flat }: { projects: RecordProject[]; showClient?: boolean; flat?: boolean }) {
  const row = (p: RecordProject, child: boolean) => (
    <tr key={p.projectId} className={child ? css.child : undefined}>
      <td><Link href={`/projects/${p.projectId}`} className={styles.cellLink} title={p.folderName}>{p.title}</Link>
        <span className={styles.cellSub}>{[showClient ? p.clientName : null, p.location, p.segment, p.contactRole].filter(Boolean).join(" · ") || "No location recorded"}</span></td>
      <td className={styles.nowrap}>{p.startMonth ? month(p.startMonth) : <span className={styles.muted}>Not dated</span>}</td>
      <td><StageBadge stage={p.stage} /></td>
      <td className={styles.right}>{count(p.total)}</td>
      <td className={styles.nowrap}>{p.lastDeliveredAt ? ago(p.lastDeliveredAt) : <span className={styles.muted}>None indexed</span>}</td>
    </tr>
  );
  return (
    <div className={styles.tableWrap}><table className={styles.table}>
      <thead><tr><th>Project</th><th>Started</th><th>Stage</th><th className={styles.right}>Deliveries</th><th>Last delivery</th></tr></thead>
      <tbody>{(flat ? projects.map((p) => [p]) : groupProjects(projects)).flatMap((group) => group.length === 1 ? [row(group[0], false)] : [
        <tr key={`group:${group[0].projectId}`} className={css.groupRow}>
          <td colSpan={5}><Repeat2 size={13} aria-hidden="true" /><b>{group[0].title}</b> · repeat project, {plural(group.length, "engagement")} · {plural(group.reduce((n, p) => n + p.total, 0), "delivery", "deliveries")}</td>
        </tr>,
        ...group.map((p) => row(p, true)),
      ])}</tbody>
    </table></div>
  );
}
