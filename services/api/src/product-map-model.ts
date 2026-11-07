// PRODUCT-MAP: the pure half of the Product map (services/api/src/product-map.ts holds the routes, migration 1010 the
// tables). What a manifest may hold and how it is bounded; how the map is read for issues (dead ends, unreachable
// screens, links to nowhere, buttons that do nothing, missing links between steps, permission mismatches, slow and
// failing screens); the user types and journeys Pulse proposes on its own from the code and from real use; the plan the
// build team and AI agents fetch (JSON and Markdown); and the AI pass's brief and how its answer is checked. Every claim
// carries its evidence. Nothing here touches the database or the network.
import { createHash } from "node:crypto";

export const SCHEMA = "pulse-product-map/1";
export const ELEMENT_KINDS = ["button", "tab", "link", "form", "field", "menu", "dialog"] as const;
export const EDGE_KINDS = ["link", "nav", "redirect", "usage", "proposed"] as const;
export const ISSUE_KINDS = ["dead_end", "orphan", "no_op", "missing_link", "permission", "slow", "error", "other"] as const;
export const JOURNEY_STATUS = ["discovered", "auto", "drafted", "planned", "shipped"] as const;
export const SKILL = ["", "beginner", "intermediate", "expert"] as const;
export const COMFORT = ["", "low", "medium", "high"] as const;
export const FREQUENCY = ["", "daily", "weekly", "monthly", "rarely"] as const;
export const DEVICE = ["", "phone", "desktop", "both"] as const;
export const PRIORITY = ["", "now", "next", "later"] as const;
export const LIMITS = { screens: 800, elementsPerScreen: 300, elements: 30000, edges: 8000, features: 300, personas: 40, journeys: 300, steps: 40 };

export type ElementKind = typeof ELEMENT_KINDS[number];
export type EdgeKind = typeof EDGE_KINDS[number];
export type IssueKind = typeof ISSUE_KINDS[number];
export type Evidence = { kind: "screen" | "element" | "telemetry" | "code" | "role" | "note"; ref: string; text: string };
export type Role = { key: string; name: string; description: string };
export type MScreen = { key: string; route: string; title: string; purpose: string; area: string; access: string[]; proposed: boolean; status: "live" | "proposed" | "removed" };
export type MElement = { screen: string; kind: ElementKind; label: string; target: string; destructive: boolean; proposed: boolean; handler?: boolean };
export type MEdge = { from: string; to: string; kind: EdgeKind; label: string; count?: number; medianMs?: number | null };
export type MFeature = { key: string; name: string; description: string; screens: string[]; proposed: boolean; origin: string };
export type MPersona = { key: string; name: string; role: string; description: string; goals: string[]; ageGroup: string; skillLevel: string; techComfort: string; frequency: string;
  device: string; permissions: string[]; features: string[]; evidence: Evidence[]; confidence: number | null; origin: string };
export type Step = { screen: string; action: string; element: string; expected: string; proposed?: boolean; note?: string };
export type MJourney = { key: string; personaKey: string; title: string; goal: string; status: typeof JOURNEY_STATUS[number]; steps: Step[]; evidence: Evidence[]; confidence: number | null;
  usage: { sessions?: number; people?: number; medianMs?: number | null }; origin: string; priority: string; acceptance: string[] };
export type MIssue = { fingerprint: string; kind: IssueKind; severity: "high" | "medium" | "low"; title: string; detail: string; screenKey: string; journeyKey: string; evidence: Evidence[]; confidence: number };
export type ScreenUse = { views: number; people: number; sessions: number; p75Ms: number | null; errors: number; slowApiMs: number | null };
export type Usage = { screens: Record<string, ScreenUse>; transitions: { from: string; to: string; count: number; medianMs: number | null }[];
  paths: { steps: string[]; sessions: number; people: number; role: string; medianMs: number | null }[];
  roles: Record<string, { people: number; sessions: number; phone: number; desktop: number; activeDays: number; days: number }>; days: number; sessions: number };
export type MapData = { name: string; roles: Role[]; entries: string[]; screens: MScreen[]; elements: MElement[]; edges: MEdge[]; features: MFeature[]; personas: MPersona[]; journeys: MJourney[]; usage?: Usage | null };

// ---------------------------------------------------------------------------------------------------------- basics
const str = (x: unknown, max: number) => String(x ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const text = (x: unknown, max: number) => String(x ?? "").replace(/\r\n/g, "\n").trim().slice(0, max);
const pick = <T extends string>(x: unknown, list: readonly T[], fallback: T): T => (list as readonly string[]).includes(String(x)) ? String(x) as T : fallback;
const list = (x: unknown, max: number, each: number) => Array.isArray(x) ? [...new Set(x.map((s) => str(s, each)).filter(Boolean))].slice(0, max) : [];
export const slug = (x: unknown, max = 80) => str(x, 200).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max);
export const hash = (x: unknown) => createHash("sha256").update(typeof x === "string" ? x : JSON.stringify(x)).digest("hex");
const conf = (x: unknown) => { const n = Number(x); return Number.isFinite(n) ? Math.round(Math.min(1, Math.max(0, n)) * 100) / 100 : null; };
const percentile = (xs: number[], p: number) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))]); };

/** "/people/3f2a…?tab=ai" or "/people/:id" → "/people/:id"; a screen key is a route template. */
export function routeKey(raw: unknown): string {
  let s = str(raw, 400).split("#")[0].split("?")[0];
  if (!s) return "";
  if (!s.startsWith("/")) s = `/${s}`;
  s = s.replace(/\/+$/, "") || "/";
  return s.split("/").map((seg) => /^:/.test(seg) ? seg : /^\[.*\]$/.test(seg) || /^[0-9a-f-]{16,}$/i.test(seg) || /^\d+$/.test(seg) ? ":id" : seg).join("/").slice(0, 200);
}
/** Route templates match when every part matches or either side is a parameter. */
export function sameRoute(a: string, b: string) {
  if (a === b) return true;
  const x = a.split("/"), y = b.split("/");
  if (x.length !== y.length) return false;
  return x.every((s, i) => s === y[i] || s.startsWith(":") || y[i].startsWith(":"));
}
/** The screen a route names among `keys` (exact first, then by template), or null. */
export function screenFor(route: string, keys: readonly string[]): string | null {
  const r = routeKey(route); if (!r) return null;
  if (keys.includes(r)) return r;
  return keys.find((k) => k.startsWith("/") && sameRoute(k, r)) ?? null;
}
const OUTSIDE_ENTRY = /(:token|callback|invite|join|accept|reset|password|verify|confirm|login|log-in|signin|sign-in|signup|sign-up|logout|offline|not-found|error|unsubscribe|print|embed|share|\/s\/)/i;

// ------------------------------------------------------------------------------------------------------- manifests
export type Manifest = { app: { name: string; baseUrl: string; kind: string }; roles: Role[]; entries: string[];
  screens: (Omit<MScreen, "proposed" | "status"> & { elements: Omit<MElement, "screen" | "proposed">[]; meta: Record<string, unknown> })[];
  edges: Omit<MEdge, "count" | "medianMs">[]; features: Omit<MFeature, "proposed" | "origin">[]; personas: Partial<MPersona>[]; journeys: Partial<MJourney>[] };

/** A manifest (pushed, fetched from /.well-known/pulse-product-map.json, or written by the repo scan) checked and bounded.
 *  Unknown fields are dropped; the warnings say what was left out. */
export function normalizeManifest(x: unknown): { manifest: Manifest; warnings: string[] } {
  const warnings: string[] = [];
  if (!x || typeof x !== "object" || Array.isArray(x)) throw new Error("A manifest is a JSON object");
  const m = x as Record<string, unknown>;
  if (m.schema !== undefined && m.schema !== SCHEMA) warnings.push(`Schema "${str(m.schema, 40)}" read as ${SCHEMA}`);
  const app = (m.app && typeof m.app === "object" ? m.app : {}) as Record<string, unknown>;
  const roles = (Array.isArray(m.roles) ? m.roles : []).slice(0, LIMITS.personas).map((r: Record<string, unknown>) => ({ key: slug(r?.key ?? r?.name, 80), name: str(r?.name ?? r?.key, 120), description: text(r?.description, 600) })).filter((r) => r.key);
  const rawScreens = Array.isArray(m.screens) ? m.screens : [];
  if (rawScreens.length > LIMITS.screens) warnings.push(`${rawScreens.length - LIMITS.screens} screens past ${LIMITS.screens} left out`);
  const seen = new Set<string>(); let total = 0;
  const screens: Manifest["screens"] = [];
  for (const s of rawScreens.slice(0, LIMITS.screens) as Record<string, unknown>[]) {
    const key = str(s?.key, 200) || routeKey(s?.route); if (!key || seen.has(key)) continue; seen.add(key);
    const els = (Array.isArray(s.elements) ? s.elements : []).slice(0, LIMITS.elementsPerScreen) as Record<string, unknown>[];
    const elements = els.map((e) => ({ kind: pick(e?.kind, ELEMENT_KINDS, "button"), label: str(e?.label, 160), target: str(e?.target, 200), destructive: e?.destructive === true,
      handler: e?.handler === false ? false : undefined })).filter((e) => e.label || e.target);
    if (total + elements.length > LIMITS.elements) { warnings.push("Elements past 30,000 left out"); elements.length = Math.max(0, LIMITS.elements - total); }
    total += elements.length;
    const meta = s.meta && typeof s.meta === "object" && !Array.isArray(s.meta) ? Object.fromEntries(Object.entries(s.meta as Record<string, unknown>).slice(0, 12).map(([k, v]) => [str(k, 40), typeof v === "number" || typeof v === "boolean" ? v : str(v, 300)])) : {};
    screens.push({ key, route: routeKey(s.route ?? key) || "", title: str(s.title, 160), purpose: text(s.purpose, 1000), area: str(s.area, 80), access: list(s.access, 30, 80), elements, meta });
  }
  const keys = screens.map((s) => s.key);
  const resolveKey = (k: unknown) => { const v = str(k, 200); return v === "*" ? "*" : keys.includes(v) ? v : screenFor(v, keys); };
  const edges: Manifest["edges"] = [];
  for (const e of (Array.isArray(m.edges) ? m.edges : []).slice(0, LIMITS.edges) as Record<string, unknown>[]) {
    const from = resolveKey(e?.from), to = resolveKey(e?.to);
    if (!from || !to || from === to || to === "*") continue;
    edges.push({ from, to, kind: pick(e?.kind, ["link", "nav", "redirect"] as const, "link"), label: str(e?.label, 160) });
  }
  const features = (Array.isArray(m.features) ? m.features : []).slice(0, LIMITS.features).map((f: Record<string, unknown>) => ({ key: slug(f?.key ?? f?.name), name: str(f?.name ?? f?.key, 120),
    description: text(f?.description, 1000), screens: list(f?.screens, 200, 200).map((k) => resolveKey(k)).filter((k): k is string => !!k && k !== "*") })).filter((f) => f.key && f.name);
  const personas = (Array.isArray(m.personas) ? m.personas : []).slice(0, LIMITS.personas).map((p) => personaFields(p)).filter((p) => p.key && p.name);
  const journeys = (Array.isArray(m.journeys) ? m.journeys : []).slice(0, LIMITS.journeys).map((j) => journeyFields(j, keys)).filter((j) => j.title && j.steps?.length);
  const entries = list(m.entries, 20, 200).map((k) => resolveKey(k)).filter((k): k is string => !!k && k !== "*");
  return { manifest: { app: { name: str(app.name, 120), baseUrl: /^https?:\/\/\S+$/.test(str(app.baseUrl, 300)) ? str(app.baseUrl, 300) : "", kind: str(app.kind, 40) }, roles, entries, screens, edges, features, personas, journeys }, warnings };
}

export function personaFields(x: unknown): MPersona {
  const p = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
  const ev = (Array.isArray(p.evidence) ? p.evidence : []).slice(0, 20).map((e: Record<string, unknown>) => ({ kind: pick(e?.kind, ["screen", "element", "telemetry", "code", "role", "note"] as const, "note"), ref: str(e?.ref, 200), text: str(e?.text, 300) })).filter((e) => e.ref || e.text);
  return { key: slug(p.key ?? p.name), name: str(p.name, 120), role: str(p.role, 80), description: text(p.description, 1000), goals: list(p.goals, 12, 200), ageGroup: str(p.ageGroup, 40),
    skillLevel: pick(p.skillLevel, SKILL, ""), techComfort: pick(p.techComfort, COMFORT, ""), frequency: pick(p.frequency, FREQUENCY, ""), device: pick(p.device, DEVICE, ""),
    permissions: list(p.permissions, 300, 200), features: list(p.features, 100, 80), evidence: ev, confidence: conf(p.confidence), origin: pick(p.origin, ["scan", "auto", "ai", "manual"] as const, "manual") };
}
export function stepsOf(x: unknown, keys?: readonly string[]): Step[] {
  return (Array.isArray(x) ? x : []).slice(0, LIMITS.steps).map((s: Record<string, unknown>) => {
    const raw = str(s?.screen, 200); const screen = keys && raw && !keys.includes(raw) ? screenFor(raw, keys) ?? raw : raw;
    return { screen, action: str(s?.action, 200), element: str(s?.element, 160), expected: str(s?.expected, 300), proposed: s?.proposed === true || undefined, note: str(s?.note, 300) || undefined };
  }).filter((s) => s.screen || s.action);
}
export function journeyFields(x: unknown, keys?: readonly string[]): Partial<MJourney> {
  const j = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
  const title = str(j.title, 160);
  return { key: slug(j.key ?? title, 120), personaKey: slug(j.personaKey ?? j.persona, 80), title, goal: text(j.goal, 1000), status: pick(j.status, JOURNEY_STATUS, "drafted"), steps: stepsOf(j.steps, keys),
    acceptance: list(j.acceptance, 30, 300), priority: pick(j.priority, PRIORITY, "") };
}

// ---------------------------------------------------------------------------------------------------- telemetry use
export type UseEvent = { session: string | null; person: string | null; role: string | null; device: string | null; at: number; kind: string; page: string | null; ms: number | null; status: number | null };

/** Real use from telemetry rows (nav.load and nav.route for screens, error.* for failures, api for slow calls), with
 *  page templates read as screens among `keys`. Paths are the sequences of screens people really walked (three to five
 *  screens, at least `minSessions` sessions), the longest kept when a shorter one is only part of it. */
export function mineUsage(events: UseEvent[], keys: readonly string[], { minSessions = 3, days = 30 } = {}): Usage {
  const screenOf = new Map<string, string | null>();
  const sOf = (page: string | null) => { if (!page) return null; if (!screenOf.has(page)) screenOf.set(page, screenFor(page, keys)); return screenOf.get(page)!; };
  const screens: Record<string, ScreenUse> = {};
  const loads: Record<string, number[]> = {}, apis: Record<string, number[]> = {};
  const people: Record<string, Set<string>> = {}, sessionsOn: Record<string, Set<string>> = {};
  const bySession = new Map<string, { at: number; screen: string }[]>();
  const sessionRole = new Map<string, string>(), sessionPerson = new Map<string, string>();
  const roles: Usage["roles"] = {};
  const roleSets: Record<string, { people: Set<string>; sessions: Set<string>; phone: number; desktop: number; days: Set<string> }> = {};
  for (const e of events) {
    const s = sOf(e.page);
    if (e.session && e.role) sessionRole.set(e.session, e.role);
    if (e.session && e.person) sessionPerson.set(e.session, e.person);
    if (e.role) {
      const r = roleSets[e.role] ??= { people: new Set(), sessions: new Set(), phone: 0, desktop: 0, days: new Set() };
      if (e.person) r.people.add(e.person); if (e.session) r.sessions.add(e.session);
      if (e.kind === "nav.load") { if (e.device === "phone") r.phone++; else r.desktop++; }
      r.days.add(new Date(e.at).toISOString().slice(0, 10));
    }
    if (!s) continue;
    const u = screens[s] ??= { views: 0, people: 0, sessions: 0, p75Ms: null, errors: 0, slowApiMs: null };
    if (e.kind === "nav.load" || e.kind === "nav.route") {
      u.views++; (people[s] ??= new Set()).add(e.person ?? ""); if (e.session) { (sessionsOn[s] ??= new Set()).add(e.session); const seq = bySession.get(e.session) ?? []; seq.push({ at: e.at, screen: s }); bySession.set(e.session, seq); }
      if (e.kind === "nav.load" && e.ms !== null && e.ms >= 0) (loads[s] ??= []).push(e.ms);
    } else if (e.kind.startsWith("error.")) u.errors++;
    else if (e.kind === "api" && e.ms !== null) (apis[s] ??= []).push(e.ms);
  }
  for (const [k, u] of Object.entries(screens)) { u.people = (people[k]?.size ?? 0) - (people[k]?.has("") ? 1 : 0); u.sessions = sessionsOn[k]?.size ?? 0; u.p75Ms = percentile(loads[k] ?? [], 0.75); u.slowApiMs = percentile(apis[k] ?? [], 0.75); }
  for (const [k, r] of Object.entries(roleSets)) roles[k] = { people: r.people.size, sessions: r.sessions.size, phone: r.phone, desktop: r.desktop, activeDays: r.days.size, days };
  const trans = new Map<string, { from: string; to: string; count: number; gaps: number[] }>();
  const grams = new Map<string, { steps: string[]; sessions: Set<string>; people: Set<string>; roles: Map<string, number>; gaps: number[] }>();
  for (const [sid, raw] of bySession) {
    const seq = raw.sort((a, b) => a.at - b.at).filter((x, i, a) => i === 0 || a[i - 1].screen !== x.screen).slice(0, 60);
    for (let i = 1; i < seq.length; i++) {
      const k = `${seq[i - 1].screen}→${seq[i].screen}`; const t = trans.get(k) ?? { from: seq[i - 1].screen, to: seq[i].screen, count: 0, gaps: [] as number[] };
      t.count++; const gap = seq[i].at - seq[i - 1].at; if (gap >= 0 && gap < 3600000) t.gaps.push(gap); trans.set(k, t);
    }
    const done = new Set<string>();
    for (let n = 3; n <= 5; n++) for (let i = 0; i + n <= seq.length; i++) {
      const steps = seq.slice(i, i + n).map((x) => x.screen); if (new Set(steps).size < n) continue;
      const k = steps.join("→"); if (done.has(k)) continue; done.add(k);
      const g = grams.get(k) ?? { steps, sessions: new Set<string>(), people: new Set<string>(), roles: new Map<string, number>(), gaps: [] as number[] };
      g.sessions.add(sid); const p = sessionPerson.get(sid); if (p) g.people.add(p); const r = sessionRole.get(sid) ?? ""; g.roles.set(r, (g.roles.get(r) ?? 0) + 1);
      const span = seq[i + n - 1].at - seq[i].at; if (span >= 0 && span < 3600000) g.gaps.push(span); grams.set(k, g);
    }
  }
  let paths = [...grams.values()].filter((g) => g.sessions.size >= minSessions)
    .map((g) => ({ steps: g.steps, sessions: g.sessions.size, people: g.people.size, role: [...g.roles.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "", medianMs: percentile(g.gaps, 0.5) }));
  paths = paths.filter((p) => !paths.some((q) => q !== p && q.steps.length > p.steps.length && q.sessions >= p.sessions && q.steps.join("→").includes(p.steps.join("→"))));
  paths.sort((a, b) => b.sessions * b.steps.length - a.sessions * a.steps.length);
  return { screens, transitions: [...trans.values()].map((t) => ({ from: t.from, to: t.to, count: t.count, medianMs: percentile(t.gaps, 0.5) })).sort((a, b) => b.count - a.count).slice(0, 2000),
    paths: paths.slice(0, 60), roles, days, sessions: bySession.size };
}

// ------------------------------------------------------------------------------------------------------- analysis
const live = (m: MapData) => m.screens.filter((s) => s.status !== "removed");
/** A screen's title, with its address when another screen has the same title ("Clients (/clients/:id)"). */
const titleOf = (m: MapData, k: string) => { const t = m.screens.find((s) => s.key === k)?.title; if (!t) return k; return m.screens.some((s) => s.key !== k && s.title === t && s.status !== "removed") ? `${t} (${k})` : t; };
const reachEdges = (m: MapData) => m.edges.filter((e) => e.kind !== "proposed");
/** Screens anyone can get to: the entries, the shared navigation's targets and everything linked from them. */
export function reachable(m: MapData): Set<string> {
  const keys = new Set(live(m).map((s) => s.key));
  const out = new Map<string, string[]>();
  for (const e of reachEdges(m)) { const l = out.get(e.from) ?? []; l.push(e.to); out.set(e.from, l); }
  const start = [...new Set([...m.entries, ...(out.get("*") ?? []), ...(keys.has("/") ? ["/"] : [])])].filter((k) => keys.has(k));
  const seen = new Set(start); const queue = [...start];
  while (queue.length) { const k = queue.shift()!; for (const n of out.get(k) ?? []) if (!seen.has(n) && keys.has(n)) { seen.add(n); queue.push(n); } }
  return seen;
}
function shortestPath(m: MapData, from: string, to: string, allowed?: Set<string>): string[] | null {
  if (from === to) return [from];
  const out = new Map<string, string[]>();
  for (const e of reachEdges(m)) if (e.from !== "*") { const l = out.get(e.from) ?? []; l.push(e.to); out.set(e.from, l); }
  const navTargets = new Set(m.edges.filter((e) => e.from === "*").map((e) => e.to));
  const prev = new Map<string, string>([[from, ""]]); const queue = [from];
  while (queue.length) {
    const k = queue.shift()!;
    for (const n of [...(out.get(k) ?? []), ...navTargets]) {
      if (prev.has(n) || (allowed && !allowed.has(n))) continue;
      prev.set(n, k); if (n === to) { const path = [n]; let p = k; while (p) { path.unshift(p); p = prev.get(p)!; } return path; }
      queue.push(n);
    }
  }
  return null;
}
const canOpen = (s: MScreen | undefined, role: string) => !s || !s.access.length || s.access.includes(role) || s.access.includes("all");

/** Issues the map shows, each with its evidence and how sure Pulse is. */
export function analyse(m: MapData): MIssue[] {
  const issues: MIssue[] = [];
  const add = (i: Omit<MIssue, "journeyKey" | "screenKey"> & { screenKey?: string; journeyKey?: string }) => { if (issues.length < 600 && !issues.some((x) => x.fingerprint === i.fingerprint)) issues.push({ screenKey: "", journeyKey: "", ...i }); };
  const screens = live(m).filter((s) => !s.proposed);
  const keys = live(m).map((s) => s.key);
  const byKey = new Map(live(m).map((s) => [s.key, s]));
  const reach = reachable(m);
  const hasNav = m.edges.some((e) => e.from === "*");
  const outOf = (k: string) => m.edges.filter((e) => e.from === k && e.kind !== "proposed");
  const inTo = (k: string) => m.edges.filter((e) => e.to === k && e.kind !== "proposed");
  const use = m.usage?.screens ?? {};
  for (const s of screens) {
    const els = m.elements.filter((e) => e.screen === s.key && !e.proposed);
    const outside = OUTSIDE_ENTRY.test(s.key);
    if (!reach.has(s.key) && !outside && !m.entries.includes(s.key)) {
      const seen = use[s.key]?.views ?? 0;
      if (seen > 0) add({ fingerprint: `missing_link:in:${s.key}`, kind: "missing_link", severity: "low", title: `People open ${titleOf(m, s.key)}, but no link to it was found`,
        detail: `${seen} visits in telemetry, yet no screen or menu links here: people type the address, use a bookmark or a link the scan could not read.`, screenKey: s.key,
        evidence: [{ kind: "telemetry", ref: s.key, text: `${seen} views by ${use[s.key]?.people ?? 0} people` }, { kind: "screen", ref: s.key, text: "no inbound link or menu entry" }], confidence: 0.6 });
      else add({ fingerprint: `orphan:${s.key}`, kind: "orphan", severity: inTo(s.key).length ? "low" : "medium", title: `${titleOf(m, s.key)} cannot be reached`,
        detail: inTo(s.key).length ? `Only ${inTo(s.key).map((e) => titleOf(m, e.from)).join(", ")} link here, and nothing links to them.` : "No menu entry, link or redirect leads here. Link it from where people need it, or remove it.",
        screenKey: s.key, evidence: [{ kind: "screen", ref: s.key, text: `${inTo(s.key).length} inbound links` }], confidence: m.usage ? 0.75 : 0.6 });
    }
    const moves = outOf(s.key);
    if (!moves.length && !outside && !s.proposed) {
      const doable = els.filter((e) => ["button", "form", "tab", "link", "menu"].includes(e.kind));
      if (!hasNav && !doable.length) add({ fingerprint: `dead_end:${s.key}`, kind: "dead_end", severity: "medium", title: `${titleOf(m, s.key)} is a dead end`, detail: "Nothing on this screen leads anywhere, and the app has no shared menu.", screenKey: s.key,
        evidence: [{ kind: "screen", ref: s.key, text: "no outbound links, buttons or menu" }], confidence: 0.6 });
      else if (!els.length && !inTo(s.key).every((e) => e.kind === "redirect")) add({ fingerprint: `dead_end:empty:${s.key}`, kind: "dead_end", severity: "low", title: `${titleOf(m, s.key)} has nothing to do`,
        detail: "The scan found no buttons, links, tabs or fields of its own: only the shared menu leads on. It may be a redirect or draw everything from shared parts.", screenKey: s.key,
        evidence: [{ kind: "screen", ref: s.key, text: "0 elements of its own" }], confidence: 0.45 });
    }
    for (const e of els) {
      if (e.target.startsWith("/") && !e.target.startsWith("/api/") && !screenFor(e.target, keys)) add({ fingerprint: `no_op:broken:${s.key}:${e.target}`, kind: "no_op", severity: "high", title: `“${e.label || e.target}” on ${titleOf(m, s.key)} goes to a page that does not exist`,
        detail: `The link points at ${e.target}; no screen has that address.`, screenKey: s.key, evidence: [{ kind: "element", ref: `${s.key}#${e.label}`, text: `target ${e.target}` }], confidence: 0.7 });
      if (e.kind === "button" && e.handler === false) add({ fingerprint: `no_op:${s.key}:${e.label}`, kind: "no_op", severity: "medium", title: `“${e.label}” on ${titleOf(m, s.key)} may do nothing`,
        detail: "The button has no click handler and does not submit a form in the code that draws it.", screenKey: s.key, evidence: [{ kind: "code", ref: `${s.key}#${e.label}`, text: "no onClick, no type=submit" }], confidence: 0.5 });
      const t = e.target.startsWith("/") ? byKey.get(screenFor(e.target, keys) ?? "") : undefined;
      if (t && s.access.length && t.access.length) {
        const shut = s.access.filter((r) => !t.access.includes(r) && r !== "all");
        if (shut.length && !t.access.includes("all")) add({ fingerprint: `permission:${s.key}:${t.key}`, kind: "permission", severity: "low", title: `${titleOf(m, s.key)} shows a link to ${titleOf(m, t.key)} that some cannot open`,
          detail: `${shut.join(", ")} see “${e.label || t.title}” but may not open ${titleOf(m, t.key)}. Hide the link for them or open the screen to them.`, screenKey: s.key,
          evidence: [{ kind: "role", ref: s.key, text: `open to ${s.access.join(", ")}` }, { kind: "role", ref: t.key, text: `open to ${t.access.join(", ")}` }], confidence: 0.6 });
      }
    }
    const u = use[s.key];
    if (u?.p75Ms && u.p75Ms > 2500 && u.views >= 5) add({ fingerprint: `slow:${s.key}`, kind: "slow", severity: u.p75Ms > 5000 ? "high" : "medium", title: `${titleOf(m, s.key)} is slow to show`,
      detail: `Three in four visits painted within ${(u.p75Ms / 1000).toFixed(1)} s (${u.views} visits); aim for under 2.5 s.`, screenKey: s.key,
      evidence: [{ kind: "telemetry", ref: s.key, text: `p75 ${u.p75Ms} ms over ${u.views} loads` }], confidence: 0.85 });
    if (u?.errors && u.errors >= 2) add({ fingerprint: `error:${s.key}`, kind: "error", severity: u.errors >= 10 ? "high" : "medium", title: `${titleOf(m, s.key)} shows errors`,
      detail: `${u.errors} script errors or failed loads were recorded here.`, screenKey: s.key, evidence: [{ kind: "telemetry", ref: s.key, text: `${u.errors} errors` }], confidence: 0.8 });
  }
  // Steps of a journey with no way between them (the menu counts as a way, but a weaker one).
  const navTargets = new Set(m.edges.filter((e) => e.from === "*").map((e) => e.to));
  for (const j of m.journeys) {
    const persona = m.personas.find((p) => p.key === j.personaKey);
    j.steps.forEach((st, i) => {
      const s = byKey.get(st.screen);
      if (persona?.role && s && !canOpen(s, persona.role)) add({ fingerprint: `permission:journey:${j.key}:${st.screen}`, kind: "permission", severity: "high", title: `${persona.name} cannot open ${titleOf(m, s.key)} in “${j.title}”`,
        detail: `Step ${i + 1} needs ${titleOf(m, s.key)}, open only to ${s.access.join(", ")}.`, screenKey: s.key, journeyKey: j.key, evidence: [{ kind: "role", ref: s.key, text: `open to ${s.access.join(", ")}` }], confidence: 0.8 });
      if (i === 0) return;
      const a = j.steps[i - 1].screen, b = st.screen;
      if (!a || !b || a === b || !byKey.has(a) || !byKey.has(b)) return;
      if (m.edges.some((e) => e.from === a && e.to === b && e.kind !== "proposed")) return;
      // Pulse's own proposals walk through the menu on purpose; only people's journeys are held to a direct link.
      if (navTargets.has(b) && (j.origin === "auto" || j.origin === "telemetry" || j.status === "auto" || j.status === "discovered")) return;
      add({ fingerprint: `missing_link:journey:${j.key}:${a}:${b}`, kind: "missing_link", severity: navTargets.has(b) ? "low" : "medium", journeyKey: j.key, screenKey: a,
        title: `No link from ${titleOf(m, a)} to ${titleOf(m, b)}`, detail: `Step ${i} → ${i + 1} of “${j.title}”: ${navTargets.has(b) ? "people must go through the menu" : "people must find their own way (the menu does not lead there either)"}.`,
        evidence: [{ kind: "screen", ref: a, text: `no link to ${b}` }], confidence: 0.7 });
    });
  }
  // People often go from A to B with no direct link.
  for (const t of m.usage?.transitions ?? []) {
    if (t.count < 5 || !byKey.has(t.from) || !byKey.has(t.to) || OUTSIDE_ENTRY.test(t.to)) continue;
    if (m.edges.some((e) => e.from === t.from && e.to === t.to && e.kind !== "usage" && e.kind !== "proposed")) continue;
    add({ fingerprint: `missing_link:use:${t.from}:${t.to}`, kind: "missing_link", severity: "low", screenKey: t.from, title: `People often go from ${titleOf(m, t.from)} to ${titleOf(m, t.to)} without a direct link`,
      detail: `${t.count} times in telemetry${t.medianMs ? `, about ${Math.round(t.medianMs / 1000)} s apart` : ""}. A link or action here would save a step.`,
      evidence: [{ kind: "telemetry", ref: `${t.from}→${t.to}`, text: `${t.count} moves` }], confidence: 0.65 });
  }
  return issues.slice(0, 600);
}

// ----------------------------------------------------------------------------------------- user types and journeys
/** Features from the screens' areas, when the map has none of its own. */
export function autoFeatures(m: MapData): MFeature[] {
  const groups = new Map<string, string[]>();
  for (const s of live(m)) { if (OUTSIDE_ENTRY.test(s.key) || s.proposed) continue; const a = s.area || "Other"; groups.set(a, [...(groups.get(a) ?? []), s.key]); }
  return [...groups.entries()].filter(([, ks]) => ks.length).map(([area, ks]) => ({ key: slug(area) || "other", name: area, description: "", screens: ks.slice(0, 200), proposed: false, origin: "auto" }));
}

/** One user type per role the app has (what it may open, the features it needs, how and how often it really uses the
 *  app). Age group and skill level need a person or the AI pass: they stay empty here. */
export function autoPersonas(m: MapData): MPersona[] {
  const screens = live(m).filter((s) => !s.proposed);
  const roleKeys = m.roles.length ? m.roles.map((r) => r.key) : [...new Set(screens.flatMap((s) => s.access))].filter((r) => r !== "all");
  const make = (role: string, name: string, description: string): MPersona => {
    const permissions = screens.filter((s) => canOpen(s, role)).map((s) => s.key);
    const allowed = new Set(permissions);
    const features = m.features.filter((f) => f.screens.length && f.screens.filter((k) => allowed.has(k)).length / f.screens.length >= 0.5).map((f) => f.key);
    const u = m.usage?.roles?.[role];
    const evidence: Evidence[] = [{ kind: "role", ref: role, text: `${permissions.length} of ${screens.length} screens open to this role` }];
    let frequency = "", device = "";
    if (u && u.people) {
      const perPerson = u.sessions / Math.max(1, u.people) / Math.max(1, u.days) * 7;
      frequency = perPerson >= 4 ? "daily" : perPerson >= 1 ? "weekly" : perPerson >= 0.25 ? "monthly" : "rarely";
      const phone = u.phone / Math.max(1, u.phone + u.desktop); device = phone >= 0.7 ? "phone" : phone <= 0.3 ? "desktop" : "both";
      evidence.push({ kind: "telemetry", ref: role, text: `${u.people} people, ${u.sessions} sessions in ${u.days} days; ${Math.round(phone * 100)}% on phones` });
    }
    const top = Object.entries(m.usage?.screens ?? {}).filter(([k]) => allowed.has(k)).sort((a, b) => b[1].views - a[1].views).slice(0, 3).map(([k]) => titleOf(m, k));
    if (top.length && u?.people) evidence.push({ kind: "telemetry", ref: role, text: `most used: ${top.join(", ")}` });
    return { key: slug(role) || "user", name, role, description, goals: [], ageGroup: "", skillLevel: "", techComfort: "", frequency, device, permissions: permissions.length === screens.length ? [] : permissions,
      features, evidence, confidence: u?.people ? 0.8 : 0.6, origin: "auto" };
  };
  if (!roleKeys.length) return [make("", "Signed-in user", "Everyone who signs in: the app does not tell its users apart.")];
  return roleKeys.slice(0, LIMITS.personas).map((r) => { const role = m.roles.find((x) => x.key === r); return make(r, role?.name || r.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()), role?.description ?? ""); });
}

const MAIN_ACTION = /^(new|add|create|start|save|send|invite|upload|book|connect|publish|submit|apply|request|plan|run)\b/i;
/** Journeys Pulse proposes: the paths people really walk (from telemetry, "discovered") and, per user type, the way
 *  from its home to each feature it needs and the feature's main action ("auto"). */
export function autoJourneys(m: MapData, personas: MPersona[] = m.personas): MJourney[] {
  const out: MJourney[] = [];
  const byRole = new Map(personas.filter((p) => p.role).map((p) => [p.role, p]));
  const firstAction = (k: string) => m.elements.find((e) => e.screen === k && !e.proposed && !e.destructive && (e.kind === "button" || e.kind === "form") && MAIN_ACTION.test(e.label));
  for (const p of (m.usage?.paths ?? []).slice(0, 40)) {
    const persona = byRole.get(p.role) ?? (personas.length === 1 ? personas[0] : undefined);
    const steps = p.steps.map((k, i) => { const e = i ? m.edges.find((x) => x.from === p.steps[i - 1] && x.to === k && x.label && x.kind !== "usage") : undefined;
      return { screen: k, action: i ? (e ? `Opens “${e.label}”` : "Goes on") : "Opens", element: e?.label ?? "", expected: `${titleOf(m, k)} shows` }; });
    out.push({ key: `seen-${hash(p.steps.join(">")).slice(0, 12)}`, personaKey: persona?.key ?? "", title: `${titleOf(m, p.steps[0])} → ${titleOf(m, p.steps.at(-1)!)}`,
      goal: `A path people really take (${p.sessions} sessions${p.people ? `, ${p.people} people` : ""}).`, status: "discovered", steps, confidence: Math.min(0.95, 0.5 + p.sessions / 40),
      evidence: [{ kind: "telemetry", ref: p.steps.join(" → "), text: `${p.sessions} sessions, median ${p.medianMs ? Math.round(p.medianMs / 1000) : "?"} s` }],
      usage: { sessions: p.sessions, people: p.people, medianMs: p.medianMs }, origin: "telemetry", priority: "", acceptance: [] });
  }
  const views = (k: string) => m.usage?.screens?.[k]?.views ?? 0;
  for (const persona of personas) {
    const allowed = persona.permissions.length ? new Set(persona.permissions) : new Set(live(m).map((s) => s.key));
    const homes = [...m.entries, ...m.edges.filter((e) => e.from === "*").map((e) => e.to)].filter((k) => allowed.has(k) && !OUTSIDE_ENTRY.test(k));
    const home = homes.sort((a, b) => views(b) - views(a))[0] ?? m.entries[0];
    if (!home) continue;
    const feats = m.features.filter((f) => !f.proposed && (persona.features.length ? persona.features.includes(f.key) : true))
      .map((f) => ({ f, score: f.screens.reduce((n, k) => n + views(k), 0) + f.screens.length })).sort((a, b) => b.score - a.score).slice(0, 8);
    for (const { f } of feats) {
      const main = f.screens.filter((k) => allowed.has(k)).sort((a, b) => views(b) - views(a) || a.length - b.length)[0];
      if (!main || main === home) continue;
      const path = shortestPath(m, home, main, allowed); if (!path) continue;
      const steps: Step[] = path.map((k, i) => { const e = i ? m.edges.find((x) => x.from === path[i - 1] && x.to === k && x.kind !== "usage") ?? m.edges.find((x) => x.from === "*" && x.to === k) : undefined;
        return { screen: k, action: i ? `Opens “${e?.label || titleOf(m, k)}”${e?.from === "*" ? " from the menu" : ""}` : `Starts on ${titleOf(m, k)}`, element: e?.label ?? "", expected: `${titleOf(m, k)} shows` }; });
      const act = firstAction(main);
      if (act) steps.push({ screen: main, action: `Uses “${act.label}”`, element: act.label, expected: `${act.label} is done and Pulse confirms it` });
      out.push({ key: `auto-${persona.key || "user"}-${f.key}`.slice(0, 120), personaKey: persona.key, title: `${persona.name}: ${f.name}`, goal: `${persona.name} gets to ${f.name}${act ? ` and uses “${act.label}”` : ""}.`,
        status: "auto", steps, confidence: 0.5, evidence: [{ kind: "screen", ref: path.join(" → "), text: "shortest way in the map" }, ...(act ? [{ kind: "element" as const, ref: `${main}#${act.label}`, text: "main action" }] : [])],
        usage: {}, origin: "auto", priority: "", acceptance: [] });
    }
  }
  return out.slice(0, LIMITS.journeys);
}

// ------------------------------------------------------------------------------------------------- plan and export
export type Spec = { schema: "pulse-product-plan/1"; product: string; version: { label: string; title: string } | null; generatedAt: string;
  personas: { key: string; name: string; role: string; ageGroup: string; skillLevel: string; techComfort: string; goals: string[] }[];
  journeys: { key: string; title: string; persona: string; status: string; priority: string; goal: string; steps: (Step & { title: string; route: string; proposed: boolean })[]; acceptance: string[] }[];
  screens: { key: string; route: string; title: string; purpose: string; proposed: boolean; access: string[]; elements: { kind: string; label: string; target: string; proposed: boolean }[] }[];
  ideas: { title: string; body: string; kind: string; priority: string; status: string; screens: string[]; votes: number }[];
  issues: { kind: string; severity: string; title: string; detail: string; screen: string }[] };
export type IdeaLite = { title: string; body: string; kind: string; priority: string; status: string; screens: string[]; votes: number; journeyKey?: string; targetVersionId?: string | null };
export type IssueLite = { kind: string; severity: string; title: string; detail: string; screenKey: string; journeyKey: string; status: string };

/** The default acceptance criteria of a journey: each step's expected outcome, phrased to check. */
export const acceptanceOf = (j: Pick<MJourney, "steps" | "acceptance">, title: (k: string) => string) => j.acceptance.length ? j.acceptance
  : j.steps.filter((s) => s.expected || s.action).map((s) => `On ${title(s.screen)}${s.action ? `, when the user ${s.action.charAt(0).toLowerCase()}${s.action.slice(1)}` : ""}: ${s.expected || "it works"}.`);

/** The plan for the build team and AI agents: the chosen journeys (planned ones by default), every screen they touch
 *  with its elements (proposed ones marked), the ideas and the open issues on those screens. */
export function planSpec(m: MapData, opts: { journeys: MJourney[]; ideas: IdeaLite[]; issues: IssueLite[]; version: { label: string; title: string } | null; now?: Date }): Spec {
  const title = (k: string) => titleOf(m, k);
  const touched = new Set(opts.journeys.flatMap((j) => j.steps.map((s) => s.screen)).concat(opts.ideas.flatMap((i) => i.screens)));
  const screens = m.screens.filter((s) => touched.has(s.key)).map((s) => ({ key: s.key, route: s.route, title: s.title, purpose: s.purpose, proposed: s.proposed, access: s.access,
    elements: m.elements.filter((e) => e.screen === s.key).slice(0, 80).map((e) => ({ kind: e.kind, label: e.label, target: e.target, proposed: e.proposed })) }));
  const personaKeys = new Set(opts.journeys.map((j) => j.personaKey));
  return { schema: "pulse-product-plan/1", product: m.name, version: opts.version, generatedAt: (opts.now ?? new Date()).toISOString(),
    personas: m.personas.filter((p) => personaKeys.has(p.key)).map((p) => ({ key: p.key, name: p.name, role: p.role, ageGroup: p.ageGroup, skillLevel: p.skillLevel, techComfort: p.techComfort, goals: p.goals })),
    journeys: opts.journeys.map((j) => ({ key: j.key, title: j.title, persona: m.personas.find((p) => p.key === j.personaKey)?.name ?? "", status: j.status, priority: j.priority, goal: j.goal,
      steps: j.steps.map((s) => { const sc = m.screens.find((x) => x.key === s.screen); return { ...s, title: sc?.title || s.screen, route: sc?.route ?? "", proposed: !!s.proposed || !!sc?.proposed }; }),
      acceptance: acceptanceOf(j, title) })),
    screens, ideas: opts.ideas.map((i) => ({ title: i.title, body: i.body, kind: i.kind, priority: i.priority, status: i.status, screens: i.screens, votes: i.votes })),
    issues: opts.issues.filter((i) => i.status === "open" || i.status === "accepted").filter((i) => !i.screenKey || touched.has(i.screenKey) || opts.journeys.some((j) => j.key === i.journeyKey))
      .map((i) => ({ kind: i.kind, severity: i.severity, title: i.title, detail: i.detail, screen: i.screenKey })) };
}

const md = (s: string) => s.replace(/([\\`*_[\]|])/g, "\\$1");
/** The same plan as Markdown, for people and for agents that read text. */
export function specMarkdown(s: Spec): string {
  const L: string[] = [`# ${md(s.product)}: ${s.version ? `plan for ${md(s.version.label)}${s.version.title ? ` (${md(s.version.title)})` : ""}` : "product plan"}`, "", `Generated by Pulse Product map, ${s.generatedAt.slice(0, 10)}. Schema ${s.schema}.`, ""];
  if (s.personas.length) { L.push("## User types", ""); for (const p of s.personas) L.push(`- **${md(p.name)}**${p.role ? ` (role \`${p.role}\`)` : ""}${[p.ageGroup && `age ${p.ageGroup}`, p.skillLevel && `${p.skillLevel} skill`, p.techComfort && `${p.techComfort} tech comfort`].filter(Boolean).length ? `: ${[p.ageGroup && `age ${p.ageGroup}`, p.skillLevel && `${p.skillLevel} skill`, p.techComfort && `${p.techComfort} tech comfort`].filter(Boolean).join(", ")}` : ""}${p.goals.length ? `. Goals: ${p.goals.map(md).join("; ")}` : ""}`); L.push(""); }
  if (s.journeys.length) {
    L.push("## Journeys", "");
    for (const j of s.journeys) {
      L.push(`### ${md(j.title)}`, "", `${j.persona ? `For **${md(j.persona)}**. ` : ""}Status ${j.status}${j.priority ? `, priority ${j.priority}` : ""}.${j.goal ? ` ${md(j.goal)}` : ""}`, "");
      j.steps.forEach((st, i) => L.push(`${i + 1}. **${md(st.title)}**${st.route ? ` \`${st.route}\`` : ""}${st.proposed ? " _(proposed, to build)_" : ""}: ${md(st.action || "open")}${st.expected ? ` → ${md(st.expected)}` : ""}${st.note ? ` (${md(st.note)})` : ""}`));
      if (j.acceptance.length) { L.push("", "Acceptance criteria:", ""); for (const a of j.acceptance) L.push(`- [ ] ${md(a)}`); }
      L.push("");
    }
  }
  const proposed = s.screens.filter((x) => x.proposed || x.elements.some((e) => e.proposed));
  if (proposed.length) { L.push("## To build", ""); for (const x of proposed) { L.push(`- **${md(x.title || x.key)}** \`${x.route || x.key}\`${x.proposed ? " (new screen)" : ""}${x.purpose ? `: ${md(x.purpose)}` : ""}`); for (const e of x.elements.filter((y) => y.proposed || x.proposed)) L.push(`  - ${e.kind} “${md(e.label)}”${e.target ? ` → \`${e.target}\`` : ""}`); } L.push(""); }
  if (s.screens.length) { L.push("## Screens involved", "", "| Screen | Route | Open to | Elements |", "|---|---|---|---|"); for (const x of s.screens) L.push(`| ${md(x.title || x.key)}${x.proposed ? " (proposed)" : ""} | \`${x.route || x.key}\` | ${x.access.join(", ") || "everyone signed in"} | ${x.elements.length} |`); L.push(""); }
  if (s.ideas.length) { L.push("## Ideas", ""); for (const i of s.ideas) L.push(`- **${md(i.title)}** (${i.kind}, ${i.priority}, ${i.status}, ${i.votes} votes)${i.body ? `: ${md(i.body.slice(0, 400))}` : ""}`); L.push(""); }
  if (s.issues.length) { L.push("## Open issues on these screens", ""); for (const i of s.issues) L.push(`- [${i.severity}] ${md(i.title)}${i.detail ? `: ${md(i.detail)}` : ""}`); L.push(""); }
  return L.join("\n");
}

// --------------------------------------------------------------------------------------------------------- AI pass
export const AI_MAX_CHARS = 48000; // about 12,000 tokens of map
/** The map, summarised for a model: screens with their access and a few element labels, features, roles, the paths
 *  people walk, and the user types already known. Never code. Bounded to `max` characters. */
export function aiBrief(m: MapData, max = AI_MAX_CHARS): string {
  const L: string[] = [`PRODUCT: ${m.name}`, `ROLES: ${m.roles.map((r) => `${r.key} (${r.name}${r.description ? `: ${r.description}` : ""})`).join("; ") || "none declared"}`, `ENTRIES: ${m.entries.join(", ")}`];
  if (m.features.length) L.push("FEATURES:", ...m.features.slice(0, 80).map((f) => `- ${f.key}: ${f.name} [${f.screens.slice(0, 12).join(", ")}${f.screens.length > 12 ? ", …" : ""}]`));
  const use = m.usage?.screens ?? {};
  const scr = live(m).filter((s) => !s.proposed).sort((a, b) => (use[b.key]?.views ?? 0) - (use[a.key]?.views ?? 0));
  L.push("SCREENS (key | title | open to | views | buttons and tabs):");
  for (const s of scr) {
    const els = m.elements.filter((e) => e.screen === s.key && ["button", "tab", "form", "link"].includes(e.kind) && e.label).map((e) => `${e.kind === "tab" ? "#" : ""}${e.label}`);
    L.push(`- ${s.key} | ${s.title} | ${s.access.join(",") || "all"} | ${use[s.key]?.views ?? 0} | ${[...new Set(els)].slice(0, 8).join("; ")}`);
    if (L.join("\n").length > max * 0.75) { L.push(`- … ${scr.length - scr.indexOf(s) - 1} more screens`); break; }
  }
  if (m.usage?.paths.length) L.push("PATHS PEOPLE WALK (sessions, role):", ...m.usage.paths.slice(0, 25).map((p) => `- ${p.steps.join(" > ")} (${p.sessions}, ${p.role || "?"})`));
  if (m.usage?.roles && Object.keys(m.usage.roles).length) L.push(`USE BY ROLE: ${Object.entries(m.usage.roles).map(([r, u]) => `${r}: ${u.people} people, ${u.sessions} sessions, ${Math.round(u.phone / Math.max(1, u.phone + u.desktop) * 100)}% phone`).join("; ")}`);
  if (m.personas.length) L.push("KNOWN USER TYPES:", ...m.personas.map((p) => `- ${p.key}: ${p.name} (role ${p.role || "?"})`));
  return L.join("\n").slice(0, max);
}
export const AI_INSTRUCTIONS = `You are a product analyst. From the product map below, answer with ONE JSON object and nothing else:
{"personas":[{"key","name","role","description","goals":[..],"ageGroup":"e.g. 25-40","skillLevel":"beginner|intermediate|expert","techComfort":"low|medium|high","frequency":"daily|weekly|monthly|rarely","device":"phone|desktop|both","features":[feature keys],"evidence":[{"kind":"screen|telemetry|role","ref":"screen key or role","text":"why"}],"confidence":0..1}],
 "journeys":[{"title","personaKey","goal","steps":[{"screen":"screen key","action":"what the user does","expected":"what they see"}],"evidence":[...],"confidence":0..1}],
 "issues":[{"kind":"dead_end|orphan|no_op|missing_link|permission|slow|other","severity":"high|medium|low","title","detail","screenKey","evidence":[...],"confidence":0..1}],
 "ideas":[{"title","body","kind":"screen|feature|journey|change","screens":[screen keys],"personaKey","priority":"now|next|later"}]}
Rules: always estimate ageGroup as a range and skillLevel and techComfort from the role and context (never "Unknown"; lower the confidence instead); one persona per real kind of user (use the roles; split a role only when the evidence shows two kinds); 2 to 5 key journeys per persona using ONLY screen keys from the map; every claim cites evidence from the map (screen keys, roles, telemetry); say confidence honestly; at most 6 issues and 6 ideas, the most useful first; plain words. Keep it compact so it is never cut off: at most 3 journeys per persona and 6 steps each, at most 2 evidence items per claim, every text under 25 words.`;

/** The model's answer checked against the map: unknown screens and features are dropped, numbers clamped, sizes
 *  bounded. What is left is stored as "ai" claims with their evidence. */
export function aiApply(raw: unknown, m: MapData): { personas: MPersona[]; journeys: MJourney[]; issues: MIssue[]; ideas: { title: string; body: string; kind: string; screens: string[]; personaKey: string; priority: string }[]; dropped: number } {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const keys = live(m).map((s) => s.key); const feats = new Set(m.features.map((f) => f.key)); let dropped = 0;
  const personas = (Array.isArray(r.personas) ? r.personas : []).slice(0, 12).map((p) => ({ ...personaFields(p), origin: "ai", permissions: [] as string[] }))
    .map((p) => ({ ...p, features: p.features.filter((f) => feats.has(f)), key: p.key ? `ai-${p.key}`.slice(0, 80) : "" })).filter((p) => p.key && p.name);
  const pkeys = new Set([...personas.map((p) => p.key), ...m.personas.map((p) => p.key)]);
  const journeys: MJourney[] = [];
  for (const j of (Array.isArray(r.journeys) ? r.journeys : []).slice(0, 40)) {
    const f = journeyFields(j, keys); const steps = (f.steps ?? []).filter((s) => keys.includes(s.screen));
    if (steps.length < 2 || !f.title) { dropped++; continue; }
    const pk = f.personaKey && pkeys.has(`ai-${f.personaKey}`) ? `ai-${f.personaKey}` : f.personaKey && pkeys.has(f.personaKey) ? f.personaKey : "";
    const jj = j as Record<string, unknown>;
    journeys.push({ key: `ai-${hash(`${pk}|${f.title}`).slice(0, 12)}`, personaKey: pk, title: f.title, goal: f.goal ?? "", status: "auto", steps, origin: "ai", priority: "", acceptance: [], usage: {},
      evidence: personaFields({ evidence: jj.evidence }).evidence, confidence: conf(jj.confidence) ?? 0.5 });
  }
  const issues: MIssue[] = (Array.isArray(r.issues) ? r.issues : []).slice(0, 12).map((x: Record<string, unknown>) => {
    const screenKey = keys.includes(str(x?.screenKey, 200)) ? str(x?.screenKey, 200) : ""; const title = str(x?.title, 200);
    return { fingerprint: `ai:${hash(`${title}|${screenKey}`).slice(0, 16)}`, kind: pick(x?.kind, ISSUE_KINDS, "other"), severity: pick(x?.severity, ["high", "medium", "low"] as const, "low"), title, detail: text(x?.detail, 2000),
      screenKey, journeyKey: "", evidence: personaFields({ evidence: x?.evidence }).evidence, confidence: conf(x?.confidence) ?? 0.4 };
  }).filter((i) => i.title.length >= 4);
  const ideas = (Array.isArray(r.ideas) ? r.ideas : []).slice(0, 12).map((x: Record<string, unknown>) => ({ title: str(x?.title, 200), body: text(x?.body, 4000), kind: pick(x?.kind, ["screen", "feature", "journey", "change", "fix"] as const, "change"),
    screens: list(x?.screens, 20, 200).filter((k) => keys.includes(k)), personaKey: slug(x?.personaKey, 80), priority: pick(x?.priority, ["now", "next", "later"] as const, "next") })).filter((i) => i.title.length >= 2);
  return { personas, journeys, issues, ideas, dropped };
}
