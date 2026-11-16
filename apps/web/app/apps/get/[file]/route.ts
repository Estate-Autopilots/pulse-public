import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { vitalsDownloads } from "../vitals-downloads";

const TYPES = { apk: "application/vnd.android.package-archive", exe: "application/vnd.microsoft.portable-executable", msi: "application/x-msi" } as const;

/** PULSE-APPS: the Vitals OS installers, public like the install pages (a phone scanning the QR code is not signed in
 *  yet). Only the exact files named by the published manifests are reachable; nothing else on disk is. */
export async function GET(_req: Request, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  const entry = (await vitalsDownloads()).find((f) => f.name === file);
  if (!entry) return Response.json({ error: "Download not published yet" }, { status: 404 });
  return new Response(Readable.toWeb(createReadStream(entry.path)) as ReadableStream, { headers: {
    "content-type": TYPES[entry.kind], "content-length": String(entry.size), "content-disposition": `attachment; filename="${entry.name}"`,
    "cache-control": "public, max-age=300", "x-content-type-options": "nosniff", "content-security-policy": "sandbox",
  } });
}
