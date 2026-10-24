"use client";
// TASKS-4B: "Reviews 37" in the top bar on every page while finished work waits for the viewer's review, so the queue is
// obvious wherever they are; red once something has waited more than a day. Kept apart from the task page's code so the
// root layout loads only this.
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ClipboardCheck } from "lucide-react";
import css from "./review-chip.module.css";

/** "Reviews 37" in the top bar on every page while anything waits; red once something has waited past the nudge. */
export function ReviewChip() {
  const [n, setN] = useState<{ n: number; oldestHours: number | null } | null>(null);
  const load = useCallback(() => { void fetch("/api/v0/tasks/reviews/count").then((r) => r.ok ? r.json() : null).then((x) => { if (x) setN(x); }).catch(() => {}); }, []);
  useEffect(() => {
    load();
    const every = window.setInterval(load, 120000);
    window.addEventListener("pulse:data-changed", load); window.addEventListener("pulse:notices-changed", load);
    return () => { window.clearInterval(every); window.removeEventListener("pulse:data-changed", load); window.removeEventListener("pulse:notices-changed", load); };
  }, [load]);
  const late = (n?.oldestHours ?? 0) >= 24;
  if (!n?.n) return null;
  return <Link href="/tasks?view=reviews" className={css.chip} data-late={late ? "" : undefined} aria-label={`${n.n} finished task${n.n === 1 ? "" : "s"} waiting for your review`} title={late ? "Some have waited more than a day" : "Waiting for your review"}>
    <ClipboardCheck size={15} aria-hidden="true" /><span className={css.chipWord}>Reviews</span><b>{n.n}</b>
  </Link>;
}

