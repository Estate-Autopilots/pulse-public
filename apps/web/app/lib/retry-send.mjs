// REPLAY-FIXES #2 (REPLAY-INSIGHTS: an answer in Chats was lost when the connection dropped, Adunor's phone, 18:08 IST).
// An approval's answer (Send it / Apply / Don't, a hand-off's Accept / Decline) went once: a dropped connection or a busy
// server showed the browser's own "Failed to fetch" and nothing was sent. Now the answer is tried again by itself (a
// repeat is safe: the server answers a decided one with its state), waits for the connection to come back, and only if it
// still cannot go says "Not sent" with Tap to retry. A refusal (4xx: not yours, too long) says the server's words at once.

export const RETRY_WAITS = [1000, 2500, 5000];
const passing = (status) => !status || status >= 500 || status === 408 || status === 429;

/** Sends with retries. `send(path, body)` resolves { ok, status, data } or throws (network). `online()` and `waitOnline()`
 *  let it wait for the connection instead of failing at once. Resolves { ok: true, data } | { ok: false, retry, error }. */
export async function sendWithRetry(send, path, body, { waits = RETRY_WAITS, online = () => true, waitOnline = async () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  for (let i = 0; i <= waits.length; i++) {
    if (i) await sleep(waits[i - 1]);
    if (!online()) await waitOnline();
    let r = null;
    try { r = await send(path, body); } catch { r = null; }
    if (r?.ok) return { ok: true, data: r.data };
    if (r && !passing(r.status)) return { ok: false, retry: false, error: r.data?.error ?? "That did not go through." };
  }
  return { ok: false, retry: true, error: "Not sent. Check your connection." };
}

/** The app's JSON POST for sendWithRetry. */
export async function postJson(path, body) {
  const r = await fetch(`/api/v0/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
  return { ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) };
}

/** Waits until the browser says it is online (at most `maxMs`). */
export function untilOnline(maxMs = 30_000) {
  return new Promise((done) => {
    if (typeof window === "undefined" || navigator.onLine !== false) { done(); return; }
    const t = setTimeout(finish, maxMs);
    function finish() { clearTimeout(t); window.removeEventListener("online", finish); done(); }
    window.addEventListener("online", finish);
  });
}
