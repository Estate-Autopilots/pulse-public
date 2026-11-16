"use client";
import { useCallback, useEffect, useRef, useState } from "react";

/** KAZUK-GAPS (A12): keep an unfinished form on the server while it is typed (POST /api/v0/drafts/:key, about 1.5 s after
 *  the last change), and hand back what was kept the last time, from this device or another one. `enabled` false keeps
 *  nothing (for example while the record itself is saving fine). `clear` forgets it once the form is saved or discarded. */
export type Kept<T> = { data: T; updatedAt: string };

export function useFormDraft<T extends object>(key: string | null, value: T, { title, href, enabled, delay = 1500 }: { title: string; href: string; enabled: boolean; delay?: number }) {
  const [kept, setKept] = useState<Kept<T> | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState<"idle" | "keeping" | "kept" | "failed">("idle");
  const latest = useRef({ value, title, href });
  // The newest words for the timer below, kept after each render (react-hooks/refs: never written during render).
  useEffect(() => { latest.current = { value, title, href }; });
  useEffect(() => {
    if (!key) return;
    let gone = false;
    fetch(`/api/v0/drafts/${key}`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((x: { draft: Kept<T> | null } | null) => {
      if (!gone) { setKept(x?.draft ?? null); setLoaded(true); }
    }).catch(() => { if (!gone) setLoaded(true); });
    return () => { gone = true; };
  }, [key]);
  useEffect(() => {
    if (!key || !enabled || !loaded) return;
    const t = setTimeout(() => {
      setStatus("keeping");
      const { value: data, title: name, href: to } = latest.current;
      fetch(`/api/v0/drafts/${key}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: name, href: to, data }) })
        .then((r) => setStatus(r.ok ? "kept" : "failed")).catch(() => setStatus("failed"));
    }, delay);
    return () => clearTimeout(t);
  }, [key, enabled, loaded, value, delay]);
  const clear = useCallback(async () => {
    setKept(null); setStatus("idle");
    if (!key) return;
    await fetch(`/api/v0/drafts/${key}/clear`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => undefined);
  }, [key]);
  /** Stop offering the kept copy without forgetting it on the server (it is replaced by the next change). */
  const dismiss = useCallback(() => setKept(null), []);
  return { kept, loaded, status, clear, dismiss };
}
