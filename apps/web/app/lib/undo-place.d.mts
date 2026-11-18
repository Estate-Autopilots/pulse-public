export function placeUndo(anchor: { left: number; right: number; top: number; height: number } | null, size: { width: number; height: number }, view: { width: number; height: number }): { left: number; top: number };
export function bannerOver(circle: { left: number; top: number; height: number }, row: { left: number; right: number; top: number; height: number }, view: { width: number; height: number }): { left: number; top: number; width: number; height: number };
export const UNDO_HOLD_MAX: number;
export function undoLeft(ms: number, age: number, hold: boolean, holdMax?: number): number;
