// XRAY-LINK (Learn): serves a tutorial's video, captions and poster from PULSE_LEARN_MEDIA (see ../../files.ts), with
// byte ranges so the player can seek. Signed-in pages only link here; the files hold fictional demo data.
import { createReadStream, statSync } from "node:fs";
import { Readable } from "node:stream";
import { mediaFile } from "../../files";

export const dynamic = "force-dynamic";
const TYPES: Record<string, string> = { mp4: "video/mp4", vtt: "text/vtt; charset=utf-8", jpg: "image/jpeg", webp: "image/webp", srt: "text/plain; charset=utf-8" };

export async function GET(request: Request, { params }: { params: Promise<{ file: string[] }> }) {
  const { file: parts } = await params;
  const file = mediaFile(parts);
  const type = TYPES[(parts.at(-1) ?? "").split(".").pop()?.toLowerCase() ?? ""];
  if (!file || !type) return new Response("Not found", { status: 404 });
  const size = statSync(file).size;
  const head = { "content-type": type, "accept-ranges": "bytes", "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff" };
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") ?? "");
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end || start >= size) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
    const body = Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream;
    return new Response(body, { status: 206, headers: { ...head, "content-length": String(end - start + 1), "content-range": `bytes ${start}-${end}/${size}` } });
  }
  return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, { headers: { ...head, "content-length": String(size) } });
}
