// R45: useful text captured from approved Drive roots (collectors/gdrive_extract). pulse.drive_text decides every read
// in the database: a content approval in force, the viewer's current roles against its audience, and the root's and
// the file's current state in the R44 feed (a file gone from Drive, moved out of the root or a root that lost access
// is held). It hands over compressed payloads; this route decompresses them, stopping at the recorded length, and
// checks their SHA-256, so a damaged payload is reported and never returned as text. Admins see counts in Settings.
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import { fail, type Tx } from "./routes.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILE = /^[A-Za-z0-9_-]{1,160}$/;

export const driveTextOn = () => process.env.PULSE_DRIVE_EXTRACT === "1";

type PayloadMeta = { sha256: string; schema: string; codec: string; rawLength: number; storedLength: number };
type Meta = { state: string; reason: string | null; gaps?: string[]; provenance?: Record<string, unknown>; text?: PayloadMeta; facts?: PayloadMeta };

/** The exact bytes of one payload, or null when it does not decode to its recorded length and hash. */
export function decodePayload(meta: PayloadMeta, data: Buffer | null): Buffer | null {
  if (!data || meta.codec !== "zlib") return null;
  try {
    const raw = inflateSync(data, { maxOutputLength: Math.max(1, meta.rawLength) });
    if (raw.length !== meta.rawLength || createHash("sha256").update(raw).digest("hex") !== meta.sha256) return null;
    return raw;
  } catch { return null; }
}

export type DriveTextRoot = {
  id: string; label: string; tracked: boolean; approved: boolean; enabled: boolean; withdrawn: boolean;
  outcomes: Record<string, number>; reasons: Record<string, number>; held: number; errorCode: string | null; lastRunAt: string | null;
};

/** Each root's capture health for an admin: counts and codes only (pulse.drive_extract_status checks the role). */
export async function driveTextStatus(c: PoolClient): Promise<{ on: boolean; roots: DriveTextRoot[] }> {
  const d = (await c.query("select pulse.drive_extract_status() d")).rows[0].d as { roots: DriveTextRoot[] };
  return { on: driveTextOn(), roots: d.roots };
}

/** The Settings card: off and why, or what was captured and what needs someone. */
export function driveTextCard(s: { on: boolean; roots: DriveTextRoot[] }) {
  const live = s.roots.filter((x) => x.enabled && x.approved && !x.withdrawn && x.tracked);
  const base = { key: "drive-text", label: "Drive document text" };
  if (!s.on || !live.length) {
    return { ...base, state: "planned" as const, lastAt: null,
      detail: s.on ? "On, but no Drive root has an approved list of document types and readers yet (owner errands E08/E13)."
        : "Off. Once the owner approves which document types Pulse may read in an approved Drive root, and who may read them, Pulse keeps their text even if the file later leaves Drive. No OCR, chats or ID documents." };
  }
  const sum = (k: string) => live.reduce((n, x) => n + (x.outcomes[k] ?? 0), 0);
  const held = live.reduce((n, x) => n + x.held, 0), failed = sum("failed");
  const n = (v: number) => v.toLocaleString("en-IN");
  const parts = [`${n(sum("extracted"))} documents captured`];
  if (sum("quarantined")) parts.push(`${n(sum("quarantined"))} set aside (locked, too big or unsafe)`);
  if (sum("unsupported")) parts.push(`${n(sum("unsupported"))} not readable as text`);
  if (sum("excluded")) parts.push(`${n(sum("excluded"))} left out (chats, ID documents, restricted folders)`);
  const review = held + failed + live.filter((x) => x.errorCode).length;
  const last = live.map((x) => x.lastRunAt).filter((x): x is string => !!x).sort().pop() ?? null;
  return { ...base, state: review ? "attention" as const : "connected" as const, lastAt: last,
    detail: `${parts.join(", ")}.${held ? ` ${n(held)} held until someone reviews a change in Drive.` : ""}` };
}

export function registerDriveTextRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  app.get<{ Params: { source: string; file: string } }>("/api/v0/drive-text/:source/:file", req => tx(req, async (c) => {
    const { source, file } = req.params;
    if (!UUID.test(source) || !FILE.test(file)) fail(404, "Not found");
    const row = (await c.query("select meta,text_data,facts_data from pulse.drive_text($1,$2)", [source.toLowerCase(), file])).rows[0];
    if (!row) fail(404, "Not found");
    const meta = row.meta as Meta;
    if (meta.state !== "readable") return meta;
    const text = decodePayload(meta.text!, row.text_data), facts = decodePayload(meta.facts!, row.facts_data);
    if (!text || !facts) return { state: "corrupt", reason: "payload_check_failed", gaps: meta.gaps, provenance: meta.provenance };
    return { ...meta, text: { ...meta.text, body: text.toString("utf8") }, facts: { ...meta.facts, body: JSON.parse(facts.toString("utf8")) } };
  }));
}
