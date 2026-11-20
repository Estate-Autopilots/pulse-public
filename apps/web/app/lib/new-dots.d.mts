/** NEW-DOTS-2: `anchor` names the thing on the page that changed ("" for the page as a whole); `opened`: its page was opened. */
export type NewDotsItem = { note: number; route: string; anchor?: string; opened?: boolean; text: string; headline: string; releasedAt: string };
export type NewDotsState = { on: boolean; count: number; items: NewDotsItem[] };
export type UnseenLine = { route: string; anchor: string; text: string; headline: string; releasedAt: string; releases: number };
export declare const NEW_DOTS_REFRESH: string;
export declare function unseenLines(items: NewDotsItem[] | null | undefined): UnseenLine[];
export declare function unseenHeading(n: number): string;
