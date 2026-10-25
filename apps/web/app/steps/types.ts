// FLOW-C: what a step's work screen reads (GET /api/v1/flow/steps/:id and /records/:id) and the surface each module
// opens. A screen is chosen by the step's backend module (FLOW-D's primitives keep `module` as the backend), so any
// company's block of the same kind gets the same screen; nothing here names an industry.
import type { FlowRecord, IntakeItem, ModuleManifest, RecordType, RunDetail, RunStep, RunValue } from "../processes/flow-types";

export type StepDetail = {
  run: Omit<RunDetail, "steps" | "values">; step: RunStep; module: ModuleManifest; settings: Record<string, unknown>; qualityTest: string[];
  inputs: { port: string; label?: string | null }[]; values: RunValue[]; record: FlowRecord | null; records: FlowRecord[]; intake: IntakeItem[];
  sop: { processId: string | null; section: string | null; title: string | null; body: string } | null; canAct: boolean;
  /** FLOW-D: a Message step's text with the run's values filled in. */
  text?: string | null;
};
export type FlowComment = { id: string; section: string | null; anchor: string | null; kind: "comment" | "change"; body: string; ownerId: string | null; owner: string | null;
  dueOn: string | null; doneAt: string | null; at: string; by: string | null; resolvedAt: string | null };
export type RecordVersion = { version: number; title: string; status: string; note: string | null; savedAt: string; savedBy: string | null };
export type RecordDetail = { record: FlowRecord; type: RecordType | null; versions: RecordVersion[]; comments: FlowComment[] };

/** The work screens. One per kind of work, never per company. */
export type Screen = "doc" | "asset" | "meeting" | "review" | "verdict" | "check" | "media" | "session" | "requests" | "shoot" | "records" | "collect" | "intake" | "money" | "slot" | "message" | "assign" | "daily" | "wait" | "task"
  | "calendar" | "drive_folder" | "drive_file" | "webhook";
const BY_MODULE: Record<string, Screen> = {
  doc: "doc", doc_section: "doc", pip_draft: "doc", pack: "doc", summarise: "doc",
  asset: "asset",
  meeting: "meeting", transcribe: "meeting", sales_xray: "meeting",
  share_review: "review", approval: "verdict", decision: "verdict", follow_up: "verdict", check: "check",
  media_review: "media", upload: "media", edit: "media",
  session: "session", request: "requests", shoot: "shoot",
  records: "records", facts: "records", open_items: "records", word_library: "records", message_bank: "records", big_idea: "records", sequence: "records",
  decision_log: "records", casting: "records", extract: "records", library: "records",
  site_visit: "collect", data_capture: "collect", consent: "records", score: "collect", intake: "intake",
  quotation: "money", tax_invoice: "money", schedule: "slot", message: "message", assign: "assign", daily_update: "daily", wait: "wait",
  // FLOW-E: App actions.
  calendar_event: "calendar", drive_folder: "drive_folder", drive_file: "drive_file", webhook: "webhook",
};
export const screenOf = (module: string): Screen => BY_MODULE[module] ?? "task";

/** Modules whose step works on one record of its own (made the first time it is opened). Boards collect many. */
export const ownsRecord = (m: ModuleManifest | null) => !!m?.records?.length && (m.surface !== "board" || m.key === "shoot");

/** The record type a collecting step keeps: its setting, else what its Makes port says, else the module's first. */
export function collectType(d: StepDetail): string | null {
  const s = d.settings.recordType;
  if (typeof s === "string" && s) return s;
  return d.module.makes.find((p) => p.recordType)?.recordType ?? d.module.records?.[0] ?? null;
}

/** Records a step was handed (its Needs values that point at a record): the drafts a review shares, the cut a review watches. */
export function handed(d: StepDetail): { port: string; recordId: string; recordType: string; section?: string; value: Record<string, unknown> }[] {
  const out: { port: string; recordId: string; recordType: string; section?: string; value: Record<string, unknown> }[] = [];
  for (const v of d.values) {
    if (v.side !== "needs") continue;
    for (const x of Array.isArray(v.value) ? v.value : [v.value]) {
      const o = x as Record<string, unknown> | null;
      if (o && typeof o.recordId === "string") out.push({ port: v.port, recordId: o.recordId, recordType: String(o.recordType ?? ""), section: typeof o.section === "string" ? o.section : undefined, value: o });
    }
  }
  return out;
}

/** Everything that reached a step's needs, as plain values (form answers with photos, a slot, a quote). */
export function needValues(d: StepDetail) {
  return d.values.filter((v) => v.side === "needs").flatMap((v) => (Array.isArray(v.value) ? v.value : [v.value]).map((x) => ({ port: v.port, kind: v.kind, value: x as Record<string, unknown> })));
}

export const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const WEEK = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export function dayText(iso: string | null | undefined) {
  if (!iso) return "";
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  return Number.isNaN(d.getTime()) ? iso : `${WEEK[d.getDay()]} ${d.getDate()} ${MONTH[d.getMonth()]}`;
}
export function timeText(iso: string | null | undefined) {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : `${dayText(iso)}, ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
export const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
export const firstName = (name: string | null | undefined) => (name ?? "").split(" ")[0];
export const str = (x: unknown) => (typeof x === "string" ? x : x === null || x === undefined ? "" : String(x));
export const strList = (x: unknown) => (Array.isArray(x) ? x.map((y) => (typeof y === "string" ? y : JSON.stringify(y))).filter(Boolean) : []);

/** A step setting that may differ per value of the run's variant ({ starter: "sent", sellout: "confirmed" }). */
export function settingFor(d: StepDetail, key: string): string {
  const x = d.settings[key];
  if (x && typeof x === "object" && !Array.isArray(x)) { const o = x as Record<string, unknown>; const v = Object.values(d.run.fields).map(String).find((f) => f in o); return v ? str(o[v]) : ""; }
  return str(x);
}
