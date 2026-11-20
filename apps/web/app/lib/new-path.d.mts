import type { AnchorRegistry } from "./new-trail.mjs";
export type PathStep = { kind: "rail"; group: string; label: string } | { kind: "menu"; group: string; href: string; label: string; last?: boolean } | { kind: "thing"; anchor: string } | { kind: "page"; label: string } | { kind: "note"; label: string };
export type NavPath = { route: string; href: string; text: string; anchor: string; inferred: boolean; steps: PathStep[]; i: number; at: number };
export declare const PATH_KEY: string;
export declare const PATH_MS: number;
export declare function inferAnchor(item: { route: string; anchor?: string; text?: string } | null | undefined, registry: AnchorRegistry): string;
export declare function pathPlan(p: { route: string; anchor?: string; here: string; spot: { group: string; groupLabel: string; href: string; label: string } | null; rail: boolean }): PathStep[];
export declare function stepWords(i: number, n: number): string;
export declare function pathFrom(x: unknown, now?: number): NavPath | null;
