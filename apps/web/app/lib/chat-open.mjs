// REPLAY-FIXES #3 (REPLAY-INSIGHTS: opening a chat ~10 s for 2 people; a Chats search result tapped 4 times in 14 s with
// no answer, Opinem; 2 slow opens, Ruvin). Starting a chat with someone (a search's "Start a chat" and "AI helpers" rows,
// Ctrl+K, a profile's Message) asked the server for the chat and then re-read the whole chat list before opening it, with
// nothing on screen meanwhile, so each tap looked dead and was tapped again. Now a chat that exists opens at once, a new
// one opens as soon as the server names it (a provisional row stands in until the list comes back), and the row says
// "Opening…" from the tap.

/** The person's direct chat already in the list, or null. */
export function existingDirect(list, personId) {
  if (!list || !personId) return null;
  return list.channels?.find((c) => c.kind === "direct" && c.peerId === personId && !c.moderationOnly)?.id ?? null;
}

/** The list with the new direct chat in it (first), until the server's own list replaces it. Unchanged when it is
 *  already there. */
export function withDirect(list, id, person) {
  if (!list || !id || !person || list.channels?.some((c) => c.id === id)) return list;
  const row = { id, name: person.name ?? "", kind: "direct", description: "", address: null, unread: 0, members: 2, lastAt: null,
    peerId: person.id ?? null, peerAgent: !!person.agent, peerPhotoAt: person.photoAt ?? null, peerUsername: person.username ?? null };
  return { ...list, channels: [row, ...(list.channels ?? [])] };
}
