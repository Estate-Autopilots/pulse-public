"use client";
// WORK-SPINE round 2 (owner, 10 Nov 2026: "Goals, projects, tasks … must update live … within ~1-2 s with no reload"):
// an open Work page asks /api/v0/work/changed whether what it shows (one project, one goal, one task, my work, or a list)
// changed since its last answer, and reads itself again when it did: the server parts refetch (router.refresh), and
// what the person is typing, scrolling or has open stays as it is. It asks every 1.5 s (every 3 s on the two lists, which
// move with every change in the company), only while the page is on screen; a hidden tab asks again when it is seen.
// A short question, not a held stream: over HTTP/1.1 a browser keeps at most 6 connections to a host, and each Pulse tab
// already holds two streams (the screen's and calls'). The page's own actions refresh it already; this is for everyone
// else's changes.
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";

export type LiveScope = "project" | "goal" | "task" | "me" | "projects" | "goals";

export function LiveWork({ scope, id }: { scope: LiveScope; id?: string | null }) {
  const router = useRouter();
  const [state, setState] = useState<"off" | "on">("off");
  // While the page is reading itself again it does not ask; a page told "changed" many times running (a busy company,
  // or a page whose own reading writes) asks less often, up to every 30 s, and settles back once things are quiet.
  const [reading, startReading] = useTransition();
  const busy = useRef(false);
  useEffect(() => { busy.current = reading; }, [reading]);
  useEffect(() => {
    const qs = new URLSearchParams({ scope }); if (id) qs.set("id", id);
    const base = scope === "projects" || scope === "goals" ? 3000 : 1500;
    let since = 0, timer = 0, asking = false, stopped = false, streak = 0;
    const ask = async () => {
      timer = 0;
      if (stopped || asking || document.visibilityState !== "visible") return;
      if (busy.current) { timer = window.setTimeout(() => void ask(), 500); return; }
      asking = true;
      try {
        const r = await fetch(`/api/v0/work/changed?${qs}&since=${since}`, { cache: "no-store" });
        if (r.status === 401 || r.status === 403 || r.status === 404) { stopped = true; setState("off"); return; }
        if (r.ok) {
          const a = await r.json() as { at: number; changed: boolean };
          if (since && a.changed) { streak++; startReading(() => router.refresh()); } else streak = 0;
          since = a.at; setState("on");
        }
      } catch { /* offline for a moment: ask again */ } finally { asking = false; }
      if (!stopped && !timer) timer = window.setTimeout(() => void ask(), Math.min(30000, base * 2 ** Math.max(0, streak - 2)));
    };
    const seen = () => { if (document.visibilityState === "visible" && !timer) void ask(); };
    void ask();
    document.addEventListener("visibilitychange", seen);
    return () => { stopped = true; window.clearTimeout(timer); document.removeEventListener("visibilitychange", seen); };
  }, [router, scope, id]);
  return <span hidden data-work-live={state} />;
}
