export type Rect = { left: number; top: number; right: number; bottom: number };
export function overlaps(a: Rect, b: Rect, gap?: number): boolean;
export function placeFloat(want: { x: number; y: number }, w: number, h: number, room: Rect, avoid: Rect[]): { x: number; y: number; moved: boolean };
export function floatRoom(o: { width: number; height: number; bar?: Rect | null; tabs?: Rect | null; edge?: number; safeBottom?: number }): Rect;
export function openSide(p: { x: number; y: number }, size: number, room: Rect): { side: "left" | "right"; v: "top" | "bottom"; above: number; below: number };
export function isClear(p: { x: number; y: number }, w: number, h: number, avoid: Rect[]): boolean;
export function snapEdge(p: { x: number; y: number }, w: number, h: number, room: Rect): { x: number; y: number };
export function scanFloat(want: { x: number; y: number }, w: number, h: number, room: Rect, avoid: Rect[], step?: number): { x: number; y: number } | null;
export function leastFloat(want: { x: number; y: number }, w: number, h: number, room: Rect, hard: Rect[], soft: Rect[], step?: number): { x: number; y: number } | null;
