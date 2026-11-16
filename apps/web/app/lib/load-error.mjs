// EST-1197: what a page says when its data did not load (the shared Message view, used by about 130 screens).
// Trust is explicit (CTO and QA review at bc120af6): a sentence is shown as it is only when Pulse's own source wrote it,
// word for word — the API's fixed sign-in, permission and not-found refusals and the web app's own words, collected into
// notices.mjs by notices-collect.mjs. How a text looks never makes it trusted. Everything else (Pulse unreachable or
// busy, a 5xx body, an unknown 4xx text, a credential, a code, markup) becomes one plain line with Try again.
import { NOTICES } from './notices.mjs';

export const UNAVAILABLE = 'Pulse data is temporarily unavailable';
const SIGN_IN = 'Sign in to Pulse to see your workspace.';
// Product lines that mean "try again": they get Try again, not their own words.
const TRANSIENT = [/temporarily unavailable/i, /reconnecting/i, /^this view is unavailable\.?$/i, /did not answer in time/i];

/**
 * The error text a page may receive for an API answer that was not OK: a 4xx `error` that is one of Pulse's own
 * sentences (notices.mjs), the switched-off module's signal, the sign-in line for 401, or else a fixed product line.
 * @param {number | undefined} status
 * @param {unknown} body the parsed JSON body, or null
 */
export function apiFailure(status, body) {
  const said = body && typeof body === 'object' && typeof body.error === 'string' ? body.error.trim() : '';
  // A switched-off module's routes answer 404 "Not Found": module-off.tsx keys its neutral page on that exact pair.
  if (status === 404 && said === 'Not Found') return 'Not Found';
  if (status && status >= 400 && status < 500 && NOTICES.has(said)) return said;
  if (status === 401) return SIGN_IN;
  return UNAVAILABLE;
}

/**
 * @param {string | null | undefined} text what the page was given (often the API's `error`)
 * @returns {{ retry: boolean, title: string, text: string }}
 */
export function describeFailure(text) {
  const t = String(text ?? '').trim();
  if (NOTICES.has(t) && !TRANSIENT.some((r) => r.test(t))) return { retry: false, title: 'This view is unavailable', text: t };
  return { retry: true, title: 'This didn’t load', text: 'Pulse couldn’t get this page’s data just now. Check your connection, then try again.' };
}
