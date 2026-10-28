import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { CF_ACCESS_EMAIL_HEADER } from "../../../../lib/account-identity";
import { getMe } from "../../../../lib/api";
import { canDownloadDesktopBuild, loadLatestWindowsBuild, STAFF_NOTICE_VERSION } from "../../../../lib/desktop-builds.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const privateHeaders = { "cache-control": "private, no-store, max-age=0", "x-content-type-options": "nosniff" };

export async function GET(request: Request) {
  const email = request.headers.get(CF_ACCESS_EMAIL_HEADER);
  // DE-EA: an admin is whoever the company's database says is one (no built-in addresses).
  const me = email ? (await getMe()).data : undefined;
  const admins = email && me?.role === "admin" ? [email] : [];
  if (!admins.length) {
    return Response.json({ error: email ? "Admin access required" : "Authentication required" }, { status: email ? 403 : 401, headers: privateHeaders });
  }

  const url = new URL(request.url);
  if (!process.env.PULSE_DESKTOP_DOWNLOADS_DIR?.trim()) {
    return Response.json({ error: "No build published yet" }, { status: 404, headers: privateHeaders });
  }
  if (url.searchParams.get("download") === "1" && !canDownloadDesktopBuild(email, url.searchParams.get("acknowledgement"), admins)) {
    return Response.json({ error: "Acknowledge staff notice v2 before downloading" }, { status: 403, headers: privateHeaders });
  }

  try {
    const build = await loadLatestWindowsBuild(process.env.PULSE_DESKTOP_DOWNLOADS_DIR);
    if (url.searchParams.get("download") === "1") {
      return new Response(Readable.toWeb(createReadStream(build.filePath)) as ReadableStream<Uint8Array>, {
        headers: {
          ...privateHeaders,
          "content-type": "application/octet-stream",
          "content-length": String(build.sizeBytes),
          "content-disposition": `attachment; filename="${build.fileName}"`,
        },
      });
    }

    const { filePath, ...metadata } = build;
    return Response.json({ ...metadata, noticeVersion: STAFF_NOTICE_VERSION, downloadUrl: "/api/admin/devices/desktop-build?download=1" }, { headers: privateHeaders });
  } catch (error) {
    const notPublished = error instanceof Error && "code" in error && error.code === "BUILD_NOT_PUBLISHED";
    return Response.json({ error: notPublished ? "No build published yet" : "No verified Windows build is available on this Pulse deployment" }, { status: notPublished ? 404 : 503, headers: privateHeaders });
  }
}
