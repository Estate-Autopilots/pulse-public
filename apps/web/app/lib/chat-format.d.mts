export type Receipts = { readThrough: string | null; deliveredThrough: string | null };
export type Tick = "pending" | "failed" | "sent" | "delivered" | "read";
export type PresenceTone = "green" | "violet" | "orange" | "teal" | "amber" | "idle" | "off" | "leave" | "dnd";
export type Presence = { state: string; dnd?: boolean; text?: string | null; emoji?: string | null; activeAt?: string | null; until?: string | null };
export type Segment = { type: "text" | "mention"; value: string } | { type: "link"; value: string; label: string; rest: string };
export declare function clock(iso: string): string;
export declare function fullTime(iso: string): string;
export declare function dayChip(iso: string, now?: Date): string;
export declare function listTime(iso: string | null | undefined, now?: Date): string;
export declare function sameDay(a: string, b: string): boolean;
export declare function ticks(message: { authorId: string; createdAt: string; kind?: string; removed?: boolean; pending?: boolean; failed?: boolean | string }, receipts: Receipts | null | undefined, viewer: string): Tick | null;
export declare function preview(channel: { kind: string; lastAt: string | null; members?: number; moderationOnly?: boolean; preview?: string | null; previewAuthor?: string | null; previewAuthorId?: string | null; previewKind?: string | null; previewRemoved?: boolean | null; previewImported?: boolean | null; previewAttachment?: { id?: string; task?: string; url?: string; name?: string; omitted?: string } | null }, viewer: string): string;
export declare function kindLabel(kind: string): string | null;
export declare function sortChats<T extends { name: string; lastAt: string | null; pinnedAt?: string | null }>(channels: T[]): T[];
export declare function filterChats<T extends { name: string; kind: string; unread: number; mentions?: number; moderationOnly?: boolean; duplicateOf?: string | null; preview?: string | null; clientFacing?: boolean; withOrg?: string | null; clientGroup?: boolean }>(channels: T[], filter: string, query?: string): T[];
export declare function presenceLabel(p: Presence | null | undefined): { label: string; tone: PresenceTone; status?: string };
export declare function lastSeen(activeAt: string | null | undefined, now?: Date): string;
export declare function linkDomain(href: string): string;
export declare function segments(body: string, usernames?: (string | null)[], mentioned?: { name: string; username: string | null }[] | null): Segment[];
export declare function splitQuoted(text: string): { main: string; quoted: string };
export declare function byDepartment<T extends { name: string; team?: string | null }>(members: T[]): { department: string; people: T[] }[];
export declare function fileSize(bytes: number): string;
/** CHAT-V4: the first public https link worth a preview card, or null. */
export declare function previewLink(body: string, origin?: string): string | null;
/** CHAT-V4: people for @ as it is typed, best first. */
export declare function rankMentions<T extends { id: string; name: string; username?: string | null }>(members: T[], typed: string, viewer: string, limit?: number): T[];
