export type Category = { id: string; name: string; icon: string; colour: string; builtin: boolean };
export type Section<T> = Category & { channels: T[]; unread: number };
type Groupish = { id: string; kind: string; category?: string | null; icon?: string | null; colour?: string | null; unread: number; markedUnread?: string | null; mutedUntil?: string | null; archivedAt?: string | null };
export const BUILTIN: Category[];
export const ICONS: string[];
export const COLOURS: string[];
export const OTHER: Category;
export function groupSections<T extends Groupish>(channels: T[] | null | undefined, categories: Category[] | null | undefined, now?: number): Section<T>[];
export function inCategory<T extends Groupish>(channels: T[] | null | undefined, key: string, categories?: Category[]): T[];
export function groupLook(channel: Pick<Groupish, "category" | "icon" | "colour"> | null | undefined, categories: Category[] | null | undefined): { icon: string; colour: string };
export function sectionOpen(key: string, folded: Set<string> | null | undefined, searching: boolean): boolean;
export function creatorsLine(creators: "leaders" | "managers" | "everyone", canCreate: boolean): string;
export function listFits(pageViewer: string | null | undefined, data: { viewer?: string | null } | null | undefined): boolean;
/** VITALS-SWEEP: only a whole list (conversations and people both lists) may replace the one on screen or be restored. */
export function listWhole(data: unknown): boolean;
export function watchMoving(target?: EventTarget | null): { now: () => boolean; stop: () => void };
