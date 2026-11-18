// R44: the direct Google Drive changes feed (collectors/gdrive_changes). Google's push notification for a channel only
// wakes the poller; its body is always empty and nothing from it is stored. The hook answers 404 unless
// PULSE_DRIVE_CHANGES=1, and also for any channel id/token pair that is not a live channel of this organisation, so it
// reveals nothing. Admins see each approved root's health in Settings → Connected sources.
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { createHash } from "node:crypto";
import { fail, type Open } from "./routes.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATES = new Set(["sync", "change", "add", "remove", "update", "trash", "untrash"]);
const header = (v: unknown) => (typeof v === "string" ? v : "");

export const driveChangesOn = () => process.env.PULSE_DRIVE_CHANGES === "1";

export type DriveChangesSource = {
  id: string; kind: "shared_drive" | "folder"; label: string; enabled: boolean; approved: boolean;
  status: "new" | "ok" | "catching_up" | "rate_limited" | "error" | "access_lost" | "cursor_invalid";
  errorCode: string | null; lagSeconds: number | null; lastCheckpointAt: string | null; caughtUpAt: string | null;
  channel: "active" | "expired" | "failed" | "none"; files: number; unavailable: number; deadLetters: number; openGaps: number;
};

/** Each root's health for an admin: counts, times and codes only (pulse.drive_changes_status checks the role). */
export async function driveChangesStatus(c: PoolClient): Promise<{ on: boolean; sources: DriveChangesSource[] }> {
  const d = (await c.query("select pulse.drive_changes_status() d")).rows[0].d as { sources: DriveChangesSource[] };
  return { on: driveChangesOn(), sources: d.sources };
}

/** The Settings card: off and why, or how many approved roots are current and which need someone. */
export function driveChangesCard(s: { on: boolean; sources: DriveChangesSource[] }) {
  const live = s.sources.filter((x) => x.enabled && x.approved);
  const base = { key: "drive-changes", label: "Google Drive changes" };
  if (!s.on || !live.length) {
    return { ...base, state: "planned" as const, lastAt: null,
      detail: s.on ? "On, but no Drive folder or shared drive is approved yet (owner errand E13)."
        : "Off. Once the owner approves Drive folders or shared drives, Pulse reads their changes straight from Drive within minutes." };
  }
  const review = live.filter((x) => ["access_lost", "cursor_invalid", "error"].includes(x.status) || x.openGaps > 0 || x.deadLetters > 0);
  const files = live.reduce((n, x) => n + x.files, 0), gone = live.reduce((n, x) => n + x.unavailable, 0);
  const last = live.map((x) => x.lastCheckpointAt).filter((x): x is string => !!x).sort().pop() ?? null;
  const roots = `${live.length} approved ${live.length === 1 ? "root" : "roots"}`;
  const health = review.length ? `${review.length} ${review.length === 1 ? "needs" : "need"} review` : "all up to date";
  return { ...base, state: review.length ? "attention" as const : "connected" as const, lastAt: last,
    detail: `${roots}, ${health}. ${files.toLocaleString("en-IN")} files tracked${gone ? `, ${gone.toLocaleString("en-IN")} no longer available in Drive (kept in Pulse)` : ""}.` };
}

export function registerDriveChangesRoutes(app: FastifyInstance, { open }: { open: Open }) {
  app.register(async (hook) => {
    // Notifications carry no body; ignore whatever content type arrives so a provider change never becomes a 400/415.
    hook.removeAllContentTypeParsers();
    hook.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: 4096 }, (_req, _raw, done) => done(null, null));
    hook.post("/api/v0/drive-changes/hook", async (req, reply) => {
      if (!driveChangesOn()) fail(404, "Not found");
      const channel = header(req.headers["x-goog-channel-id"]), token = header(req.headers["x-goog-channel-token"]);
      const state = header(req.headers["x-goog-resource-state"]);
      if (!UUID.test(channel) || token.length < 32 || token.length > 256 || !STATES.has(state)) fail(404, "Not found");
      const hash = createHash("sha256").update(token).digest("hex");
      const ok = await open(async (c) => (await c.query("select pulse.drive_changes_wake($1,$2,$3) ok", [channel.toLowerCase(), hash, state])).rows[0].ok);
      if (!ok) fail(404, "Not found");
      return reply.code(204).send();
    });
  });
}
