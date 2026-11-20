export declare const RETRY_WAITS: number[];
export type SendAnswer = { ok: boolean; status?: number; data?: { error?: string } & Record<string, unknown> };
export declare function sendWithRetry(send: (path: string, body: unknown) => Promise<SendAnswer>, path: string, body: unknown,
  opts?: { waits?: number[]; online?: () => boolean; waitOnline?: () => Promise<void>; sleep?: (ms: number) => Promise<void> }): Promise<{ ok: true; data: unknown } | { ok: false; retry: boolean; error: string }>;
export declare function postJson(path: string, body?: unknown): Promise<SendAnswer & { status: number }>;
export declare function untilOnline(maxMs?: number): Promise<void>;
