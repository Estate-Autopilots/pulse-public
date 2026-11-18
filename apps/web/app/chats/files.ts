// WA-NATIVE: where a chat file is read. A file a person attached lives in the chat's own store (/chats/files/<id>); a
// file of history imported from WhatsApp ("wa-<sha256>") streams from the WhatsApp store with range requests (video
// seeks, long voice notes), behind the same membership check.
export const isImported = (a: { id?: string }) => !!a.id?.startsWith("wa-");
export function fileUrl(a: { id?: string }, inline = false) {
  const id = a.id ?? "";
  return id.startsWith("wa-") ? `/api/v0/chats/whatsapp/files/${id.slice(3)}${inline ? "?inline=1" : ""}` : `/api/v0/chats/files/${id}${inline ? "?inline=1" : ""}`;
}
/** A poster or browser copy of an imported video (their SHA-256). */
export const waUrl = (sha: string) => `/api/v0/chats/whatsapp/files/${sha}`;
