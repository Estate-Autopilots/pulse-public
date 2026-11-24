// KAZUK-REST slice 7 (6 Nov 2026, migration 1709): a company's own training courses, for its team and its dealers /
// channel partners (Learn → Training). Every read and write goes through pulse.training_* functions, which decide who
// may do what (managers: admins, leadership, HR; learners: the people a published course is assigned to).
//   GET  /api/v0/training                         the viewer's courses with their standing, and whether they manage
//   GET  /api/v0/training/courses                 every course with its counts (managers)
//   POST /api/v0/training/courses                 make a course {title, summary, passMark, status}
//   GET  /api/v0/training/courses/:id             one course (answers and assignments for managers only)
//   POST /api/v0/training/courses/:id             change it
//   GET  /api/v0/training/courses/:id/progress    who must take it and where each stands (managers)
//   POST /api/v0/training/courses/:id/videos      add a video: {title, url, minutes} or {title, name, mime, bytes (base64)}
//   POST /api/v0/training/courses/:id/quiz        replace the quiz {questions: [{prompt, options, answer}]}
//   POST /api/v0/training/courses/:id/assign      {kind: person|side|role, personId | target, dueOn}
//   POST /api/v0/training/courses/:id/attempt     answer the quiz {answers: [choice index per question]}
//   POST /api/v0/training/assignments/:id/remove  take an assignment back
//   POST /api/v0/training/videos/:id/remove       remove a video
//   POST /api/v0/training/videos/:id/seen         keep how much of a video the viewer watched {percent}
//   GET  /api/v0/training/videos/:id/file         an uploaded clip, with byte ranges so the player can seek
// Pure helpers are unit-tested (test/kazuk-rest-training.test.mjs).
import type { FastifyInstance } from "fastify";
import { fail, type Tx, type Viewer } from "./routes.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const id = (s: unknown, what = "Choose a course") => (typeof s === "string" && UUID.test(s) ? s : fail(400, what));
export const MAX_UPLOAD = 25 * 1024 * 1024;
const VIDEO_TYPES = new Set(["video/mp4", "video/webm", "video/quicktime"]);
const SIDES = new Set(["staff", "freelancer", "channel_partner", "vendor", "talent", "other"]);
const ROLES = new Set(["member", "pod_head", "hr", "leadership"]);
const clean = (s: unknown, max: number) => (typeof s === "string" ? s.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : "");
const body = (b: unknown) => (b && typeof b === "object" && !Array.isArray(b) ? b : {}) as Record<string, unknown>;

/** A video link: https only, a real host name (no address, no sign-in in the link, no local names), at most 500
 *  characters. The provider (YouTube, Vimeo, Google Drive, any other page) decides how the player shows it. */
export function videoLink(raw: unknown): { url: string; provider: "youtube" | "vimeo" | "drive" | "web" } {
  const text = typeof raw === "string" ? raw.trim() : "";
  let u: URL;
  try { u = new URL(text); } catch { return fail(400, "Paste the video's full link (https://…)"); }
  if (u.protocol !== "https:") fail(400, "Use a secure (https) video link");
  if (u.username || u.password) fail(400, "Use the video's share link, without a sign-in in it");
  const host = u.hostname.toLowerCase();
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) || /^\d+(\.\d+)+$/.test(host) || /(^|\.)(localhost|local|internal)$/.test(host)) fail(400, "Use a link to a public video page");
  if (u.port) fail(400, "Use a link to a public video page");
  const url = u.toString();
  if (url.length > 500 || /\s/.test(url)) fail(400, "This link is too long");
  const provider = /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/.test(host) ? "youtube" : /(^|\.)vimeo\.com$/.test(host) ? "vimeo"
    : host === "drive.google.com" ? "drive" : "web";
  return { url, provider };
}

/** A course's fields as typed: a title, an optional summary, a pass mark from 1 to 100 and a status. */
export function courseInput(raw: unknown) {
  const b = body(raw);
  const title = clean(b.title, 160);
  if (!title) fail(400, "Give the course a title");
  const summary = typeof b.summary === "string" ? b.summary.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").trim().slice(0, 2000) : "";
  const passMark = b.passMark == null || b.passMark === "" ? 70 : Number(b.passMark);
  if (!Number.isInteger(passMark) || passMark < 1 || passMark > 100) fail(400, "Choose a pass mark from 1 to 100");
  const status = b.status == null ? "draft" : String(b.status);
  if (!["draft", "published", "archived"].includes(status)) fail(400, "Choose draft, published or archived");
  return { title, summary, passMark, status };
}

/** The quiz as typed: up to 20 questions, each with 2 to 6 choices and the right one marked. */
export function quizInput(raw: unknown) {
  const list = body(raw).questions;
  if (!Array.isArray(list) || list.length > 20) fail(400, "A quiz has up to 20 questions");
  return (list as unknown[]).map((q, n) => {
    const x = body(q);
    const prompt = clean(x.prompt, 500);
    if (!prompt) fail(400, `Write question ${n + 1}`);
    const options = (Array.isArray(x.options) ? x.options : []).map((o) => clean(o, 200)).filter(Boolean);
    if (options.length < 2 || options.length > 6) fail(400, `Question ${n + 1} needs 2 to 6 choices`);
    const answer = Number(x.answer);
    if (!Number.isInteger(answer) || answer < 0 || answer >= options.length) fail(400, `Mark the right choice for question ${n + 1}`);
    return { prompt, options, answer };
  });
}

/** Who a course is assigned to: one person, a side of the company (channel partners, staff …) or a work role. */
export function assignInput(raw: unknown) {
  const b = body(raw);
  const kind = String(b.kind ?? "");
  const dueOn = b.dueOn == null || b.dueOn === "" ? null : String(b.dueOn);
  if (dueOn !== null && !(/^\d{4}-\d{2}-\d{2}$/.test(dueOn) && !Number.isNaN(Date.parse(`${dueOn}T00:00:00Z`)))) fail(400, "Choose a due day");
  if (kind === "person") return { kind, personId: id(b.personId, "Choose a person"), target: null, dueOn };
  const target = String(b.target ?? "");
  if (kind === "side" && SIDES.has(target)) return { kind, personId: null, target, dueOn };
  if (kind === "role" && ROLES.has(target)) return { kind, personId: null, target, dueOn };
  return fail(400, "Choose a person, a group or a role");
}

/** An uploaded clip: an mp4, webm or mov file up to 25 MB, sent as base64. */
export function uploadInput(raw: unknown) {
  const b = body(raw);
  const mime = String(b.mime ?? "");
  if (!VIDEO_TYPES.has(mime)) fail(400, "Upload an MP4, WebM or MOV video");
  const data = typeof b.bytes === "string" ? b.bytes : "";
  if (!data || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) fail(400, "Choose a video file");
  if (data.length > Math.ceil(MAX_UPLOAD / 3) * 4) fail(413, "Videos up to 25 MB can be uploaded; link a longer one");
  const bytes = Buffer.from(data, "base64");
  if (!bytes.length || bytes.length > MAX_UPLOAD) fail(413, "Videos up to 25 MB can be uploaded; link a longer one");
  const name = clean(b.name, 200).replace(/[/\\]/g, "_") || "video";
  return { mime, bytes, name };
}

/** The bytes to send for a Range header ("bytes=a-b"), or null for the whole file; "invalid" when it can't be met. */
export function byteRange(header: string | undefined, size: number): { start: number; end: number } | null | "invalid" {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header ?? "");
  if (!m || (!m[1] && !m[2])) return null;
  const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  return start > end || start >= size ? "invalid" : { start, end };
}

const signedIn = (v: Viewer) => { if (!v.person) fail(403, "Training belongs to a person in this company"); return v.person; };

export function registerTrainingRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  app.get("/api/v0/training", (req) => tx(req, async (c, v) => {
    signedIn(v);
    const r = (await c.query("select pulse.training_mine() mine, pulse.training_manager() manage")).rows[0];
    return { courses: r.mine, manage: r.manage };
  }));
  app.get("/api/v0/training/courses", (req) => tx(req, async (c, v) => {
    signedIn(v);
    return { courses: (await c.query("select pulse.training_courses() c")).rows[0].c };
  }));
  app.post<{ Body: unknown }>("/api/v0/training/courses", (req) => tx(req, async (c, v) => {
    signedIn(v);
    if (!(await c.query("select pulse.training_manager() m")).rows[0].m) fail(403, "Training courses are managed by admins, leadership and HR");
    const x = courseInput(req.body);
    return { id: (await c.query("select pulse.training_course_save(null,$1,$2,$3,$4) id", [x.title, x.summary, x.passMark, x.status])).rows[0].id };
  }));
  app.get<{ Params: { id: string } }>("/api/v0/training/courses/:id", (req) => tx(req, async (c, v) => {
    signedIn(v);
    return (await c.query("select pulse.training_course_get($1) c", [id(req.params.id)])).rows[0].c;
  }));
  app.post<{ Params: { id: string }; Body: unknown }>("/api/v0/training/courses/:id", (req) => tx(req, async (c, v) => {
    signedIn(v);
    if (!(await c.query("select pulse.training_manager() m")).rows[0].m) fail(403, "Training courses are managed by admins, leadership and HR");
    const x = courseInput(req.body);
    await c.query("select pulse.training_course_save($1,$2,$3,$4,$5)", [id(req.params.id), x.title, x.summary, x.passMark, x.status]);
    return { ok: true };
  }));
  app.get<{ Params: { id: string } }>("/api/v0/training/courses/:id/progress", (req) => tx(req, async (c, v) => {
    signedIn(v);
    return { people: (await c.query("select pulse.training_report($1) r", [id(req.params.id)])).rows[0].r };
  }));
  app.post<{ Params: { id: string }; Body: unknown }>("/api/v0/training/courses/:id/videos", { bodyLimit: 36_000_000 }, (req) => tx(req, async (c, v) => {
    signedIn(v);
    if (!(await c.query("select pulse.training_manager() m")).rows[0].m) fail(403, "Training courses are managed by admins, leadership and HR");
    const b = body(req.body), course = id(req.params.id), title = clean(b.title, 160);
    if (!title) fail(400, "Give the video a title");
    const minutes = b.minutes == null || b.minutes === "" ? null : Number(b.minutes);
    if (minutes !== null && (!Number.isInteger(minutes) || minutes < 1 || minutes > 600)) fail(400, "Give the length in minutes (1 to 600)");
    if (b.bytes != null) {
      const f = uploadInput(b);
      return { id: (await c.query("select pulse.training_video_add($1,$2,null,null,$3,$4,$5,$6) id", [course, title, minutes, f.name, f.mime, f.bytes])).rows[0].id };
    }
    const link = videoLink(b.url);
    return { id: (await c.query("select pulse.training_video_add($1,$2,$3,$4,$5) id", [course, title, link.url, link.provider, minutes])).rows[0].id };
  }));
  app.post<{ Params: { id: string }; Body: unknown }>("/api/v0/training/courses/:id/quiz", (req) => tx(req, async (c, v) => {
    signedIn(v);
    if (!(await c.query("select pulse.training_manager() m")).rows[0].m) fail(403, "Training courses are managed by admins, leadership and HR");
    const questions = quizInput(req.body);
    return { questions: (await c.query("select pulse.training_quiz_set($1,$2) n", [id(req.params.id), JSON.stringify(questions)])).rows[0].n };
  }));
  app.post<{ Params: { id: string }; Body: unknown }>("/api/v0/training/courses/:id/assign", (req) => tx(req, async (c, v) => {
    signedIn(v);
    if (!(await c.query("select pulse.training_manager() m")).rows[0].m) fail(403, "Training courses are managed by admins, leadership and HR");
    const a = assignInput(req.body);
    return { id: (await c.query("select pulse.training_assign($1,$2,$3,$4,$5) id", [id(req.params.id), a.kind, a.personId, a.target, a.dueOn])).rows[0].id };
  }));
  app.post<{ Params: { id: string }; Body: unknown }>("/api/v0/training/courses/:id/attempt", (req) => tx(req, async (c, v) => {
    signedIn(v);
    const answers = body(req.body).answers;
    if (!Array.isArray(answers) || answers.length > 20 || !answers.every((a) => Number.isInteger(a) && a >= 0 && a <= 5)) fail(400, "Answer every question");
    return (await c.query("select pulse.training_attempt($1,$2::int[]) r", [id(req.params.id), answers])).rows[0].r;
  }));
  app.post<{ Params: { id: string } }>("/api/v0/training/assignments/:id/remove", (req) => tx(req, async (c, v) => {
    signedIn(v);
    if (!(await c.query("select pulse.training_manager() m")).rows[0].m) fail(403, "Training courses are managed by admins, leadership and HR");
    await c.query("select pulse.training_unassign($1)", [id(req.params.id, "Choose an assignment")]);
    return { ok: true };
  }));
  app.post<{ Params: { id: string } }>("/api/v0/training/videos/:id/remove", (req) => tx(req, async (c, v) => {
    signedIn(v);
    if (!(await c.query("select pulse.training_manager() m")).rows[0].m) fail(403, "Training courses are managed by admins, leadership and HR");
    await c.query("select pulse.training_video_remove($1)", [id(req.params.id, "Choose a video")]);
    return { ok: true };
  }));
  app.post<{ Params: { id: string }; Body: unknown }>("/api/v0/training/videos/:id/seen", (req) => tx(req, async (c, v) => {
    signedIn(v);
    const percent = Number(body(req.body).percent);
    if (!Number.isInteger(percent) || percent < 0 || percent > 100) fail(400, "Give a share from 0 to 100");
    return (await c.query("select pulse.training_video_seen($1,$2) r", [id(req.params.id, "Choose a video"), percent])).rows[0].r;
  }));
  app.get<{ Params: { id: string } }>("/api/v0/training/videos/:id/file", async (req, reply) => {
    const f = await tx(req, async (c, v) => {
      signedIn(v);
      return (await c.query("select name,mime,size,bytes from pulse.training_video_file_read($1)", [id(req.params.id, "Choose a video")])).rows[0] as { name: string; mime: string; size: number; bytes: Buffer } | undefined;
    });
    if (!f) return fail(404, "Video not found");
    reply.header("cache-control", "private, max-age=3600").header("x-content-type-options", "nosniff").header("accept-ranges", "bytes")
      .header("content-security-policy", "sandbox").header("content-disposition", `inline; filename*=UTF-8''${encodeURIComponent(f.name)}`).type(f.mime);
    const r = byteRange(req.headers.range, f.bytes.length);
    if (r === "invalid") return reply.code(416).header("content-range", `bytes */${f.bytes.length}`).send();
    if (r) return reply.code(206).header("content-range", `bytes ${r.start}-${r.end}/${f.bytes.length}`).send(f.bytes.subarray(r.start, r.end + 1));
    return reply.send(f.bytes);
  });
}
