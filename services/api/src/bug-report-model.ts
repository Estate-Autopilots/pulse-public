// BUG-REPORT (owner, 27 Oct 2026): what a bug report may carry, checked again on the server after the device scrubbed
// it (apps/web/app/bug-report/scrub.ts). Free text is cut short; anything shaped like a token, key, e-mail address or
// phone number becomes a marker; addresses lose their query and fragment and ids become ":id". Nothing here reads the
// database.
import { createHash } from 'node:crypto';

const REDACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\beyJ[\w-]{6,}\.[\w-]{6,}\.[\w-]{6,}/g, '[token]'],
  [/\bbearer\s+[\w.~+/=-]{8,}/gi, 'Bearer [token]'],
  [/\b(?:sk|pk|rk|whsec|AIza|ghp|gho|xox[abp])[\w-]{10,}/g, '[key]'],
  [/\b(?:password|passwd|secret|token|otp|cookie|session|api[_-]?key)\s*[:=]\s*\S+/gi, '[secret]'],
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]'],
  [/\b[A-Za-z0-9+/_-]{40,}={0,2}/g, '[long]'],
  [/(?<![\w-])\+?\d(?:[\s().-]?\d){8,}(?![\w-])/g, '[phone]'],
];
const ID_PART = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9]+|(?=[A-Za-z_-]*[0-9])[A-Za-z0-9_-]{16,})$/i;

/** One line of plain text, redacted and cut to `limit` characters ('' for anything that is not text). */
export function scrubText(value: unknown, limit: number): string {
  if (typeof value !== 'string') return '';
  let text = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  for (const [pattern, marker] of REDACTIONS) text = text.replace(pattern, marker);
  return text.slice(0, limit);
}

/** What the person wrote: kept as written (line breaks too), only secrets masked, at most 4000 characters. */
export function scrubWords(value: unknown): string {
  if (typeof value !== 'string') return '';
  let text = value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
  for (const [pattern, marker] of REDACTIONS.slice(0, 4)) text = text.replace(pattern, marker);
  return text.slice(0, 4000);
}

/** A path's pattern: no origin, query or fragment; ids become ":id". */
export function routeOf(value: unknown, limit = 300): string {
  if (typeof value !== 'string' || !value.trim()) return '/';
  let url: URL;
  try { url = new URL(value, 'https://app.invalid'); } catch { return '/'; }
  const path = url.pathname.split('/').map((part) => {
    let p = part;
    try { p = decodeURIComponent(part); } catch { /* left as sent */ }
    return ID_PART.test(p) ? ':id' : scrubText(p, 80).replace(/[\s?#]/g, '');
  }).join('/');
  return (path || '/').slice(0, limit);
}

const pick = <T>(list: unknown, max: number, each: (row: Record<string, unknown>) => T | null): T[] =>
  (Array.isArray(list) ? list : []).slice(-max).flatMap((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return [];
    const kept = each(row as Record<string, unknown>);
    return kept ? [kept] : [];
  });
const iso = (value: unknown) => {
  const t = typeof value === 'string' || typeof value === 'number' ? new Date(value) : null;
  return t && !Number.isNaN(t.getTime()) ? t.toISOString() : null;
};
const int = (value: unknown, min: number, max: number) => typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : undefined;
const word = (value: unknown, re: RegExp, max = 40) => typeof value === 'string' && value.length <= max && re.test(value) ? value : undefined;
const compact = <T extends Record<string, unknown>>(row: T) => Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined && v !== '' && v !== null)) as T;

export type ReportError = { at: string; kind: string; message?: string; source?: string; count?: number };
export type ReportCall = { at: string; method: string; path: string; status: number; ms?: number };
export type ReportStep = { at: string; kind: string; name?: string; page?: string; ms?: number; status?: number };

/** The last 50 problems: script errors, rejections, console errors and screen errors (first line, where it came from). */
export function cleanErrors(list: unknown): ReportError[] {
  return pick(list, 50, (r) => {
    const at = iso(r.at), kind = word(r.kind, /^(error|rejection|console|boundary|notice)$/);
    if (!at || !kind) return null;
    return compact({ at, kind, message: scrubText(r.message, 300), source: r.source ? routeOf(String(r.source).split(/[?#]/)[0], 160) + (typeof r.line === 'number' ? `:${Math.round(r.line)}` : '') : undefined, count: int(r.count, 1, 9999) });
  });
}

/** The last 50 failed calls: method, the path's pattern and the status; never a body, header or query. */
export function cleanCalls(list: unknown): ReportCall[] {
  return pick(list, 50, (r) => {
    const at = iso(r.at), method = word(String(r.method ?? '').toUpperCase(), /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/, 8);
    const status = int(r.status, 0, 999);
    if (!at || !method || status === undefined) return null;
    return compact({ at, method, path: routeOf(r.path, 200), status, ms: int(r.ms, 0, 600_000) });
  });
}

/** The last 50 app steps (telemetry's own events: kind, a short name, the screen, a time). */
export function cleanTrail(list: unknown): ReportStep[] {
  return pick(list, 50, (r) => {
    const at = iso(r.at), kind = word(r.kind, /^[a-z]+(\.[a-z0-9_]+){0,2}$/);
    if (!at || !kind) return null;
    return compact({ at, kind, name: r.name ? scrubText(r.name, 120) : undefined, page: r.page ? routeOf(r.page, 120) : undefined, ms: int(r.ms, 0, 600_000), status: int(r.status, 0, 999) });
  });
}

const CONTEXT_TEXT: Record<string, number> = { release: 60, shell: 30, os: 40, browser: 40, model: 60, viewport: 20, screen: 20, language: 20, timezone: 60, theme: 10, connection: 20, device: 20, org: 120, role: 40 };
/** The app, build and device: only these fields, each short. */
export function cleanContext(raw: unknown): Record<string, string | number | boolean> {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const out: Record<string, string | number | boolean> = {};
  for (const [key, max] of Object.entries(CONTEXT_TEXT)) { const v = scrubText(r[key], max); if (v) out[key] = v; }
  for (const key of ['online', 'touch', 'standalone', 'shellApp']) if (typeof r[key] === 'boolean') out[key] = r[key] as boolean;
  const ratio = typeof r.pixelRatio === 'number' && Number.isFinite(r.pixelRatio) ? Math.round(r.pixelRatio * 100) / 100 : undefined;
  if (ratio !== undefined && ratio > 0 && ratio < 10) out.pixelRatio = ratio;
  const memory = int(r.memoryGb, 0, 1024); if (memory !== undefined) out.memoryGb = memory;
  return out;
}

export const PLATFORMS = ['web', 'android', 'ios', 'desktop'] as const;
export const STATUSES = ['new', 'triaged', 'fixing', 'fixed', 'wontfix'] as const;
export const SEVERITIES = ['blocker', 'high', 'medium', 'low'] as const;

/** Reports that look like one problem: the same screen and the same first error (numbers and ids left out). */
export function fingerprint(route: string, errors: readonly ReportError[]): string {
  const first = errors.find((e) => e.kind !== 'notice')?.message ?? '';
  const shape = first.toLowerCase().replace(/[0-9a-f]{8,}/g, '#').replace(/\d+/g, '#').replace(/\s+/g, ' ').slice(0, 160);
  return createHash('sha256').update(`${route}\n${shape}`).digest('hex');
}

const VIDEO_URL = /^data:(video\/webm|video\/mp4)(?:;codecs=[\w.,"-]+)?;base64,([A-Za-z0-9+/=]+)$/;
export const RECORDING_LIMIT = 6 * 1024 * 1024;
/** An optional screen recording: a WebM or MP4 data URL under 6 MB. */
export function parseRecording(raw: unknown): { type: string; bytes: Buffer } | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const m = typeof raw === 'string' ? raw.match(VIDEO_URL) : null;
  if (!m) throw new Error('Attach the recording as a WebM or MP4 video');
  const bytes = Buffer.from(m[2], 'base64');
  if (!bytes.length || bytes.length > RECORDING_LIMIT) throw new Error('The recording is too large; send it without the recording');
  // WebM starts with the EBML magic; MP4 has "ftyp" at byte 4.
  const ok = m[1] === 'video/webm' ? bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) : bytes.subarray(4, 8).toString('latin1') === 'ftyp';
  if (!ok) throw new Error('That recording is not the video it claims to be');
  return { type: m[1], bytes };
}

export const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
