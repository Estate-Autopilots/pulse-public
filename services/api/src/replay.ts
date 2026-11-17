// BUGKIT-TELEMETRY (owner, 6 Nov 2026): session replay upload and the organisation's usage settings (migration 1682).
//   POST /api/v0/telemetry/replay     a device's replay chunk (gzip rrweb events, masked on the device and checked again
//                                     here: replay-model.ts); stored in the person's company only when usage recording and
//                                     replay are on there (a chunk attached to a bug report needs usage recording on)
//   GET  /api/v0/telemetry/settings   what a device needs to start (anyone signed in); admins also get retention, the
//                                     automatic bug tasks and the bug project, with the projects to choose from
//   POST /api/v0/telemetry/settings   admins: usage recording and replay on/off, retention, sampling, the soft prompts,
//                                     friction alerts opening bug tasks, the project bug tasks go to
// Reading replays, the friction dashboard and the heatmaps are friction.ts.
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { fail, type Tx, type Viewer } from "./routes.js";
import { clientSettings, mergeSettings, parseReplayChunk, REPLAY_MAX_GZ, SETTING_DEFAULTS, type TelemetrySettings } from "./replay-model.js";

/** The company's settings (the defaults when it never saved any). */
export async function settingsOf(c: PoolClient): Promise<TelemetrySettings> {
  const r = (await c.query(`select enabled, replay, retention_days "retentionDays", sample::float8 sample, replay_sample::float8 "replaySample", prompts,
      auto_task "autoTask", bug_project_id "bugProjectId" from pulse.telemetry_setting where org_id = pulse.current_org()`)).rows[0];
  return r ? { ...SETTING_DEFAULTS, ...r } : { ...SETTING_DEFAULTS };
}

const admin = (v: Viewer) => v.role === "admin";
const PER_MINUTE = 30;

export function registerReplayRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  app.post("/api/v0/telemetry/replay", { bodyLimit: Math.ceil(REPLAY_MAX_GZ * 4 / 3) + 4096, config: { keepsCache: true } }, (request) => tx(request, async (c, v) => {
    if (!v.person) fail(403, "Replay needs your own Pulse sign-in");
    let chunk;
    try { chunk = parseReplayChunk(request.body); } catch (error) { fail(400, (error as Error).message); }
    const s = await settingsOf(c);
    if (!s.enabled || (chunk!.reason === "sample" && !s.replay)) return { accepted: false };
    const recent = (await c.query("select count(*)::int n from pulse.telemetry_replay where person_id = $1 and created_at > now() - interval '1 minute'", [v.person])).rows[0].n as number;
    if (recent >= PER_MINUTE) fail(429, "Too many replay chunks; Pulse sends them again shortly");
    const r = await c.query(`insert into pulse.telemetry_replay (org_id, session_id, seq, person_id, route, started_at, ended_at, events, reason, bytes, data)
      values (pulse.current_org(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10) on conflict (org_id, session_id, seq) do nothing`,
      [chunk!.sid, chunk!.seq, v.person, chunk!.route, chunk!.from, chunk!.to, chunk!.events, chunk!.reason, chunk!.data.length, chunk!.data]);
    return { accepted: true, stored: r.rowCount === 1 };
  }));

  app.get("/api/v0/telemetry/settings", (request) => tx(request, async (c, v) => {
    const s = await settingsOf(c);
    if (!admin(v)) return clientSettings(s);
    const projects = (await c.query("select id, name from pulse.project order by name limit 300")).rows;
    return { ...clientSettings(s), ...s, projects, canChange: true };
  }));

  app.post("/api/v0/telemetry/settings", { schema: { body: { type: "object", maxProperties: 12 } } }, (request) => tx(request, async (c, v) => {
    if (!admin(v)) fail(403, "Only an admin can change what Pulse records");
    let next: TelemetrySettings;
    try { next = mergeSettings(await settingsOf(c), request.body); } catch (error) { fail(400, (error as Error).message); }
    if (next!.bugProjectId && !(await c.query("select 1 from pulse.project where id = $1", [next!.bugProjectId])).rowCount) fail(400, "Choose one of your projects");
    await c.query(`insert into pulse.telemetry_setting (org_id, enabled, replay, retention_days, sample, replay_sample, prompts, auto_task, bug_project_id, updated_by, updated_at)
      values (pulse.current_org(), $1, $2, $3, $4, $5, $6, $7, $8, $9, now())
      on conflict (org_id) do update set enabled = excluded.enabled, replay = excluded.replay, retention_days = excluded.retention_days, sample = excluded.sample,
        replay_sample = excluded.replay_sample, prompts = excluded.prompts, auto_task = excluded.auto_task, bug_project_id = excluded.bug_project_id,
        updated_by = excluded.updated_by, updated_at = now()`,
      [next!.enabled, next!.replay, next!.retentionDays, next!.sample, next!.replaySample, next!.prompts, next!.autoTask, next!.bugProjectId, v.person]);
    return { ...clientSettings(next!), ...next!, canChange: true };
  }));
}
