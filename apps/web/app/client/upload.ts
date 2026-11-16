"use client";
// PORTAL-2: send a file to the client space in 1 MiB parts (base64 in JSON, one part at a time, each retried), so a
// phone on a weak network can send a video or a payment screenshot. `base` is /api/v0/client-files (the team) or
// /api/v0/client-portal/files (a client).

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(typeof data?.error === "string" ? data.error : "The upload did not work. Try again."), { status: r.status });
  return data as T;
}

/** A slice of the file as base64 (FileReader keeps it off the main stack for big parts). */
function base64(blob: Blob): Promise<string> {
  return new Promise((done, fail) => {
    const reader = new FileReader();
    reader.onload = () => done(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => fail(new Error("Could not read the file"));
    reader.readAsDataURL(blob);
  });
}

/** A file's type as the server accepts it (some phones send none for .mov or Office files). */
export function mimeOf(file: File): string {
  if (file.type) return file.type.toLowerCase();
  const ext = file.name.toLowerCase().split(".").pop() ?? "";
  return ({ mov: "video/quicktime", mp4: "video/mp4", webm: "video/webm", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif",
    pdf: "application/pdf", zip: "application/zip", mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" } as Record<string, string>)[ext] ?? "application/octet-stream";
}

export async function uploadFile(base: string, file: File, extra: Record<string, unknown>, progress?: (share: number) => void): Promise<string> {
  const start = await postJson<{ id: string; parts: number; partSize: number }>(base, { name: file.name, mime: mimeOf(file), size: file.size, ...extra });
  for (let n = 0; n < start.parts; n++) {
    const data = await base64(file.slice(n * start.partSize, Math.min(file.size, (n + 1) * start.partSize)));
    for (let attempt = 0; ; attempt++) {
      try { await postJson(`${base}/${start.id}/parts/${n}`, { data }); break; }
      catch (e) {
        const status = (e as { status?: number }).status ?? 0;
        if (attempt >= 3 || (status >= 400 && status < 500 && status !== 429)) throw e;
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      }
    }
    progress?.((n + 1) / start.parts);
  }
  return start.id;
}
