export declare const LIMITS: Readonly<{ signIn: number; pairStart: number; pairPoll: number; refresh: number; bootstrap: number; device: number; address: number }>;
export declare const BOOTSTRAP: RegExp;
export declare const ALLOWED: RegExp;
export type Limiter = { hit(key: string, limit: number): { ok: boolean; retryAfter: number }; size(): number };
export declare function keyOf(...parts: string[]): string;
export declare function createLimiter(options?: { now?: () => number; max?: number }): Limiter;
export declare function admit(input: { path: string; authorization: string | null; session: string | null; address: string; enabled?: boolean; limiter: Limiter }):
  | { ok: false; status: number; error: string; headers?: Record<string, string> }
  | { ok: true; forward: Record<string, string> };
