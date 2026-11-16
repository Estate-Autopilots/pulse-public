// Types for badges.mjs (HR-PEOPLE, T1.1.3).
export type Badge = { where: string; href: string; source: string[]; target: string[]; say: (n: number) => string };
export declare const BADGES: Readonly<Record<string, Badge>>;
export declare function badgeTip(id: string, n: number): string;
export declare function badgeHref(id: string): string;
export declare const BADGE_TRAVEL: string;
export declare const BADGE_TRAVEL_MS: number;
export declare function badgeTravel(raw: unknown, now?: number): { id: string; at: number } | null;
