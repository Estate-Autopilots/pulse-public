// REPLAY-FIXES #4 (REPLAY-INSIGHTS 20 Nov 2026: a quotation opened from Chats said "not found" (404) for Akabod and
// Sakobe, and "This view is unavailable" for Adunor, all at Willow Lane). A chat message keeps the link it was written with,
// but the quotation behind it moves on: a revision replaces it (superseded_by), or the AI employee discards a draft and
// drafts it again. GET /api/v0/erp/documents/:id/latest answers where that link leads now; this is its rule.

export type LatestFacts = {
  /** The document the link names. */
  asked: string;
  /** The link's document and each newer version after it (superseded_by), as far as this person may read; empty when
   *  they cannot read the asked one (deleted, or not theirs). */
  chain: string[];
  /** The asked document was deleted (its trail says so). */
  deleted: boolean;
  /** The newest quotation kept for the chat the link was in (erp_quote_chat) and its newer versions, readable by this
   *  person; null when the link was not in a chat or nothing is kept for it. */
  fromChat: string[] | null;
};
export type LatestAnswer = { id: string | null; state: "here" | "replaced" | "deleted" | "unavailable" };

/** "here": the link is the newest. "replaced": open `id` instead (a newer version, or the chat's newer quotation when
 *  the linked draft is gone). "deleted" / "unavailable": nothing to open; say so (never a bare "not found"). */
export function latestDocAnswer(f: LatestFacts): LatestAnswer {
  const newest = f.chain.length ? f.chain[f.chain.length - 1] : null;
  if (newest) return { id: newest, state: newest === f.asked ? "here" : "replaced" };
  const other = f.fromChat?.length ? f.fromChat[f.fromChat.length - 1] : null;
  if (other && other !== f.asked) return { id: other, state: "replaced" };
  return { id: null, state: f.deleted ? "deleted" : "unavailable" };
}
