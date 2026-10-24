"use client";
// A file the page makes itself (a CSV export, a review plan). In a browser: an ordinary download. In the Pulse phone
// app the bytes go to the shell with their name (POLISH-2, QA-E2E P2-7: Android's WebView turned a page-made link into
// "pdf_base64_JVBERi0x….pdf" or a random id).
import { shell } from "./native-shell";

export async function saveFile(blob: Blob, name: string): Promise<void> {
  const s = shell();
  if (s) {
    try {
      const base64 = await new Promise<string>((done, fail) => { const r = new FileReader(); r.onload = () => done(String(r.result).split(",")[1] ?? ""); r.onerror = () => fail(r.error); r.readAsDataURL(blob); });
      await s.saveFile({ name, mime: blob.type.split(";")[0] || "application/octet-stream", base64 });
      return;
    } catch { /* an older app without saveFile: the ordinary download below */ }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
