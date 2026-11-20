// Types for catalogue.mjs (AGENT-UI-CONTROL: the screen actions an AI employee may send).
export type Level = "view" | "act" | "admin" | "confirm";
export type ActionName = "page.open" | "panel.open" | "panel.close" | "sidebar.set" | "tab.open" | "point.at" | "mic.stop" | "composer.insert" | "emoji.insert" | "form.open" | "file.pick" | "mic.start" | "screen.read" | "element.click" | "field.fill" | "file.upload" | "file.download" | "guide.play";
export const ACTIONS: Record<ActionName, { level: Level; asks: string; did: string }>;
export const KINDS: Record<ActionName, string>;
export const FORMS: Record<"task" | "project" | "client" | "quote" | "person" | "ai_employee", string>;
export const LEVELS: { key: "off" | "view" | "act" | "admin"; label: string; says: string }[];
export function placeName(raw: unknown, title?: unknown): string;
export function asks(action: string, args?: Record<string, unknown>): string;
export function did(action: string, args?: Record<string, unknown>): string;
export function levelOf(action: string, args?: Record<string, unknown>): Level | null;
export function isEmoji(s: unknown): boolean;
export const RISKY: RegExp;
