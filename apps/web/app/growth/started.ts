// GROWTH-LOOP slice 2: once a company exists, tell Vitals which company brought its founder here (the referral the
// "What is Vitals?" card kept in this browser, up to two hours). Once, then forgotten; a failure never blocks arriving.
import { REF_KEY, readRef } from "../lib/growth.mjs";

export async function reportStarted(): Promise<void> {
  let raw: string | null = null;
  try { raw = window.localStorage.getItem(REF_KEY); window.localStorage.removeItem(REF_KEY); } catch { return; }
  const ref = readRef(raw);
  if (!ref) return;
  try {
    await fetch("/api/v0/growth/started", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ via: ref.via, source: ref.source }),
      cache: "no-store", keepalive: true, signal: AbortSignal.timeout(4000) });
  } catch { /* the company is made either way */ }
}
