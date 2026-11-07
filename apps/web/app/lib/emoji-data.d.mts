export type EmojiItem = { e: string; words: string };
export type EmojiGroup = { key: string; label: string; icon: string; items: EmojiItem[] };
export const EMOJI_GROUPS: EmojiGroup[];
export function searchEmoji(query: string, limit?: number): string[];
export function emojiName(e: string): string;
