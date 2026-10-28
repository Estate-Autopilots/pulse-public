// BUG-REPORT (owner, 27 Oct 2026): the last 50 problems this page met and the last 50 failed network calls, kept in
// memory for a bug report. Problems: script errors, unhandled rejections, console errors and screen errors (the first
// line of the message and where it came from). Calls: the method, the path's pattern (ids become ":id", no query or
// fragment) and the status or "no connection" (0). Never request or response bodies, headers, tokens or console
// arguments other than text. It lives only in this tab and leaves the device only inside a report the person sends.
import { pathTemplate } from "../lib/telemetry.mjs";
import { scrubText } from "../lib/bug-report.mjs";

export type RecentError = { at: string; kind: "error" | "rejection" | "console" | "boundary"; message?: string; source?: string; line?: number; count?: number };
export type FailedCall = { at: string; method: string; path: string; status: number; ms?: number };

const LIMIT = 50;
let errors: RecentError[] = [];
let calls: FailedCall[] = [];

export function recordError(entry: Omit<RecentError, "at">) {
  const clean: RecentError = { at: new Date().toISOString(), kind: entry.kind, ...(entry.message ? { message: scrubText(entry.message.split("\n")[0], 300) } : {}),
    ...(entry.source ? { source: (pathTemplate(entry.source.split(/[?#]/)[0].replace(/^[a-z]+:\/\/[^/]+/i, "")) ?? "").slice(0, 160) } : {}), ...(entry.line ? { line: entry.line } : {}) };
  const last = errors.at(-1);
  // A loop repeating one failure keeps one entry with a count, not fifty copies.
  if (last && last.kind === clean.kind && last.message === clean.message && last.source === clean.source) { errors[errors.length - 1] = { ...clean, count: (last.count ?? 1) + 1 }; return; }
  errors = [...errors, clean].slice(-LIMIT);
}

export function recordCall(method: string, url: string, status: number, ms?: number) {
  let path = url;
  try { const u = new URL(url, window.location.href); path = u.origin === window.location.origin ? u.pathname : `${u.host}${u.pathname}`; } catch { /* kept as given */ }
  calls = [...calls, { at: new Date().toISOString(), method: method.toUpperCase().slice(0, 8), path: (pathTemplate(path) ?? "/").split("?")[0], status, ...(ms !== undefined ? { ms: Math.round(ms) } : {}) }].slice(-LIMIT);
}

export const recentErrors = (): readonly RecentError[] => errors;
export const recentCalls = (): readonly FailedCall[] => calls;

const describe = (reason: unknown) => reason instanceof Error ? `${reason.name}: ${reason.message}` : typeof reason === "string" ? reason : "Unknown problem";
// The reporter's own calls and telemetry's batches are not the page's problems.
const OWN = /\/api\/v0\/(telemetry|bug-reports)(\/|\?|$)/;

let installed = false;
/** Listens once per page: errors, rejections, console errors, and fetch calls that fail or answer 4xx/5xx. */
export function installRecorder() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("error", (event) => {
    if (!event.error && !event.message) return;
    recordError({ kind: "error", message: event.error ? describe(event.error) : event.message, source: event.filename || undefined, line: event.lineno || undefined });
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason as { name?: string } | null;
    if (reason?.name === "AbortError") return;
    recordError({ kind: "rejection", message: describe(event.reason) });
  });
  const original = console.error;
  console.error = (...args: unknown[]) => {
    try {
      const first = args.find((arg) => typeof arg === "string" || arg instanceof Error);
      if (first !== undefined) recordError({ kind: "console", message: describe(first) });
    } catch { /* never breaks the page */ }
    original.apply(console, args);
  };
  const fetchBefore = window.fetch;
  window.fetch = async function recordedFetch(input: RequestInfo | URL, init?: RequestInit) {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET");
    const start = performance.now();
    try {
      const response = await fetchBefore.call(window, input, init);
      if (response.status >= 400 && !OWN.test(url)) recordCall(method, url, response.status, performance.now() - start);
      return response;
    } catch (error) {
      if ((error as { name?: string })?.name !== "AbortError" && !OWN.test(url)) recordCall(method, url, 0, performance.now() - start);
      throw error;
    }
  };
}
