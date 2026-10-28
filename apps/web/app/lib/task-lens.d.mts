export type Lens = "assigned" | "created" | "reviewing" | "all";
type LensTask = { id: string; status: string; assigneeId: string | null; createdBy: string | null; reviewerId: string | null; assignerId?: string | null };
export declare const LENSES: readonly { key: Lens; label: string; tip: string }[];
export declare function inLens(lens: Lens, t: LensTask, me: string | null): boolean;
export declare function lensCount(lens: Lens, rows: LensTask[], me: string | null): number;
export declare function firstLens(asked: string | undefined, rows: LensTask[], me: string | null): Lens;
export declare function lensRows<T extends { id: string }>(home: { rows?: T[]; created?: T[]; reviewing?: T[] }): T[];
