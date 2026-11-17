export type Standing = { videos: number; watched: number; percent: number; questions: number; best: number | null; tries: number; passed: boolean; done: boolean; lastAt: string | null };
export function groupLabel(kind: string, target: string | null, team?: string, heads?: string): string;
export const SIDES: string[];
export const ROLES: string[];
export function milestone(currentTime: number, duration: number, kept?: number): number | null;
export function standingLine(s: Standing | null | undefined): string;
export function standingPercent(s: Standing | null | undefined): number;
export function providerLabel(provider: string): string;
