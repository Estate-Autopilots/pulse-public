// BUGKIT-TELEMETRY (owner, 6 Nov 2026): the pure half of session replay and the organisation's usage settings. A replay
// chunk is rrweb events recorded on the device (apps/web/app/lib/replay.ts) with every typed value masked there; the API
// checks it again before storing it: a chunk whose input events or form fields carry readable text is refused, so a
// device that forgot to mask can never store what someone typed. Nothing here touches the database (migration 1682).
import { gunzipSync } from "node:zlib";
import { pathTemplate } from "./telemetry-model.js";

export type TelemetrySettings = {
  enabled: boolean; replay: boolean; retentionDays: number; sample: number; replaySample: number; prompts: boolean; autoTask: boolean; bugProjectId: string | null;
};
/** No saved row: everything on (the owner's default), replays and usage kept 30 days, every session recorded. */
export const SETTING_DEFAULTS: TelemetrySettings = { enabled: true, replay: true, retentionDays: 30, sample: 1, replaySample: 1, prompts: true, autoTask: false, bugProjectId: null };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION = /^[A-Za-z0-9_-]{8,64}$/;
export const REPLAY_MAX_GZ = 3 * 1024 * 1024;
const REPLAY_MAX_JSON = 32 * 1024 * 1024;
const MAX_AGE_MS = 3 * 24 * 3600 * 1000;

/** An admin's change to the settings, merged over the current ones; throws a plain message on a bad value. */
export function mergeSettings(current: TelemetrySettings, body: unknown): TelemetrySettings {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const out = { ...current };
  for (const k of ["enabled", "replay", "prompts", "autoTask"] as const) {
    if (k in b) { if (typeof b[k] !== "boolean") throw new Error(`Choose on or off for ${k}`); out[k] = b[k] as boolean; }
  }
  if ("retentionDays" in b) {
    const d = Number(b.retentionDays);
    if (!Number.isInteger(d) || d < 7 || d > 365) throw new Error("Keep usage between 7 and 365 days");
    out.retentionDays = d;
  }
  for (const k of ["sample", "replaySample"] as const) {
    if (k in b) {
      const s = Number(b[k]);
      if (!Number.isFinite(s) || s < 0 || s > 1) throw new Error("Choose a share between 0 and 100%");
      out[k] = Math.round(s * 1000) / 1000;
    }
  }
  if ("bugProjectId" in b) {
    const p = b.bugProjectId;
    if (p === null || p === "") out.bugProjectId = null;
    else if (typeof p === "string" && UUID.test(p)) out.bugProjectId = p;
    else throw new Error("Choose a project for bug tasks");
  }
  return out;
}

/** What a device needs to start (any signed-in person): never the retention or the project. */
export const clientSettings = (s: TelemetrySettings) => ({ enabled: s.enabled, replay: s.enabled && s.replay, sample: s.sample, replaySample: s.replaySample, prompts: s.prompts });

type RrwebNode = { type?: number; tagName?: string; attributes?: Record<string, unknown>; childNodes?: RrwebNode[]; textContent?: string };
const MASKED = (s: unknown) => typeof s !== "string" || /^[*\s]*$/.test(s);
const FIELD = new Set(["input", "textarea", "select"]);

/** Any readable typed text in rrweb events: an input event (source 5) whose text is not all "*", or a form field in a
 *  snapshot or added node whose value (or a textarea's text) is not masked. Returns the first problem, or null. */
export function unmaskedText(events: unknown[]): string | null {
  const seen = { n: 0 };
  const walk = (node: RrwebNode | undefined, inField = false): string | null => {
    if (!node || typeof node !== "object" || ++seen.n > 400_000) return null;
    const tag = typeof node.tagName === "string" ? node.tagName.toLowerCase() : "";
    if (FIELD.has(tag)) {
      const type = String(node.attributes?.type ?? "").toLowerCase();
      if (!["checkbox", "radio", "submit", "button", "hidden", "reset", "image", "file", "color", "range"].includes(type) && !MASKED(node.attributes?.value)) return `${tag} value`;
    }
    if (inField && node.type === 3 && !MASKED(node.textContent)) return "textarea text";
    for (const child of Array.isArray(node.childNodes) ? node.childNodes : []) { const bad = walk(child, inField || tag === "textarea"); if (bad) return bad; }
    return null;
  };
  for (const raw of events) {
    const e = raw as { type?: number; data?: Record<string, unknown> };
    if (!e || typeof e !== "object") continue;
    if (e.type === 2) { const bad = walk(e.data?.node as RrwebNode); if (bad) return bad; }
    if (e.type === 3 && e.data) {
      const d = e.data as { source?: number; text?: unknown; adds?: { node?: RrwebNode }[]; attributes?: { attributes?: Record<string, unknown> }[] };
      if (d.source === 5 && !MASKED(d.text)) return "input event";
      if (d.source === 0) {
        for (const add of Array.isArray(d.adds) ? d.adds : []) { const bad = walk(add?.node); if (bad) return bad; }
        for (const a of Array.isArray(d.attributes) ? d.attributes : []) if (a?.attributes && "value" in a.attributes && !MASKED(a.attributes.value)) return "value attribute";
      }
    }
  }
  return null;
}

export type ReplayChunk = { sid: string; seq: number; route: string | null; from: Date; to: Date; events: number; reason: "sample" | "report"; data: Buffer };

/** A device's replay chunk: {sid, seq, route, from, to, n, reason, gz: base64 gzip of the events JSON}. Throws a plain
 *  message when it is not one, is too large, or carries unmasked typed text. */
export function parseReplayChunk(body: unknown, now = Date.now()): ReplayChunk {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  if (typeof b.sid !== "string" || !SESSION.test(b.sid)) throw new Error("Send a session");
  const seq = Number(b.seq);
  if (!Number.isInteger(seq) || seq < 0 || seq > 100_000) throw new Error("Send a chunk number");
  const from = Number(b.from), to = Number(b.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from || now - from > MAX_AGE_MS || from > now + 60_000) throw new Error("Send the chunk's times");
  if (typeof b.gz !== "string" || !b.gz || b.gz.length > Math.ceil(REPLAY_MAX_GZ * 4 / 3) + 4) throw new Error("The chunk is too large");
  const data = Buffer.from(b.gz, "base64");
  if (data.length < 18 || data[0] !== 0x1f || data[1] !== 0x8b) throw new Error("Send a compressed chunk");
  let events: unknown;
  try { events = JSON.parse(gunzipSync(data, { maxOutputLength: REPLAY_MAX_JSON }).toString("utf8")); } catch { throw new Error("The chunk could not be read"); }
  if (!Array.isArray(events) || !events.length) throw new Error("The chunk has no events");
  const bad = unmaskedText(events);
  if (bad) throw new Error(`The chunk carries typed text (${bad}); it was not stored`);
  return { sid: b.sid, seq, route: pathTemplate(b.route), from: new Date(from), to: new Date(Math.max(from, Math.min(to, now))), events: events.length,
    reason: b.reason === "report" ? "report" : "sample", data };
}
