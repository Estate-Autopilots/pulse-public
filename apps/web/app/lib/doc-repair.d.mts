export type RepairNode = { t: "text"; v: string } | { t: "el"; tag: string; attrs: string; kids: RepairNode[] };
export function parseHtml(html: string): RepairNode[];
export function writeHtml(nodes: RepairNode[]): string;
export function repairDocHtml(html: string): string;
export function markdownLeftovers(html: string): string[];
