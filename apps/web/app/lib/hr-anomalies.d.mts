export type AnomalyLike = { type: string; personId: string; name: string; date: string | null; detail: string };
export declare const ANOMALY_KINDS: [string, string][];
export declare function shortReason(a: AnomalyLike): string;
export declare function groupAnomalies<T extends AnomalyLike>(anomalies: T[] | null | undefined): { type: T["type"]; label: string; items: T[]; people: number }[];
