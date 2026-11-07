// Types for panel-target.mjs (CHAT-SHELL: what the chat's side panel opens).
export type PanelKind = "page" | "gdoc" | "drive-file" | "drive-folder" | "file" | "url";
export type PanelTarget = { kind: PanelKind; key: string; src: string; href: string; embed: boolean; title: string };
export function embedPath(path: string): string;
export function stripEmbed(path: string): string;
export function panelTarget(input: string | null | undefined, origin?: string): PanelTarget | null;
export function titleForPath(path: string): string;
export function frameAllowed(headers: Headers | Record<string, string | undefined> | null | undefined, origin: string): boolean;
