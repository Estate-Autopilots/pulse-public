// COMPANY-OPS (owner, 10 Nov 2026: "Backup to Google Drive … extremely important"): a company's Docs copied into a
// Google Drive folder, nightly and on demand (Settings → Connected apps → Backup to Google Drive, admins only).
//   * Pulse signs in to Drive as the install's Google service account. The owner sets its key on the server once
//     (PULSE_DRIVE_BACKUP_SA_JSON: the key file's JSON or base64; or PULSE_DRIVE_BACKUP_SA_FILE: a path). It is never
//     stored in the database or shown. The admin shares a folder in a shared drive with that account and pastes its link.
//   * Folders are mirrored; each doc goes as a PDF and a Word file (@pulse/invoice-doc doc-export); a doc's files and a
//     folder's files go next to them. A file already in Drive is updated in place; an unchanged doc is skipped.
//   * Nothing is ever deleted in Drive: an archived doc's last copy stays there.
//   * The backup reads Docs as the admin who turned it on (row security): it copies what that admin can open, no more.
//     A doc shared only with chosen people the admin is not one of is not copied.
//   * Nightly from 2 a.m. company time (PULSE_DRIVE_BACKUP_LOOP=0 turns the loop off); each run is in drive_backup_run.
import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { importPKCS8, SignJWT } from "jose";
import { FONT_URLS, renderDocDocx, renderDocPdf, safeFileName } from "@pulse/invoice-doc";
import { admin, fail, type Tx, type Viewer } from "./routes.js";
import { htmlToMarkdown } from "./docs.js";
import { orgZone, zoneDay } from "./org-time.js";
import { docPrint, driveWords, folderIdFrom, folderUrl, multipart, nightlyDue, parentsFirst, parseServiceAccount, type ServiceAccount } from "./drive-backup-model.js";

type Row = Record<string, unknown>;
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
const MAX_DOCS = 3000, MAX_FILES = 3000, MAX_PROBLEMS = 20;
const API = "https://www.googleapis.com/drive/v3/files", UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const FOLDER_MIME = "application/vnd.google-apps.folder";

/** The service account from the server's settings (read once; a missing or broken key means "not connected"). */
let account: ServiceAccount | null | undefined;
export function backupAccount(): ServiceAccount | null {
  if (account !== undefined) return account;
  const file = process.env.PULSE_DRIVE_BACKUP_SA_FILE;
  let text = process.env.PULSE_DRIVE_BACKUP_SA_JSON ?? "";
  if (!text && file) { try { text = readFileSync(file, "utf8"); } catch { text = ""; } }
  return (account = parseServiceAccount(text));
}
export const resetBackupAccount = () => { account = undefined; };

class DriveError extends Error { constructor(public status: number, public reason: string) { super(`drive ${status} ${reason}`); } }

/** A signed-in Drive client for the service account (a token lasts an hour; Google's own endpoints only). */
export function driveClient(sa: ServiceAccount, f: Fetch = fetch) {
  let token: { value: string; until: number } | null = null;
  const auth = async () => {
    if (token && token.until > Date.now() + 60_000) return token.value;
    const now = Math.floor(Date.now() / 1000);
    const assertion = await new SignJWT({ scope: "https://www.googleapis.com/auth/drive" }).setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer(sa.email).setAudience("https://oauth2.googleapis.com/token").setIssuedAt(now).setExpirationTime(now + 3600).sign(await importPKCS8(sa.key, "RS256"));
    const r = await f("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString() });
    const j = await r.json().catch(() => ({})) as { access_token?: string; expires_in?: number; error?: string };
    if (!r.ok || !j.access_token) throw new DriveError(401, j.error ?? "sign-in");
    token = { value: j.access_token, until: Date.now() + (j.expires_in ?? 3600) * 1000 };
    return token.value;
  };
  const call = async (method: string, url: string, body?: string | Uint8Array, type?: string): Promise<Row | null> => {
    // Bytes go as a Blob (a copy into a plain ArrayBuffer): fetch takes a Blob or a string as the body.
    const payload = body === undefined ? {} : { body: typeof body === "string" ? body : new Blob([new Uint8Array(body)]) };
    for (let attempt = 0; ; attempt++) {
      const r = await f(url, { method, headers: { authorization: `Bearer ${await auth()}`, ...(type ? { "content-type": type } : {}) }, ...payload });
      if (r.ok) return r.status === 204 ? null : await r.json() as Row;
      const j = await r.json().catch(() => ({})) as { error?: { errors?: { reason?: string }[]; message?: string } };
      const reason = j.error?.errors?.[0]?.reason ?? j.error?.message ?? "";
      if ((r.status === 429 || r.status >= 500 || reason === "userRateLimitExceeded" || reason === "rateLimitExceeded") && attempt < 3) { await new Promise((ok) => setTimeout(ok, 1000 * 2 ** attempt)); continue; }
      throw new DriveError(r.status, reason);
    }
  };
  const q = "supportsAllDrives=true&fields=id,name,parents,trashed";
  /** The file or folder if it is still there (not in the bin). */
  const find = async (id: string | null | undefined) => {
    if (!id) return null;
    try { const x = await call("GET", `${API}/${encodeURIComponent(id)}?${q}`) as { id: string; name: string; parents?: string[]; trashed?: boolean }; return x.trashed ? null : x; }
    catch (e) { if (e instanceof DriveError && e.status === 404) return null; throw e; }
  };
  /** Moves and renames a file or folder that is already there, when it needs it. */
  const place = async (x: { id: string; name: string; parents?: string[] }, name: string, parent: string, media?: { mime: string; bytes: Uint8Array }) => {
    const moves = x.parents?.includes(parent) ? "" : `&addParents=${encodeURIComponent(parent)}${x.parents?.length ? `&removeParents=${encodeURIComponent(x.parents.join(","))}` : ""}`;
    if (media) {
      const b = `pulse-${randomUUID()}`;
      return (await call("PATCH", `${UPLOAD}/${encodeURIComponent(x.id)}?uploadType=multipart&${q}${moves}`, multipart({ name }, media.mime, media.bytes, b), `multipart/related; boundary=${b}`))!.id as string;
    }
    if (!moves && x.name === name) return x.id;
    return (await call("PATCH", `${API}/${encodeURIComponent(x.id)}?${q}${moves}`, JSON.stringify({ name }), "application/json"))!.id as string;
  };
  return {
    /** Can the account see (and so write into) this folder? Its name, or a refusal in plain words. */
    async check(folderId: string) { const x = await find(folderId); if (!x) throw new DriveError(404, "notFound"); return x.name; },
    async folder(name: string, parent: string, known: string | null) {
      const x = await find(known);
      if (x) return place(x, name, parent);
      return (await call("POST", `${API}?${q}`, JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parent] }), "application/json"))!.id as string;
    },
    async file(name: string, mime: string, bytes: Uint8Array, parent: string, known: string | null) {
      const x = await find(known);
      if (x) return place(x, name, parent, { mime, bytes });
      const b = `pulse-${randomUUID()}`;
      return (await call("POST", `${UPLOAD}?uploadType=multipart&${q}`, multipart({ name, parents: [parent] }, mime, bytes, b), `multipart/related; boundary=${b}`))!.id as string;
    },
  };
}

let fonts: Promise<{ regular: Buffer; semibold: Buffer }> | null = null;
const fontBytes = () => (fonts ??= Promise.all([readFile(FONT_URLS.regular), readFile(FONT_URLS.semibold)]).then(([regular, semibold]) => ({ regular, semibold })));

/** One short transaction in the company, as a person (row security decides what they read and may write). */
async function inOrg<T>(pool: Pool, org: string, person: string | null, run: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("select set_config('pulse.org_id',$1,true), set_config('pulse.viewer_id',$2,true)", [org, person ?? ""]);
    const out = await run(c);
    await c.query("commit");
    return out;
  } catch (e) { await c.query("rollback").catch(() => {}); throw e; } finally { c.release(); }
}

const running = new Set<string>();
export type RunResult = { ok: boolean; counts: Record<string, number>; problems: string[]; error: string | null };

/** One backup of a company's Docs into its Drive folder, as the admin it runs as. Never throws: the answer says why. */
export async function runBackup(pool: Pool, org: string, reason: "nightly" | "on_demand", startedBy: string | null, f: Fetch = fetch): Promise<RunResult> {
  const sa = backupAccount();
  if (!sa) return { ok: false, counts: {}, problems: [], error: "Vitals OS is not connected to Google yet (the owner's one-time step)." };
  if (running.has(org)) return { ok: false, counts: {}, problems: [], error: "A backup is already running." };
  running.add(org);
  let runId: string | null = null, runAs: string | null = null;
  const counts = { folders: 0, docs: 0, docsSkipped: 0, files: 0, filesSkipped: 0, notCopied: 0 }, problems: string[] = [];
  const problem = (what: string, e: unknown) => { counts.notCopied++; if (problems.length < MAX_PROBLEMS) problems.push(`${what}: ${e instanceof DriveError ? driveWords(e.status, e.reason) : (e as Error).message?.slice(0, 160)}`); };
  try {
    // 1. What to copy, read as the admin (one short transaction).
    const setting = await inOrg(pool, org, null, async (c) => (await c.query("select enabled,folder_id,run_as from pulse.drive_backup_setting")).rows[0] as { enabled: boolean; folder_id: string | null; run_as: string | null } | undefined);
    if (!setting?.folder_id || !setting.run_as) return { ok: false, counts, problems, error: "Choose the Drive folder first." };
    runAs = setting.run_as;
    const snap = await inOrg(pool, org, runAs, async (c) => {
      if (!(await c.query("select pulse.viewer_is('admin') a")).rows[0].a) throw new Error("The admin who turned the backup on is no longer an admin here. Another admin turns it on again.");
      runId = (await c.query("insert into pulse.drive_backup_run(org_id,reason,started_by) values(pulse.current_org(),$1,$2) returning id", [reason, startedBy ?? runAs])).rows[0].id as string;
      const name = (await c.query("select name from pulse.org where id=pulse.current_org()")).rows[0]?.name as string;
      const zone = await orgZone(c);
      const folders = (await c.query(`select id,name,parent_id "parentId" from pulse.doc_folder where archived_at is null order by created_at limit 2000`)).rows as { id: string; name: string; parentId: string | null }[];
      const docs = (await c.query(`select id,title,folder_id "folderId",version,updated_at "updatedAt",body_html html from pulse.doc where archived_at is null order by updated_at desc limit ${MAX_DOCS}`)).rows as
        { id: string; title: string; folderId: string | null; version: number; updatedAt: string; html: string }[];
      const files = (await c.query(`select f.id,f.name,f.mime,f.sha256,f.folder_id "folderId",f.doc_id "docId" from pulse.doc_file f where f.archived_at is null order by f.added_at limit ${MAX_FILES}`)).rows as
        { id: string; name: string; mime: string; sha256: string; folderId: string | null; docId: string | null }[];
      const items = new Map((await c.query("select kind,ref_id::text ref,drive_id,fingerprint from pulse.drive_backup_item")).rows.map((r) => [`${r.kind}:${r.ref}`, r as { drive_id: string; fingerprint: string }]));
      return { name, zone, folders, docs, files, items };
    });
    const drive = driveClient(sa, f);
    const done: { kind: string; ref: string; drive: string; parent: string; print: string }[] = [];
    const known = (kind: string, ref: string) => snap.items.get(`${kind}:${ref}`) ?? null;
    // 2. The Drive side (no transaction is open while Google answers).
    const root = setting.folder_id;
    await drive.check(root);
    const where = new Map<string | null, string>([[null, root]]);
    for (const fo of parentsFirst(snap.folders)) {
      try {
        const parent = where.get(fo.under) ?? root, k = known("folder", fo.id);
        const id = await drive.folder(safeFileName(fo.name), parent, k?.drive_id ?? null);
        where.set(fo.id, id); counts.folders++;
        done.push({ kind: "folder", ref: fo.id, drive: id, parent, print: `${fo.name}|${parent}` });
      } catch (e) { problem(`Folder “${fo.name}”`, e); }
    }
    const day = zoneDay(snap.zone);
    // Progress for the card while it runs ("12 of 42 docs"): the total now, the counts every 10 docs.
    const total = snap.docs.length;
    const progress = async () => { await inOrg(pool, org, runAs, (c) => c.query("update pulse.drive_backup_run set counts=$2 where id=$1", [runId, { ...counts, total }])).catch(() => {}); };
    await progress();
    const { regular, semibold } = await fontBytes();
    for (const d of snap.docs) {
      const parent = where.get(d.folderId) ?? root, print = `${docPrint(d)}|${parent}`;
      const pdfK = known("doc_pdf", d.id), docxK = known("doc_docx", d.id);
      if ((counts.docs + counts.docsSkipped) % 10 === 9) await progress();
      if (pdfK?.fingerprint === print && docxK?.fingerprint === print) { counts.docsSkipped++; continue; }
      try {
        const doc = { title: d.title || "Untitled", markdown: htmlToMarkdown(d.html ?? ""), footer: `${snap.name} · ${d.title || "Untitled"} · version ${d.version} · copied by Vitals OS on ${day}` };
        const pdf = await renderDocPdf(doc, { fonts: { regular, semibold } });
        const pdfId = await drive.file(safeFileName(doc.title, "pdf"), "application/pdf", pdf, parent, pdfK?.drive_id ?? null);
        done.push({ kind: "doc_pdf", ref: d.id, drive: pdfId, parent, print });
        const docx = await renderDocDocx(doc);
        const docxId = await drive.file(safeFileName(doc.title, "docx"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document", docx, parent, docxK?.drive_id ?? null);
        done.push({ kind: "doc_docx", ref: d.id, drive: docxId, parent, print });
        counts.docs++;
      } catch (e) { problem(`Doc “${d.title}”`, e); }
    }
    const titles = new Map(snap.docs.map((d) => [d.id, d]));
    for (const x of snap.files) {
      const owner = x.docId ? titles.get(x.docId) : null;
      if (x.docId && !owner) continue; // a file of a doc the admin cannot open
      const parent = owner ? where.get(owner.folderId) ?? root : where.get(x.folderId) ?? root;
      const name = owner ? `${safeFileName(owner.title)} – ${safeFileName(x.name)}` : safeFileName(x.name), print = `${x.sha256}|${name}|${parent}`;
      const k = known("file", x.id);
      if (k?.fingerprint === print) { counts.filesSkipped++; continue; }
      try {
        const bytes = await inOrg(pool, org, runAs, async (c) => (await c.query("select bytes from pulse.doc_file where id=$1", [x.id])).rows[0]?.bytes as Buffer | undefined);
        if (!bytes) continue;
        const id = await drive.file(name, x.mime || "application/octet-stream", bytes, parent, k?.drive_id ?? null);
        done.push({ kind: "file", ref: x.id, drive: id, parent, print }); counts.files++;
      } catch (e) { problem(`File “${x.name}”`, e); }
    }
    // 3. What is in Drive now, and the run's result.
    const ok = counts.notCopied === 0;
    await inOrg(pool, org, runAs, async (c) => {
      for (const x of done) await c.query(`insert into pulse.drive_backup_item(org_id,kind,ref_id,drive_id,parent_drive_id,fingerprint) values(pulse.current_org(),$1,$2,$3,$4,$5)
        on conflict(org_id,kind,ref_id) do update set drive_id=excluded.drive_id,parent_drive_id=excluded.parent_drive_id,fingerprint=excluded.fingerprint,synced_at=clock_timestamp()`, [x.kind, x.ref, x.drive, x.parent, x.print]);
      await c.query("update pulse.drive_backup_run set finished_at=clock_timestamp(),ok=$2,counts=$3,problems=$4 where id=$1", [runId, ok, { ...counts, total: snap.docs.length }, JSON.stringify(problems)]);
    });
    return { ok, counts, problems, error: null };
  } catch (e) {
    const error = e instanceof DriveError ? driveWords(e.status, e.reason) : String((e as Error).message ?? e).slice(0, 300);
    if (runId && runAs) await inOrg(pool, org, runAs, (c) => c.query("update pulse.drive_backup_run set finished_at=clock_timestamp(),ok=false,counts=$2,problems=$3,error=$4 where id=$1", [runId, counts, JSON.stringify(problems), error])).catch(() => {});
    return { ok: false, counts, problems, error };
  } finally { running.delete(org); }
}

const RUN_COLS = `id,reason,started_at "startedAt",finished_at "finishedAt",ok,counts,problems,error,(select display_name from pulse.person where id=r.started_by) "startedBy"`;

export function registerDriveBackupRoutes(app: FastifyInstance, { tx, pool, f = fetch }: { tx: Tx; pool?: Pool; f?: Fetch }) {
  const body = { type: "object" } as const;
  const must = (v: Viewer) => { if (!admin(v)) fail(403, "Backups are set up by the company's admins"); if (!v.person) fail(403, "A shared login cannot change backups"); };

  /** The Settings card: connected or not, the Drive folder, who it runs as, the last runs and what is in Drive. */
  app.get("/api/v0/settings/drive-backup", (req) => tx(req, async (c, v) => {
    must(v);
    const sa = backupAccount();
    const s = (await c.query(`select enabled,folder_id "folderId",run_as "runAs",(select display_name from pulse.person where id=run_as) "runAsName",updated_at "updatedAt" from pulse.drive_backup_setting`)).rows[0] ?? null;
    const runs = (await c.query(`select ${RUN_COLS} from pulse.drive_backup_run r order by started_at desc limit 5`)).rows;
    const copied = (await c.query(`select count(*) filter (where kind='folder')::int folders,count(*) filter (where kind='doc_pdf')::int docs,count(*) filter (where kind='file')::int files,max(synced_at) "lastAt" from pulse.drive_backup_item`)).rows[0];
    const latest = runs[0] as Row | undefined;
    return { connected: !!sa, account: sa?.email ?? null, enabled: !!s?.enabled, folderId: s?.folderId ?? null, folderUrl: s?.folderId ? folderUrl(s.folderId) : null,
      runAs: s?.runAs ? { id: s.runAs, name: s.runAsName } : null, running: running.has(v.org) || (!!latest && !latest.finishedAt && Date.now() - new Date(String(latest.startedAt)).getTime() < 2 * 3600_000),
      runs, copied, nightly: process.env.PULSE_DRIVE_BACKUP_LOOP !== "0" };
  }));

  /** Turn it on or off and choose the Drive folder. Saving checks that Pulse can see the folder. */
  app.post<{ Body: Row }>("/api/v0/settings/drive-backup", { schema: { body } }, (req) => tx(req, async (c, v) => {
    must(v);
    const b = req.body ?? {};
    const cur = (await c.query("select enabled,folder_id from pulse.drive_backup_setting")).rows[0] as { enabled: boolean; folder_id: string | null } | undefined;
    const folderId = b.folder === undefined ? cur?.folder_id ?? null : (folderIdFrom(b.folder) ?? fail(400, "Paste the Drive folder's link (it has /folders/ in it)"));
    const enabled = typeof b.enabled === "boolean" ? b.enabled : cur?.enabled ?? false;
    if (enabled && !folderId) fail(400, "Choose the Drive folder first");
    const sa = backupAccount();
    if (enabled && !sa) fail(409, "Vitals OS is not connected to Google yet. The owner does a one-time set-up first.");
    if (sa && folderId && folderId !== cur?.folder_id) {
      try { await driveClient(sa, f).check(folderId); }
      catch (e) { fail(400, e instanceof DriveError ? driveWords(e.status, e.reason) : "Vitals OS couldn't reach Google Drive. Try again."); }
    }
    await c.query(`insert into pulse.drive_backup_setting(org_id,enabled,folder_id,run_as,updated_by) values(pulse.current_org(),$1,$2,$3,$3)
      on conflict(org_id) do update set enabled=excluded.enabled,folder_id=excluded.folder_id,run_as=excluded.run_as,updated_by=excluded.updated_by,updated_at=clock_timestamp()`, [enabled, folderId, v.person]);
    // DHANASHREE-3: the organisation's own change ('drive_backup' is not an entity type record_change accepts, so every save failed).
    await c.query(`insert into pulse.record_change(org_id,entity_type,entity_id,field,old_value,new_value,changed_by) values(pulse.current_org(),'org',pulse.current_org(),'driveBackup',$1,$2,$3)`,
      [cur ? `${cur.enabled ? "on" : "off"} ${cur.folder_id ?? ""}`.trim() : null, `${enabled ? "on" : "off"} ${folderId ?? ""}`.trim(), v.person]);
    return { ok: true, enabled, folderId, folderUrl: folderId ? folderUrl(folderId) : null };
  }));

  /** Back up now. The copy runs on after this answers; the card shows it running, then its result. */
  app.post("/api/v0/settings/drive-backup/run", (req) => tx(req, async (c, v) => {
    must(v);
    if (!pool) fail(503, "Backups can't run on this server");
    if (!backupAccount()) fail(409, "Vitals OS is not connected to Google yet. The owner does a one-time set-up first.");
    const s = (await c.query("select folder_id from pulse.drive_backup_setting")).rows[0];
    if (!s?.folder_id) fail(400, "Choose the Drive folder first");
    if (running.has(v.org)) fail(409, "A backup is already running");
    // The run reads as the admin who set the backup up; this admin is recorded as the one who started it.
    void runBackup(pool!, v.org, "on_demand", v.person, f).then((r) => app.log.info({ org: v.org, ok: r.ok, error: r.error, ...r.counts }, "Drive backup (on demand)"));
    return { started: true };
  }));

  // Every 15 minutes: each active company whose backup is on and due (from 2 a.m. its time, once a day) runs once.
  let busy = false;
  const due = async () => {
    if (busy || !pool || !backupAccount()) return;
    busy = true;
    try {
      const orgs = (await pool.query("select pulse.list_active_orgs() org")).rows.map((r) => r.org as string);
      for (const org of orgs) {
        try {
          const s = await inOrg(pool, org, null, async (c) => (await c.query("select enabled,run_as from pulse.drive_backup_setting where enabled")).rows[0] as { run_as: string } | undefined);
          if (!s) continue;
          const state = await inOrg(pool, org, s.run_as, async (c) => ({
            zone: await orgZone(c),
            last: (await c.query(`select started_at,finished_at,ok from pulse.drive_backup_run order by started_at desc limit 1`)).rows[0] ?? null,
            lastOk: (await c.query(`select max(started_at) at from pulse.drive_backup_run where ok`)).rows[0]?.at ?? null,
          }));
          const last = state.last ? { startedAt: new Date(state.last.started_at), finishedAt: state.last.finished_at ? new Date(state.last.finished_at) : null, ok: state.last.ok } : null;
          if (!nightlyDue(new Date(), state.zone, last, state.lastOk ? new Date(state.lastOk) : null)) continue;
          const r = await runBackup(pool, org, "nightly", null, f);
          app.log.info({ org, ok: r.ok, error: r.error, ...r.counts }, "Drive backup (nightly)");
        } catch (e) { app.log.warn({ org, reason: (e as Error).message?.slice(0, 120) }, "Drive backup check failed"); }
      }
    } finally { busy = false; }
  };
  const loopOn = !!pool && process.env.PULSE_DRIVE_BACKUP_LOOP !== "0";
  const tick = loopOn ? setInterval(() => void due().catch(() => {}), 15 * 60_000) : null;
  tick?.unref();
  app.addHook("onClose", async () => { if (tick) clearInterval(tick); });
}
