"use client";
// TASK-MERGE (Pip): what this person did with Pip's suggestions, kept on the server per person (pulse.pip_feedback),
// so a "Not useful" follows them to every device and the same suggestion never comes back. Read once per visit; a
// change shows at once and is saved behind it. When the server cannot be reached the dismissal is kept in this
// browser too (wrapped: private windows and blocked storage simply skip it).
import { useEffect, useSyncExternalStore } from "react";
import { suggestionKey, type KindStat } from "./pip-suggest.mjs";

export type PipFeedback = { dismissed: Set<string>; kinds: Record<string, KindStat>; loaded: boolean };
type Row = { kind: string; subject: string; accepted: number; dismissed: number; dismissedAt: string | null };

const LOCAL = "pulse.pip.dismissed.v1";
const EMPTY: PipFeedback = { dismissed: new Set(), kinds: {}, loaded: false };
let state: PipFeedback = EMPTY;
let reading: Promise<void> | null = null;
const listeners = new Set<() => void>();
const emit = (next: PipFeedback) => { state = next; listeners.forEach((l) => l()); };

const localDismissed = (): string[] => { try { const v = JSON.parse(window.localStorage.getItem(LOCAL) ?? "[]"); return Array.isArray(v) ? v.map(String) : []; } catch { return []; } };
const keepLocal = (key: string) => { try { window.localStorage.setItem(LOCAL, JSON.stringify([...new Set([...localDismissed(), key])].slice(-300))); } catch { /* storage unavailable */ } };

function load() {
  if (state.loaded || reading) return;
  reading = fetch("/api/v0/pip/feedback", { cache: "no-store" }).then((r) => r.ok ? r.json() as Promise<{ rows?: Row[] }> : { rows: [] }).catch(() => ({ rows: [] as Row[] }))
    .then((d) => {
      const dismissed = new Set<string>(localDismissed()); const kinds: Record<string, KindStat> = {};
      for (const r of d.rows ?? []) {
        if (r.dismissedAt) dismissed.add(suggestionKey(r.kind, r.subject));
        const k = kinds[r.kind] ?? { accepted: 0, dismissed: 0 }; k.accepted = (k.accepted ?? 0) + (r.accepted || 0); k.dismissed = (k.dismissed ?? 0) + (r.dismissed || 0); kinds[r.kind] = k;
      }
      // What happened while reading stays.
      for (const k of state.dismissed) dismissed.add(k);
      emit({ dismissed, kinds: { ...kinds, ...Object.fromEntries(Object.entries(state.kinds).map(([k, v]) => [k, { accepted: (kinds[k]?.accepted ?? 0) + (v.accepted ?? 0), dismissed: (kinds[k]?.dismissed ?? 0) + (v.dismissed ?? 0) }])) }, loaded: true });
    }).finally(() => { reading = null; });
}

/** The person said "Not useful" (dismiss) or used it (accept). */
export function pipFeedback(kind: string, subject: string, action: "accept" | "dismiss") {
  const key = suggestionKey(kind, subject);
  const k = { accepted: 0, dismissed: 0, ...state.kinds[kind] };
  if (action === "accept") k.accepted = (k.accepted ?? 0) + 1; else k.dismissed = (k.dismissed ?? 0) + 1;
  const dismissed = new Set(state.dismissed); if (action === "dismiss") dismissed.add(key);
  emit({ ...state, dismissed, kinds: { ...state.kinds, [kind]: k } });
  void fetch("/api/v0/pip/feedback", { method: "POST", headers: { "content-type": "application/json" }, keepalive: true, body: JSON.stringify({ kind, subject, action }) })
    .then((r) => { if (!r.ok && action === "dismiss") keepLocal(key); }).catch(() => { if (action === "dismiss") keepLocal(key); });
}

/** This person's feedback, read once per visit. */
export function usePipFeedback(): PipFeedback {
  useEffect(() => { load(); }, []);
  return useSyncExternalStore((fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; }, () => state, () => EMPTY);
}

/** Auto-open is off until its measured precision is very high (TASK-MERGE Pip evaluation); NEXT_PUBLIC_PIP_AUTO_OPEN=1 turns it on. */
export const PIP_AUTO_OPEN = process.env.NEXT_PUBLIC_PIP_AUTO_OPEN === "1";
