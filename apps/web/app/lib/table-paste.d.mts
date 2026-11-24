// DOCS-EDITOR-2: types for table-paste.mjs.
export declare const MAX_ROWS: number;
export declare const MAX_COLS: number;
export declare function parseGrid(text: string): string[][] | null;
export declare function gridHtml(rows: string[][], opts?: { header?: boolean }): string;
export declare function looksLikeHeader(rows: string[][]): boolean;
