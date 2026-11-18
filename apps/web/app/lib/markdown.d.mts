export type Inline =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "confirm"; text: string }
  | { type: "break" }
  | { type: "strong"; children: Inline[] }
  | { type: "em"; children: Inline[] }
  | { type: "link"; href: string; children: Inline[] };

export type Block =
  | { type: "heading"; level: number; id: string; children: Inline[] }
  | { type: "paragraph"; children: Inline[] }
  | { type: "list"; ordered: boolean; start: number; loose: boolean; items: { children: Block[] }[] }
  | { type: "table"; align: ("left" | "center" | "right" | null)[]; head: Inline[][]; rows: Inline[][][] }
  | { type: "quote"; children: Block[] }
  | { type: "rule" }
  | { type: "code"; text: string };

export type OutlineEntry = { id: string; level: number; text: string };
export type ConfirmItem = { section: string | null; sectionId: string | null; text: string };

export function parseInline(src: string): Inline[];
export function parseMarkdown(source: string): { blocks: Block[]; outline: OutlineEntry[]; confirm: ConfirmItem[] };
export function plain(nodes: Inline[] | undefined): string;
export function safeHref(raw: unknown): string | null;
