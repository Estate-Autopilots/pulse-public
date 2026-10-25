"use client";
// PULSE-HQ: the browser side: one POST helper, a debounced autosave and the sheet's open/close.
import { useCallback, useEffect, useRef, useState } from "react";

export async function hqPost<T = { ok: true }>(path: string, body: unknown = {}): Promise<T> {
  const r = await fetch(`/api/v0/hq/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(typeof data?.error === "string" ? data.error : typeof data?.message === "string" ? data.message : "That did not save. Try again.");
  return data as T;
}

export type SaveState = "idle" | "saving" | "saved" | "error";

/** Saves the changed fields a moment after the last edit; changes made while a save runs go in the next one. */
export function useAutosave(path: string, delay = 700) {
  const [state, setState] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<Record<string, unknown>>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flush = useCallback(async () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    const body = pending.current; pending.current = {};
    if (!Object.keys(body).length) return;
    setState("saving");
    try { await hqPost(path, body); setState("saved"); setError(null); }
    catch (e) { pending.current = { ...body, ...pending.current }; setState("error"); setError(e instanceof Error ? e.message : "Not saved"); }
  }, [path]);
  const queue = useCallback((fields: Record<string, unknown>) => {
    pending.current = { ...pending.current, ...fields };
    setState("saving");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { void flush(); }, delay);
  }, [delay, flush]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  useEffect(() => {
    const leave = () => { if (Object.keys(pending.current).length) void flush(); };
    window.addEventListener("pagehide", leave);
    return () => { window.removeEventListener("pagehide", leave); leave(); };
  }, [flush]);
  return { state, error, queue, flush };
}

/** A <dialog> that opens as a modal while `open` is true and reports Escape and backdrop clicks. */
export function useDialog(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const box = ref.current; if (!box) return;
    if (open && !box.open) box.showModal();
    if (!open && box.open) box.close();
  }, [open]);
  useEffect(() => {
    const box = ref.current; if (!box) return;
    const cancel = (e: Event) => { e.preventDefault(); onClose(); };
    const click = (e: MouseEvent) => { if (e.target === box) onClose(); };
    box.addEventListener("cancel", cancel); box.addEventListener("click", click);
    return () => { box.removeEventListener("cancel", cancel); box.removeEventListener("click", click); };
  }, [onClose]);
  return ref;
}

/** Reads the page again a moment after the last change (one read for a burst of quick edits). */
export function useSoonRefresh(refresh: () => void, delay = 500) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return useCallback(() => { if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(refresh, delay); }, [refresh, delay]);
}
