export function squash(text: unknown): string;
export function words(query: unknown): string[];
export function score(query: string, fields: (string | null | undefined)[]): number;
export function rank<T>(items: T[], query: string, fieldsOf: (item: T) => (string | null | undefined)[], limit?: number): T[];
