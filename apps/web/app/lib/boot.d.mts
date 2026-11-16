export const BOOT_FIXED: readonly string[];
export const BOOT_MAX: number;
export const BOOT_PARALLEL: number;
export function railKey(pathname: string, search?: string | null): string | null;
export function bootKey(raw: unknown): string | null;
export function bootKeys(searchParams: URLSearchParams): string[];
export function shellBootKeys(options: { staff: boolean; admin?: boolean; off?: readonly string[] }): string[];
export function bootAnswer(keys: string[], fetchOne: (key: string) => Promise<Response>, limit?: number): Promise<{ v: 1; r: Record<string, { s: number; b: string; t?: "closed" }> }>;
export const BOOT_SHIM: string;
