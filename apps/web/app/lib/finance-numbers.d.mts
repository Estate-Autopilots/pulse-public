export declare const PERIODS: { key: string; label: string }[];
export declare const monthName: (m: string | null | undefined) => string;
export declare const span: (from: string, to: string) => string;
export declare function rupees(paise: number | null | undefined): string;
export declare function periodHref(base: string, period: string, keep?: Record<string, string | undefined | null>): string;
export declare const statusLabel: (s: string) => string;
export declare function dueText(baseDue: number, gstDue: number): string;
