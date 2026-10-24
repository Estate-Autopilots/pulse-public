// One conversation per audience in conversation lists. chat_refresh() mirrors the same people into a pod channel,
// a team channel and a Google group channel ("Leadership", "Leadership", "EA Leadership"). Empty mirrors are marked
// duplicateOf the conversation people actually use; nothing is deleted, and a mirror reappears as soon as it has a
// message, so no conversation with content is ever hidden. A group people made themselves is never a mirror.
export type ListedChannel = { id: string; kind: string; name: string; lastAt: string | Date | null; moderationOnly?: boolean; duplicateOf?: string | null };

const PRIORITY: Record<string, number> = { pod: 0, team: 1, group: 2 };
/** "EA Leadership", "leadership" and "Leadership " are the same audience name. */
export const audienceKey = (name: string) => name.trim().toLowerCase().replace(/^ea\s+/, '').replace(/\s+/g, ' ');

export function markDuplicateChannels<T extends ListedChannel>(channels: T[]): T[] {
  const groups = new Map<string, T[]>();
  for (const ch of channels) {
    if (ch.kind === 'direct' || ch.kind === 'custom' || ch.moderationOnly) continue;
    const key = audienceKey(ch.name);
    groups.set(key, [...(groups.get(key) ?? []), ch]);
  }
  const duplicateOf = new Map<string, string>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const at = (c: T) => (c.lastAt ? new Date(c.lastAt).getTime() : 0);
    const canonical = [...group].sort((a, b) => at(b) - at(a) || (PRIORITY[a.kind] ?? 9) - (PRIORITY[b.kind] ?? 9) || a.id.localeCompare(b.id))[0];
    for (const ch of group) if (ch !== canonical && !ch.lastAt) duplicateOf.set(ch.id, canonical.id);
  }
  return channels.map(ch => ({ ...ch, duplicateOf: duplicateOf.get(ch.id) ?? null }));
}
