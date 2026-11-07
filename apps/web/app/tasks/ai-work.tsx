"use client";
// AI-TASKS (owner, 25 Oct 2026): a task given to an AI employee says what the AI is doing with it (working on it now,
// waiting for someone, sent for review), its plan with the steps it ticked, whom it asked, and what its runs cost; the
// page reads it again every few seconds while it works. Its comments, files and sub-tasks are on the task like anyone's.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Bot, Check, Circle, Hourglass, Loader2, PauseCircle, Send } from "lucide-react";
import { Avatar } from "../ui";
import { plural } from "../lib/format";
import type { AiWork } from "./types";
import css from "./ai-work.module.css";

const ago = (iso: string | null | undefined, now: number) => {
  if (!iso) return "";
  const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60000));
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};
const first = (name: string | null | undefined) => String(name ?? "").split(" ")[0];
const tokens = (n: number) => n >= 1000 ? `${Math.round(n / 100) / 10}k tokens` : `${n} tokens`;

/** What it is doing, in words. */
export function aiLine(ai: AiWork, now: number, zone = "Asia/Kolkata") {
  const name = first(ai.name);
  if (ai.off) return { icon: "off", text: `${name} is switched off for tasks: its manager or an admin turns it back on, or give the task to someone else.` };
  if (ai.runtime?.state === "out_of_quota" && ai.phase !== "in_review" && ai.phase !== "stopped")
    return { icon: "wait", text: `${name}'s AI is out of quota${ai.runtime.until ? ` until ${new Date(ai.runtime.until).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: zone })}` : ""}; the work waits and nothing is lost.` };
  if (ai.running) return { icon: "run", text: `${name} is working on it now.` };
  switch (ai.phase) {
    case "queued": return { icon: "run", text: ai.note ?? `${name} picks it up within a minute.` };
    case "returned": return { icon: "run", text: `${name} has your note and picks it up within a minute.` };
    case "waiting": return { icon: "wait", text: `${name} is waiting for ${ai.waitingOn ?? "an answer"}. Answer on the task (or in your direct message with ${name}) and it carries on.` };
    case "in_review": return { icon: "review", text: `${name} sent it for review${ai.submittedAt ? ` ${ago(ai.submittedAt, now)}` : ""}. Accept it, or return it with a note and ${name} carries on.` };
    case "stopped": return { icon: "done", text: `${name} worked on this task.` };
    default: return { icon: "run", text: ai.note ?? `${name} is on it${ai.updatedAt ? ` (last update ${ago(ai.updatedAt, now)})` : ""}. It looks at its open tasks every working day.` };
  }
}

export function AiAtWork({ ai: initial, taskId, zone }: { ai: AiWork; taskId: string; zone: string }) {
  const router = useRouter();
  const [ai, setAi] = useState(initial), [from, setFrom] = useState(initial);
  const [now, setNow] = useState(() => Date.now());
  // A refreshed page (after a run) brings a newer state: it becomes the one shown.
  if (from !== initial) { setFrom(initial); setAi(initial); }
  // While it works (or is about to), read its state every 8 seconds; when a run ends, the page reloads its comments and files.
  const busy = ai.running || ai.queued || ai.phase === "queued" || ai.phase === "returned";
  useEffect(() => {
    if (!busy) return;
    let alive = true;
    const t = setInterval(async () => {
      const r = await fetch(`/api/v0/tasks/${encodeURIComponent(taskId)}/ai`).then((x) => x.ok ? x.json() : null).catch(() => null);
      if (!alive || !r?.ai) return;
      setNow(Date.now());
      const was = ai.runs; setAi(r.ai);
      if (r.ai.runs !== was || (!r.ai.running && !r.ai.queued)) router.refresh();
    }, 8000);
    return () => { alive = false; clearInterval(t); };
  }, [busy, taskId, ai.runs, router]);
  const l = aiLine(ai, now, zone), done = ai.plan.filter((s) => s.done).length;
  const Icon = l.icon === "run" ? (ai.running ? Loader2 : Bot) : l.icon === "wait" ? Hourglass : l.icon === "review" ? Send : l.icon === "off" ? PauseCircle : Check;
  return <section className={css.card} aria-label={`${ai.name} on this task`} data-phase={ai.running ? "running" : ai.phase} aria-live="polite">
    <div className={css.head}>
      <Avatar name={ai.name} id={ai.agentId} size={32} ai />
      <div className={css.headText}>
        <b><Link href={`/people/ai/${encodeURIComponent(ai.agentId)}`}>{ai.name}</Link><span className={css.badge}>AI employee</span>{ai.title ? <span className={css.role}>{ai.title}</span> : null}</b>
        <span className={css.state}><Icon size={15} aria-hidden="true" className={ai.running ? css.spin : undefined} />{l.text}</span>
      </div>
    </div>
    {ai.plan.length ? <div className={css.plan}>
      <div className={css.planHead}><span>Its plan</span><small>{done} of {ai.plan.length} done</small></div>
      <ol>{ai.plan.map((s, i) => <li key={i} data-done={s.done ? "" : undefined}>{s.done ? <Check size={14} aria-hidden="true" /> : <Circle size={14} aria-hidden="true" />}<span>{s.label}</span></li>)}</ol>
    </div> : null}
    {ai.asks.length ? <p className={css.meta}>Asked: {ai.asks.map((a) => `${first(a.to)} (${a.via === "direct" ? "direct message" : "on the task"}, ${a.answered ? "answered" : "waiting"})`).join(" · ")}</p> : null}
    <p className={css.meta}>{ai.runs ? `${plural(ai.runs, "run")} · ${tokens(ai.tokens)}${ai.lastRun ? ` · last ${ago(ai.lastRun.at, now)}${ai.lastRun.state === "error" ? " (it went wrong; it says so on the task)" : ""}` : ""}` : "No run yet"} · A person reviews everything it does.</p>
  </section>;
}
