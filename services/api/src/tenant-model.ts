// UX-TENANT: pure helpers behind the company setup wizard and the per-company module switches (no database here).
import { platformMail } from "./platform-config.js";

export type Module = "tasks" | "chats" | "finance";

/** API areas each switchable module covers. Projects, people and HR are not modules: every company has them. */
const MODULE_PATHS: [Module, RegExp][] = [
  ["tasks", /^\/api\/v0\/(tasks|work|workflows|forms)(\/|\?|$)/],
  ["chats", /^\/api\/v0\/chats(\/|\?|$)/],
  ["finance", /^\/api\/v0\/(finance|erp|money)(\/|\?|$)/],
];
export function moduleForPath(url: string): Module | null {
  for (const [module, pattern] of MODULE_PATHS) if (pattern.test(url)) return module;
  return null;
}
export const MODULE_OFF: Record<Module, string> = {
  tasks: "Work and tasks are off for your organisation.",
  chats: "Chats are off for your organisation.",
  finance: "Finance is off for your organisation.",
};

/** One CSV record per line, RFC 4180 quoting ("a, b" and "" inside quotes), CR/LF tolerant, BOM stripped. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cell = ""; let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  return rows;
}

export type PersonRow = { name: string; email: string; title: string; pod: string; team: string; manager: string; access: string };
const COLUMNS: Record<keyof PersonRow, string[]> = {
  name: ["name", "full name", "full_name", "employee name", "display name"],
  email: ["email", "e-mail", "work email", "work e-mail", "email address", "primary email"],
  title: ["title", "role", "designation", "job title", "position"],
  pod: ["pod", "squad", "unit"],
  team: ["team", "department", "dept"],
  manager: ["manager", "manager email", "reports to", "reporting manager", "line manager"],
  access: ["access", "pulse access", "pulse role", "permission"],
};

/** The people in a CSV whose first line names the columns (any order; the usual spellings are recognised). */
export function peopleFromCsv(text: string): { rows: PersonRow[]; columns: Partial<Record<keyof PersonRow, string>>; problems: string[] } {
  const records = parseCsv(text);
  if (!records.length) return { rows: [], columns: {}, problems: ["The file is empty"] };
  const header = records[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, " "));
  const at: Partial<Record<keyof PersonRow, number>> = {}; const columns: Partial<Record<keyof PersonRow, string>> = {};
  for (const key of Object.keys(COLUMNS) as (keyof PersonRow)[]) {
    const i = header.findIndex((h) => COLUMNS[key].includes(h));
    if (i >= 0) { at[key] = i; columns[key] = records[0][i].trim(); }
  }
  // "First name" + "Last name" (a Google Workspace export) make the name.
  const first = header.indexOf("first name"), last = header.indexOf("last name");
  const problems: string[] = [];
  if (at.name === undefined && (first < 0 || last < 0)) problems.push("No name column: name the first line's columns, e.g. Name, Email, Title, Pod, Team, Manager, Access");
  if (records.length > 2001) problems.push("Up to 2,000 people at a time");
  const pick = (r: string[], key: keyof PersonRow) => at[key] === undefined ? "" : (r[at[key]!] ?? "").trim();
  const rows = problems.length ? [] : records.slice(1, 2001).map((r) => ({
    name: at.name !== undefined ? pick(r, "name") : `${(r[first] ?? "").trim()} ${(r[last] ?? "").trim()}`.trim(),
    email: pick(r, "email"), title: pick(r, "title"), pod: pick(r, "pod"), team: pick(r, "team"), manager: pick(r, "manager"),
    access: pick(r, "access").toLowerCase(),
  }));
  return { rows, columns, problems };
}

/** WCAG contrast ratio of two #rrggbb colours. */
export function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

/** Whether an accent works as the company's action colour: buttons carry white text on it and links use it on a white
 *  page (4.5:1). The dark theme uses a lighter mix of it, so its own contrast is reported, not required. */
export function accentCheck(accent: string): { ok: boolean; light: number; dark: number; note: string | null } {
  if (!/^#[0-9a-f]{6}$/i.test(accent)) return { ok: false, light: 0, dark: 0, note: "Choose a colour like #5b45d6" };
  const light = Math.round(contrast(accent.toLowerCase(), "#ffffff") * 100) / 100, dark = Math.round(contrast(accent.toLowerCase(), "#121219") * 100) / 100;
  const note = light < 4.5 ? "Too light: white text on its buttons and links on a white page would be hard to read" : null;
  return { ok: !note, light, dark, note };
}

/** Suggestions for the company step from a name: short name, code and address. */
export function suggest(name: string): { slug: string; code: string } {
  const words = name.normalize("NFKD").replace(/[^\p{L}\p{N} ]/gu, " ").trim().split(/\s+/).filter(Boolean);
  const slug = words.join("-").toLowerCase().replace(/[^a-z0-9-]/g, "").replace(/-+/g, "-").slice(0, 40).replace(/^-|-$/g, "");
  const code = (words.length > 1 ? words.map((w) => w[0]).join("") : (words[0] ?? "")).toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);
  return { slug, code: code.length >= 2 ? code : (code + "XX").slice(0, 2) };
}

/** The address links point at: the company's own host, else the install's. A *.localhost rehearsal is plain http on
 *  the port the operator is using (the same local web server answers both addresses). */
export function publicOrigin(host: string | null | undefined, fallback: string | undefined, requestHost?: string): string {
  if (host && /\.localhost$/.test(host)) { const port = requestHost?.match(/:(\d{2,5})$/)?.[1]; return `http://${host}${port ? `:${port}` : ""}`; }
  if (host) return `https://${host}`;
  // DE-EA: no install address set up (a test or a bare dev server): links point at this machine, never another company.
  return (fallback ?? platformMail().origin ?? "https://localhost").replace(/\/$/, "");
}

// ------------------------------------------------------------------------------------------------------------ R53
// Repeatable setup (pulse.tenant_plan, 0480) and the activation checklist: what the database says, written as a guide.

/** One setup plan as the API accepts it: only known fields, bounded lengths. The database checks the values. */
export type PlanSpec = { company?: Record<string, string | boolean>; modules?: Record<string, unknown>; rules?: { role: string; action: string; scope: string }[];
  sources?: { key: string; kind: string; label: string; connector?: string; categories?: string[]; grants?: string }[] };
const COMPANY_FIELDS: Record<string, number> = { name: 80, slug: 40, code: 4, timeZone: 60, dataRegion: 10, host: 253 };
export function planSpec(input: unknown): PlanSpec {
  const b = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const out: PlanSpec = {};
  const str = (x: unknown, max: number) => String(x ?? "").slice(0, max);
  if (b.company && typeof b.company === "object") {
    const c = b.company as Record<string, unknown>;
    out.company = Object.fromEntries(Object.entries(COMPANY_FIELDS).filter(([k]) => k in c && c[k] != null).map(([k, max]) => [k, str(c[k], max)]));
    if (typeof c.rehearsal === "boolean") out.company.rehearsal = c.rehearsal;
  }
  if (b.modules && typeof b.modules === "object") out.modules = Object.fromEntries(Object.entries(b.modules as Record<string, unknown>).slice(0, 8).map(([k, v]) => [k.slice(0, 20), v]));
  if (Array.isArray(b.rules)) out.rules = (b.rules as Record<string, unknown>[]).slice(0, 21).map((r) => ({ role: str(r?.role, 20), action: str(r?.action, 30), scope: str(r?.scope, 10) }));
  if (Array.isArray(b.sources)) out.sources = (b.sources as Record<string, unknown>[]).slice(0, 31).map((s) => ({
    key: str(s?.key, 40), kind: str(s?.kind, 20), label: str(s?.label, 80), ...(s?.connector ? { connector: str(s.connector, 40) } : {}),
    ...(Array.isArray(s?.categories) ? { categories: (s.categories as unknown[]).slice(0, 12).map((x) => str(x, 30)) } : {}), ...(s?.grants ? { grants: str(s.grants, 20) } : {}) }));
  return out;
}

/** The operator's handover fields, cleaned; a field the body leaves out stays as it is in the database. */
export function handoverInput(input: unknown): { body: Record<string, unknown>; problem: string | null } {
  const b = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const body: Record<string, unknown> = {};
  const text = (x: unknown, max: number) => x == null || x === "" ? null : String(x).replace(/\s+/g, " ").trim().slice(0, max);
  if ("operatorId" in b) body.operatorId = b.operatorId ? String(b.operatorId).slice(0, 36) : null;
  for (const k of ["support", "termsRef", "rolloutRef"]) if (k in b) body[k] = text(b[k], 200);
  if ("restore" in b) {
    const r = b.restore && typeof b.restore === "object" ? b.restore as Record<string, unknown> : null;
    body.restore = r ? { on: String(r.on ?? "").slice(0, 10), minutes: Number(r.minutes), result: String(r.result ?? ""), isolated: r.isolated === true, ref: text(r.ref, 200) } : null;
  }
  if (!Object.keys(body).length) return { body, problem: "Nothing to record: name the operator, the support route, a restore drill or the owner's references" };
  return { body, problem: null };
}

export type Gate = { key: string; ok: boolean; label: string; detail: string };
export type RegistrySource = { id: string; key: string; kind: string; label: string; connector: string | null; categories: string[]; sensitive: string[]; grants: string;
  decision: "planned" | "approved" | "declined"; decidedAt: string | null; note: string | null; ready: boolean; why: string;
  install: null | { id: string; status: string; keyInstalled: boolean; missingEntities: string[]; approvedRoots: number } };
export type SetupGates = {
  company: { name: string; status: string; activation: "trial" | "live"; rehearsal: boolean; host: string | null; prefix: string | null };
  facts: { admins: number; adminsSignedIn: number; adminsTwoStep: number; people: number; withEmail: number; duplicateNames: number; sharedEmails: number;
    sources: number; sourcesReady: number; offices: number; hrConfirmed: boolean; attendance: boolean; signIns: number; invitationsSent: number; devices: number; connectorsActive: number };
  sources: RegistrySource[];
  pilot?: Pilot;
  handover: { operatorNamed: boolean; supportRoute: string | null; restore: null | { on: string; minutes: number; result: string; isolated: boolean; ref: string };
    termsRef: string | null; rolloutRef: string | null; isolationAt: string | null; activatedAt: string | null };
  gates: Gate[]; ready: boolean; blocked: string[];
};
/** R54 (0490): what the trial's pilot tried (latest result per platform, HR's walkthrough) and the feedback totals. */
export type Evidence = "mock" | "simulator" | "installed_device" | "real_data_read_only";
export type Pilot = {
  devices: { platform: string; evidence: Evidence; result: "passed" | "failed"; on: string }[]; platforms: number; passed: number; installed: number; devicesOk: boolean;
  walkthrough: null | { evidence: Evidence; result: "passed" | "failed"; on: string }; walkthroughOk: boolean;
  feedback: { answers: number; minimum: number; shownAnswers: number | null; shownOn: string | null; questions: { key: string; label: string; average: number | null; agree: number | null }[] };
};
export type GuideStep = { key: string; title: string; who: "Pulse" | "Platform operator" | "Company admin" | "Company admin and HR" | "HR" | "Owner" | "Staff";
  how: "automatic" | "manual"; state: "done" | "todo" | "blocked" | "waiting" | "later"; detail: string; gate: boolean; errands: string[]; href: string | null };

/** The setup guide, in the order the work happens: who does each step, whether Pulse does it or a person does, what it
 *  waits for, and the owner errands that keep a gate closed. `side` picks the links: the operator's wizard or the
 *  company's own pages (the operator cannot act inside the company). */
export function setupGuide(g: SetupGates, side: "operator" | "company", setupId?: string): GuideStep[] {
  const f = g.facts; const c = g.company; const gate = (key: string) => g.gates.find((x) => x.key === key) ?? { key, ok: false, label: key, detail: "" };
  const open = c.status === "active"; const live = c.activation === "live";
  const local = !!c.host && /\.localhost$/.test(c.host);
  const wizard = (step: string) => side === "operator" && setupId ? `/companies/${setupId}?step=${step}` : null;
  const own = (href: string) => side === "company" ? href : null;
  const gated = (key: string): Pick<GuideStep, "state" | "detail" | "gate"> => { const x = gate(key); return { state: x.ok ? "done" : "todo", detail: x.detail, gate: true }; };
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const steps: GuideStep[] = [
    { key: "created", title: "Company created from its setup plan", who: "Pulse", how: "automatic", state: "done", gate: false, errands: [], href: wizard("company"),
      detail: `Its address, HR policy (attendance off), modules, roles and who-can-do-what, object prefix ${c.prefix ?? "(set when the plan is applied)"} and source registry, in one transaction. Nothing was copied from another company.` },
    { key: "address", title: "The address reaches this Pulse", who: "Platform operator", how: "manual", gate: false, errands: local || c.rehearsal ? [] : ["E18"], href: null,
      state: local || f.adminsSignedIn > 0 ? "done" : "todo",
      detail: local ? "A *.localhost rehearsal address needs no DNS" : f.adminsSignedIn > 0 ? `Its admin signed in at ${c.host}` : `Point ${c.host ?? "its address"} at this Pulse in Cloudflare, without Access in front of it` },
    { key: "open", title: "Open for its admins (trial)", who: "Platform operator", how: "manual", gate: false, errands: [], href: wizard("open"),
      state: open ? "done" : "todo", detail: open ? "Open in trial: only its admins, HR and leadership can sign in" : "The isolation check and the first admin come first; then open it" },
    { key: "admin", title: "Its admin signs in and turns on two-step verification", who: "Company admin", how: "manual", errands: [], href: own("/account"),
      ...gated("admin"), ...(open || gate("admin").ok ? {} : { state: "waiting" as const, detail: "After the company opens: the admin sets a password with the private link, then turns on two-step verification under Account" }) },
    { key: "identity", title: "People and identities reviewed", who: "Company admin and HR", how: "manual", errands: [], href: own("/people"), ...gated("identity") },
    { key: "sources", title: "Sources connected and granted", who: "Company admin", how: "manual", errands: g.sources.some((s) => s.connector) ? ["E13"] : [], href: own("/settings?tab=connected"),
      ...gated("sources") },
    { key: "policies", title: "Offices, shifts and working rules", who: "HR", how: "manual", gate: false, errands: ["E04", "E06"], href: own("/hr?tab=policies&view=rules"),
      state: f.offices > 0 && f.hrConfirmed ? "done" : "todo",
      detail: `${plural(f.offices, "office")}, working rules ${f.hrConfirmed ? "confirmed by HR" : "not yet confirmed by HR"}; attendance ${f.attendance ? "on" : "stays off until HR has set them"}. Not needed for activation.` },
    // R54: the trial is the pilot. Its admins, HR and leadership pair their own devices and HR walks through it.
    { key: "devices", title: "Pilot devices tested", who: "Company admin and HR", how: "manual", errands: c.rehearsal ? [] : ["E03"], href: own("/settings?tab=devices"),
      ...gated("devices"), ...(open || gate("devices").ok ? {} : { state: "waiting" as const, detail: "During the trial: its admins, HR and leadership pair their own devices and record what worked on each platform" }) },
    { key: "walkthrough", title: "HR walks through it and signs off", who: "HR", how: "manual", errands: c.rehearsal ? [] : ["E06", "E18"], href: null,
      ...gated("walkthrough"), ...(open || gate("walkthrough").ok ? {} : { state: "waiting" as const, detail: "During the trial: HR reads the company's people, roles, policies and sources (read only) and signs off" }) },
    { key: "feedback", title: "Pilot feedback: effort, fairness, calm, ease", who: "Staff", how: "manual", gate: false, errands: [], href: own("/settings?tab=devices"),
      ...feedbackStep(g.pilot?.feedback, open) },
    { key: "isolation", title: "Isolation check", who: "Platform operator", how: "automatic", errands: [], href: wizard("activate"), ...gated("isolation") },
    { key: "backup", title: "Restore drill", who: "Platform operator", how: "manual", errands: ["E19"], href: wizard("activate"), ...gated("backup") },
    { key: "handover", title: "Responsible operator and support route", who: "Platform operator", how: "manual", errands: ["E19"], href: wizard("activate"), ...gated("handover") },
    { key: "terms", title: "Privacy terms and the owner's rollout instruction", who: "Owner", how: "manual", errands: c.rehearsal ? [] : ["E08", "E18"], href: wizard("activate"), ...gated("terms") },
    { key: "activate", title: "Activated for staff", who: "Platform operator", how: "manual", gate: false, errands: [], href: wizard("activate"),
      state: live ? "done" : g.ready ? "todo" : "blocked",
      detail: live ? "Live: everyone the company invites can sign in" : g.ready ? "Every gate passes: the operator can activate it" : `Waiting for: ${g.blocked.join("; ")}` },
    { key: "staff", title: "Staff invited and devices paired", who: "Staff", how: "manual", gate: false, errands: [], href: own("/settings?tab=devices"),
      state: !live ? "later" : f.devices > 0 ? "done" : "todo",
      detail: live ? `${plural(f.invitationsSent, "invitation")} sent, ${plural(f.devices, "device")} paired. HR invites people; each installs the same Pulse app and pairs it` : "After activation. Real invitations go out only on the owner's instruction" },
  ];
  return steps;
}

function feedbackStep(fb: Pilot["feedback"] | undefined, open: boolean): Pick<GuideStep, "state" | "detail"> {
  if (!fb || !open) return { state: "waiting", detail: "During the trial and after: four questions, answered once and anonymously; only totals are kept" };
  if (fb.shownAnswers == null) return { state: "todo", detail: `${fb.answers} answered so far; the totals show from ${fb.minimum} answers. Not needed for activation.` };
  const words = fb.questions.map((q) => `${q.label.replace(/^Pulse /, "")}: ${q.average ?? "–"} of 5`).join("; ");
  return { state: "done", detail: `${fb.answers} answered. As of ${fb.shownAnswers} answers: ${words}. Not needed for activation.` };
}

/** The owner errands behind each gate (OWNER-ERRANDS.md): what keeps it closed until the owner or HR supplies it. */
const GATE_ERRANDS: Record<string, string[]> = { admin: [], identity: [], sources: ["E13"], devices: ["E03"], walkthrough: ["E06", "E18"], isolation: [],
  backup: ["E19", "E10"], handover: ["E19"], terms: ["E08", "E18"] };
const EVIDENCE: Record<Evidence, string> = { mock: "mock", simulator: "simulator", installed_device: "installed device", real_data_read_only: "real data, read only" };
export type Readiness = {
  verdict: "live" | "ready" | "not_ready"; rehearsal: boolean; title: string; summary: string;
  open: { key: string; label: string; detail: string; errands: string[] }[]; errands: string[]; evidence: string[];
};

/** R54: the explicit readiness result. A rehearsal is always called a rehearsal, whatever its gates say: synthetic
 *  people and evidence prove the path, never that a real company may let its staff in. */
export function readiness(g: SetupGates): Readiness {
  const rehearsal = g.company.rehearsal; const live = g.company.activation === "live";
  const open = g.gates.filter((x) => !x.ok).map((x) => ({ key: x.key, label: x.label, detail: x.detail,
    errands: rehearsal && x.key === "terms" ? [] : GATE_ERRANDS[x.key] ?? [] }));
  const verdict: Readiness["verdict"] = live ? "live" : open.length === 0 ? "ready" : "not_ready";
  const n = g.gates.length;
  const title = rehearsal
    ? verdict === "live" ? "Rehearsal company, activated for its synthetic staff" : verdict === "ready" ? "Rehearsal ready: every gate passes" : `Rehearsal not ready: ${open.length} of ${n} gates open`
    : verdict === "live" ? "Live for staff" : verdict === "ready" ? "Ready: every gate passes; the platform operator may activate it for staff" : `Not ready for staff: ${open.length} of ${n} gates open`;
  const summary = rehearsal
    ? "A rehearsal with synthetic people and synthetic evidence: it exercises the setup path, it is not a live company launch, and it says nothing about a real company's readiness."
    : verdict === "live" ? "Its staff sign in. Real invitations went out only on the owner's explicit rollout instruction."
    : "Real staff are invited only once every gate passes and on the owner's explicit rollout instruction. Each open gate names who still owes it.";
  const p = g.pilot;
  const evidence = p ? [...p.devices.map((d) => `${d.platform}: ${d.result} (${EVIDENCE[d.evidence]})`),
    ...(p.walkthrough ? [`HR walkthrough: ${p.walkthrough.result} (${EVIDENCE[p.walkthrough.evidence]})`] : [])] : [];
  return { verdict, rehearsal, title, summary, open, errands: [...new Set(open.flatMap((o) => o.errands))].sort(), evidence };
}

/** A pilot check as the API accepts it; the database checks every value and who may record it. */
export function pilotCheckInput(input: unknown): Record<string, unknown> {
  const b = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const str = (x: unknown, max: number) => String(x ?? "").slice(0, max);
  return { kind: str(b.kind, 20), ...(b.platform ? { platform: str(b.platform, 20) } : {}), evidence: str(b.evidence, 30), result: str(b.result, 10),
    covers: Array.isArray(b.covers) ? (b.covers as unknown[]).slice(0, 12).map((c) => str(c, 20)) : [], ...(b.note ? { note: str(b.note, 300) } : {}) };
}

/** Pilot feedback answers: the four questions, each a whole number 1 to 5 (anything else is left for the database to refuse). */
export function feedbackInput(input: unknown): Record<string, number | null> {
  const b = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  return Object.fromEntries(["effort", "fair", "calm", "easy"].map((k) => { const n = Number(b[k]); return [k, Number.isInteger(n) ? n : null]; }));
}
