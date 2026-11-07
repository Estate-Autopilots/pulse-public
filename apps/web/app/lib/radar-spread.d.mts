export type RadarDot = { x: number; y: number; a0: number; a1: number; rMin: number; rMax: number };
export function spreadDots<T extends RadarDot>(dots: T[], opts?: { gap?: number; rounds?: number; cx?: number; cy?: number }): T[];
export function closestPair(dots: { x: number; y: number }[]): number;
