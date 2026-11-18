// COMPANY-OPS: the parts of the Google Drive backup that need no network or database (unit-tested on their own).
import { createHash } from "node:crypto";

export type ServiceAccount = { email: string; key: string };
/** The service account Vitals OS signs in to Drive with: the key file Google gives (JSON), as text or base64. */
export function parseServiceAccount(text: string | undefined | null): ServiceAccount | null {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  let json = raw;
  if (!raw.startsWith("{")) { try { json = Buffer.from(raw, "base64").toString("utf8"); } catch { return null; } }
  try {
    const o = JSON.parse(json) as { type?: string; client_email?: string; private_key?: string };
    if (o.type !== "service_account" || !o.client_email || !/-{5}BEGIN [A-Z ]*PRIVATE KEY-{5}/.test(o.private_key ?? "")) return null;
    return { email: o.client_email, key: String(o.private_key) };
  } catch { return null; }
}

/** A Drive folder from what an admin pastes: the folder's address in Drive, or its id. */
export function folderIdFrom(input: unknown): string | null {
  const s = String(input ?? "").trim();
  if (!s) return null;
  const m = /\/folders\/([A-Za-z0-9_-]{10,200})/.exec(s) ?? /[?&]id=([A-Za-z0-9_-]{10,200})/.exec(s) ?? /^([A-Za-z0-9_-]{10,200})$/.exec(s);
  return m ? m[1] : null;
}
export const folderUrl = (id: string) => `https://drive.google.com/drive/folders/${id}`;

/** Folders, parents first. A folder whose parent the backup cannot see goes at the top (under the Drive folder). */
export function parentsFirst<T extends { id: string; parentId: string | null }>(folders: T[]): (T & { under: string | null })[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const out: (T & { under: string | null })[] = [], done = new Set<string>(), visiting = new Set<string>();
  const visit = (f: T) => {
    if (done.has(f.id) || visiting.has(f.id)) return;
    visiting.add(f.id);
    const parent = f.parentId && byId.get(f.parentId) ? byId.get(f.parentId)! : null;
    if (parent) visit(parent);
    visiting.delete(f.id); done.add(f.id);
    out.push({ ...f, under: parent && done.has(parent.id) ? parent.id : null });
  };
  for (const f of folders) visit(f);
  return out;
}

/** What a copy was made from: a doc's version and last change (and its title, which names the files). */
export const docPrint = (d: { version: number | string; updatedAt: string | Date; title: string; folderId: string | null }) =>
  createHash("sha256").update(`${d.version}|${new Date(d.updatedAt).toISOString()}|${d.title}|${d.folderId ?? ""}`).digest("hex").slice(0, 32);

/** Day and hour on the company's clock. */
export function localDayHour(at: Date, timeZone: string): { day: string; hour: number } {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" })
    .formatToParts(at).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

/** The nightly run is due from 2 a.m. company time, once a day; after a failed try, again 3 hours later. A run still
 *  going (started under 2 hours ago, not finished) blocks a new one. */
export function nightlyDue(now: Date, timeZone: string, last: { startedAt: Date; finishedAt: Date | null; ok: boolean | null } | null, lastOk: Date | null): boolean {
  const { day, hour } = localDayHour(now, timeZone);
  if (hour < 2) return false;
  if (last && !last.finishedAt && now.getTime() - last.startedAt.getTime() < 2 * 3600_000) return false;
  if (lastOk && localDayHour(lastOk, timeZone).day === day) return false;
  if (last && now.getTime() - last.startedAt.getTime() < 3 * 3600_000) return false;
  return true;
}

/** Drive's multipart upload body: the file's details, then its bytes. */
export function multipart(meta: Record<string, unknown>, mime: string, bytes: Uint8Array, boundary: string): Buffer {
  return Buffer.concat([
    Buffer.from(`--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\ncontent-type: ${mime}\r\n\r\n`),
    Buffer.from(bytes), Buffer.from(`\r\n--${boundary}--`),
  ]);
}

/** A Drive refusal in words an admin can act on (the card offers "Copy the account's e-mail" next to these). */
export function driveWords(status: number, reason: string): string {
  if (status === 404 || reason === "notFound") return "Vitals OS can't see that Drive folder. Share it with the backup account and choose Content manager.";
  if (reason === "storageQuotaExceeded" || /storage quota/i.test(reason)) return "Use a folder in a shared drive: the backup account has no storage of its own.";
  if (status === 403) return "Vitals OS may not add files to that Drive folder. Share it with the backup account and choose Content manager.";
  if (status === 401) return "Google refused the backup account's sign-in. Ask the owner to check its key on the server.";
  if (status === 429 || status >= 500) return "Google Drive is busy. The backup tries again later.";
  return `Google Drive answered ${status}${reason ? ` (${reason})` : ""}.`;
}
