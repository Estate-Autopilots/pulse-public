// BUGKIT-TELEMETRY (owner, 6 Nov 2026): session replay upload and the organisation's usage settings (migration 1682).
//   POST /api/v0/telemetry/replay     a device's replay chunk (gzip rrweb events, masked on the device and checked again
//                                     here: replay-model.ts); stored in the person's company only when usage recording and
//                                     replay are on there (a chunk attached to a bug report needs usage recording on)
//   GET  /api/v0/telemetry/settings   what a device needs to start (anyone signed in); admins also get retention, the
//                                     automatic bug tasks and the bug project, with the projects to choose from
//   POST /api/v0/telemetry/settings   admins: usage recording and replay on/off, retention, sampling, the soft prompts,
//                                     friction alerts opening bug tasks, the project bug tasks go to
// NO-DATA-LOSS-5 (owner, 20 Nov 2026, 18:15 UTC; 2497): both also carry the company's privacy contact, the e-mail the
// approved notices mean by "ask your company's privacy contact" (everyone reads it; an admin sets it, empty = the
// owner's or an admin's e-mail).
// Reading replays, the friction dashboard and the heatmaps are friction.ts.
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { fail, type Tx, type Viewer } from "./routes.js";
import { clientSettings, mergeSettings, parseReplayChunk, privacyContactInput, REPLAY_MAX_GZ, SETTING_DEFAULTS, type TelemetrySettings } from "./replay-model.js";

/** The company's settings (the defaults when it never saved any). */
export async function settingsOf(c: PoolClient): Promise<TelemetrySettings> {
  const r = (await c.query(`select enabled, replay, retention_days "retentionDays", sample::float8 sample, replay_sample::float8 "replaySample", prompts,
      auto_task "autoTask", bug_project_id "bugProjectId", replay_days "replayDays", replay_budget_mb "replayBudgetMb" from pulse.telemetry_setting where org_id = pulse.current_org()`)).rows[0];
  return r ? { ...SETTING_DEFAULTS, ...r } : { ...SETTING_DEFAULTS };
}

/** NO-DATA-LOSS-5 (2497): who people ask to have their data erased; chosen = an admin typed it (else the default). */
async function privacyContactOf(c: PoolClient): Promise<{ email: string | null; chosen: boolean }> {
  return (await c.query("select pulse.privacy_contact_of_org() p")).rows[0].p;
}

const admin = (v: Viewer) => v.role === "admin";
const PER_MINUTE = 30;

export function registerReplayRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  app.post("/api/v0/telemetry/replay", { bodyLimit: Math.ceil(REPLAY_MAX_GZ * 4 / 3) + 4096, config: { keepsCache: true } }, (request) => tx(request, async (c, v) => {
    if (!v.person) fail(403, "Replay needs your own Pulse sign-in");
    let chunk;
    try { chunk = parseReplayChunk(request.body); } catch (error) { fail(400, (error as Error).message); }
    const s = await settingsOf(c);
    if (!s.enabled || (chunk!.reason !== "report" && !s.replay)) return { accepted: false };
    const recent = (await c.query("select count(*)::int n from pulse.telemetry_replay where person_id = $1 and created_at > now() - interval '1 minute'", [v.person])).rows[0].n as number;
    if (recent >= PER_MINUTE) fail(429, "Too many replay chunks; Pulse sends them again shortly");
    // DOREVE-2 (decision 3, 2300): the company's oldest chunks make room first; over the server's hard cap nothing new is
    // stored (a bug report's chunk still is) and the device stops sending.
    const room = (await c.query("select pulse.telemetry_replay_room($1, $2) r", [chunk!.data.length, chunk!.reason])).rows[0].r as { fits: boolean };
    if (!room.fits) return { accepted: false, full: true };
    const r = await c.query(`insert into pulse.telemetry_replay (org_id, session_id, seq, person_id, route, started_at, ended_at, events, reason, bytes, data)
      values (pulse.current_org(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10) on conflict (org_id, session_id, seq) do nothing`,
      [chunk!.sid, chunk!.seq, v.person, chunk!.route, chunk!.from, chunk!.to, chunk!.events, chunk!.reason, chunk!.data.length, chunk!.data]);
    return { accepted: true, stored: r.rowCount === 1 };
  }));

  app.get("/api/v0/telemetry/settings", (request) => tx(request, async (c, v) => {
    const s = await settingsOf(c);
    const contact = await privacyContactOf(c);
    if (!admin(v)) return { ...clientSettings(s), privacyContact: contact.email };
    const projects = (await c.query("select id, name from pulse.project order by name limit 300")).rows;
    return { ...clientSettings(s), ...s, projects, privacyContact: contact.email, privacyContactChosen: contact.chosen, canChange: true };
  }));

  app.post("/api/v0/telemetry/settings", { schema: { body: { type: "object", maxProperties: 12 } } }, (request) => tx(request, async (c, v) => {
    if (!admin(v)) fail(403, "Only an admin can change what Pulse records");
    const body = (request.body && typeof request.body === "object" ? request.body : {}) as Record<string, unknown>;
    const { privacyContact, ...change } = body;
    if ("privacyContact" in body) {
      let email: string | null = null;
      try { email = privacyContactInput(privacyContact); } catch (error) { fail(400, (error as Error).message); }
      await c.query(`insert into pulse.privacy_contact (org_id, email, updated_by, updated_at) values (pulse.current_org(), $1, $2, now())
        on conflict (org_id) do update set email = excluded.email, updated_by = excluded.updated_by, updated_at = now()`, [email, v.person]);
      if (!Object.keys(change).length) {   // only the contact changed: the usage settings stay as they are (no row written)
        const s = await settingsOf(c), contact = await privacyContactOf(c);
        return { ...clientSettings(s), ...s, privacyContact: contact.email, privacyContactChosen: contact.chosen, canChange: true };
      }
    }
    let next: TelemetrySettings;
    try { next = mergeSettings(await settingsOf(c), change); } catch (error) { fail(400, (error as Error).message); }
    if (next!.bugProjectId && !(await c.query("select 1 from pulse.project where id = $1", [next!.bugProjectId])).rowCount) fail(400, "Choose one of your projects");
    await c.query(`insert into pulse.telemetry_setting (org_id, enabled, replay, retention_days, sample, replay_sample, prompts, auto_task, bug_project_id, replay_days, replay_budget_mb, updated_by, updated_at)
      values (pulse.current_org(), $1, $2, $3, $4, $5, $6, $7, $8, $10, $11, $9, now())
      on conflict (org_id) do update set enabled = excluded.enabled, replay = excluded.replay, retention_days = excluded.retention_days, sample = excluded.sample,
        replay_sample = excluded.replay_sample, prompts = excluded.prompts, auto_task = excluded.auto_task, bug_project_id = excluded.bug_project_id,
        replay_days = excluded.replay_days, replay_budget_mb = excluded.replay_budget_mb, updated_by = excluded.updated_by, updated_at = now()`,
      [next!.enabled, next!.replay, next!.retentionDays, next!.sample, next!.replaySample, next!.prompts, next!.autoTask, next!.bugProjectId, v.person, next!.replayDays, next!.replayBudgetMb]);
    const contact = await privacyContactOf(c);
    return { ...clientSettings(next!), ...next!, privacyContact: contact.email, privacyContactChosen: contact.chosen, canChange: true };
  }));
}
