"use client";
// XRAY-LINK (Learn): which tutorials this person has marked done. Kept in this browser only (localStorage), per signed-in
// person (the shell's <body data-viewer>), so two people sharing a computer each keep their own list.
import { Check, CircleCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { DONE_KEY, parseDone } from "../lib/learn.mjs";
import css from "./learn.module.css";

const key = () => `${DONE_KEY}:${document.body.dataset.viewer ?? "me"}`;
function read(): Set<string> {
  try { return parseDone(localStorage.getItem(key())); } catch { return new Set(); }
}

export function useDone() {
  const [done, setDone] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    const sync = () => setDone(read());
    sync();
    window.addEventListener("storage", sync);
    window.addEventListener("pulse:learn", sync);
    return () => { window.removeEventListener("storage", sync); window.removeEventListener("pulse:learn", sync); };
  }, []);
  const mark = useCallback((id: string, value: boolean) => {
    const next = read();
    if (value) next.add(id); else next.delete(id);
    try { localStorage.setItem(key(), JSON.stringify([...next])); } catch { /* private window: nothing to keep */ }
    window.dispatchEvent(new Event("pulse:learn"));
  }, []);
  return { done, mark };
}

/** "Mark as done" / "Done" for one tutorial. */
export function DoneButton({ id }: { id: string }) {
  const { done, mark } = useDone();
  const on = done.has(id);
  return <button type="button" className={`${css.done}${on ? ` ${css.doneOn}` : ""}`} aria-pressed={on} onClick={() => mark(id, !on)}>
    {on ? <><CircleCheck size={16} aria-hidden="true" />Done</> : <><Check size={16} aria-hidden="true" />Mark as done</>}
  </button>;
}

/** A small tick on a tutorial card once it is done. */
export function DoneTick({ id }: { id: string }) {
  const { done } = useDone();
  return done.has(id) ? <span className={css.tick} title="Done"><CircleCheck size={16} aria-label="Done" /></span> : null;
}

/** "3 of 10 done" for a set of tutorials, with a thin bar. */
export function Progress({ ids, label }: { ids: string[]; label?: string }) {
  const { done } = useDone();
  const n = ids.filter((id) => done.has(id)).length;
  return <div className={css.progress} aria-label={`${label ?? "Tutorials"}: ${n} of ${ids.length} done`}>
    <span>{n} of {ids.length} done</span>
    <span className={css.bar} aria-hidden="true"><i style={{ width: `${ids.length ? (100 * n) / ids.length : 0}%` }} /></span>
  </div>;
}
