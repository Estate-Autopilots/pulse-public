// FIX-LIVE (19 Nov 2026, BUG-CENSUS BC-178): a live stream that stays open. The browser reconnects a stream that
// dropped, but an answer that is not a stream closes it for good: the edge answering 502 while the web server
// restarts for a release, before the /api/v0 proxy (ERROR-SWEEP) can turn the API's own 502/503 into "retry". Chats
// then said "Reconnecting…" until the page was reloaded, and its list fell back to a refresh every 15 s. The calls
// engine already opens a closed stream again; this does the same for any stream. Pure apart from the EventSource and
// timers it is given; unit-tested beside it.

export const REOPEN_MAX_MS = 15000;
const CLOSED = 2;

/** The wait before opening a closed stream again: 1 s, then doubling, at most REOPEN_MAX_MS. */
export function reopenWait(previous) {
  return Math.min(REOPEN_MAX_MS, previous > 0 ? previous * 2 : 1000);
}

/** PM-BUILD-4 (USER-INSIGHT L3, 23 Nov 2026): the answers that mean the sign-in ended or the seat may not have this
 *  stream. Production, 22 Nov 13:42-18:38 IST: one signed-out tab asked /screen/events 2,226 times and /calls/events
 *  2,222 times (401 each, about every 8 s, for five hours), because a refusal was always opened again. */
export const SIGNED_OUT = new Set([401, 403]);

/** What `url` answers now (one GET, cut off as soon as its status is known; at most 8 s), or null when nothing
 *  answers. Used only after a stream was refused twice in a row, to tell an ended sign-in from a restarting server. */
export async function answerStatus(url, env = globalThis) {
  const ctl = new AbortController(); const t = env.setTimeout(() => ctl.abort(), 8000);
  try { return (await env.fetch(url, { cache: "no-store", headers: { accept: "text/event-stream" }, signal: ctl.signal })).status; }
  catch { return null; }
  finally { env.clearTimeout(t); ctl.abort(); }
}

/** Opens `url` and opens it again whenever the browser gives up on it. `setup(es)` adds the page's listeners to each
 *  new stream. `current` is the stream now; `wake()` opens a closed one at once (the page came back into view);
 *  `close()` ends it for good. `env` supplies EventSource, setTimeout and clearTimeout (the window by default), and
 *  fetch: with it, a stream refused twice in a row (no open between) asks once why, and a 401 or 403 (signed out,
 *  or no longer allowed) stops reopening until `wake()`. */
export function keepStream(url, setup, env = globalThis) {
  let es = null, wait = 0, timer = null, stopped = false, asking = false;
  const later = () => { wait = reopenWait(wait); timer = env.setTimeout(open, wait); };
  const open = () => {
    timer = null;
    if (stopped) return;
    const next = new env.EventSource(url);
    es = next;
    next.addEventListener("open", () => { if (es === next) wait = 0; });
    next.addEventListener("error", () => {
      if (stopped || es !== next || next.readyState !== CLOSED || timer !== null || asking) return;
      if (wait === 0 || typeof env.fetch !== "function") { later(); return; }
      asking = true;
      answerStatus(url, env).then((status) => {
        asking = false;
        if (stopped || es !== next || timer !== null) return;
        if (!SIGNED_OUT.has(status)) later();   // signed out: stay closed until the page is shown again (wake)
      });
    });
    setup(next);
  };
  open();
  return {
    get current() { return es; },
    wake() {
      if (stopped || !es || es.readyState !== CLOSED) return;
      if (timer !== null) { env.clearTimeout(timer); timer = null; }
      open();
    },
    close() {
      stopped = true;
      if (timer !== null) { env.clearTimeout(timer); timer = null; }
      es?.close();
    },
  };
}
