export function sharedJson<T = unknown>(url: string, ttl?: number, fetchImpl?: (url: string) => Promise<Response>, now?: () => number): Promise<T | null>;
export function forgetShared(url: string): void;
