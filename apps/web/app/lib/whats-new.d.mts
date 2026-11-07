export type WhatsNewItem = { id: string; title: string; text: string; href: string; cta: string; who: "all" | "leaders" | "admins" };
export declare const WHATS_NEW_ID: string;
export declare const WHATS_NEW_COOKIE: string;
export declare const WHATS_NEW: WhatsNewItem[];
export declare function whatsNewFor(roleLabel: string | undefined, isOff?: (href: string) => boolean): WhatsNewItem[];
