// PULSE-BUGS-2 (EA #34, Kazuk 20 Nov 2026: "voice notes: no Download option; some show a wrong transcript, others
// none"): what a chat voice note offers besides playing.
//   - Download: any voice note in a message's actions (group chats and direct messages), for whoever sees the message;
//     the file's own read checks access, as for any chat file. Imported WhatsApp notes stream from the WhatsApp store.
//   - The Transcript link in the length row says where the transcript is: ask for one, being made, failed (ask again),
//     or nothing. An imported WhatsApp note has its transcript from the import (or none); Pulse's own transcriber cannot
//     take it (the request is refused), so it never offers a button that does nothing.

/** Where a chat file is read: a Pulse file by its id, an imported WhatsApp one ("wa-<sha256>") from the WhatsApp store. */
export function voiceFileUrl(id) {
  const s = String(id ?? "");
  return s.startsWith("wa-") ? `/api/v0/chats/whatsapp/files/${s.slice(3)}` : `/api/v0/chats/files/${s}`;
}

/** The voice note a message's Download action saves (the first one; a message carries one), or null. Not while the
 *  message is still being sent (its note has no file yet) or once it was deleted. */
export function voiceDownload(m) {
  if (!m || m.pending || m.removed) return null;
  const a = (m.attachments ?? []).find((x) => x && x.id && x.voice);
  if (!a) return null;
  return { href: voiceFileUrl(a.id), name: a.name || "Voice message" };
}

/** What the length row offers for the transcript:
 *  "ask"     Transcript (none yet; Pulse can make one)
 *  "working" Transcribing… (asked; the server's worker has it)
 *  "retry"   Try the transcript again (it failed)
 *  null      nothing: transcripts are off here, the words already show, Pulse was not sure of them ("Not clear —
 *            listen" shows instead), or an imported WhatsApp note (Pulse's transcriber does not take those). */
export function transcriptAction({ id, transcripts, state }) {
  if (!transcripts || String(id ?? "").startsWith("wa-")) return null;
  if (state?.transcript || state?.transcriptState === "unclear" || state?.transcriptState === "done") return null;
  if (state?.transcriptState === "queued") return "working";
  if (state?.transcriptState === "failed") return "retry";
  return "ask";
}

/** Save a file with the browser's own download (the cookie session goes with it), named as it was sent. */
export function saveFile({ href, name }, doc = globalThis.document) {
  if (!doc) return false;
  const a = doc.createElement("a");
  a.href = href; a.download = name; a.rel = "noopener"; a.style.display = "none";
  doc.body.appendChild(a); a.click(); a.remove();
  return true;
}
