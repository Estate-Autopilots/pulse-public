"use client";
import Link from "next/link";
import { Hourglass } from "lucide-react";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import type { WaitingChain as Chain } from "../../../../packages/sdk-ts/src/v0";
import { AiBadge } from "../kit/ai-badge";
import { Avatar, Skeleton, styles } from "../ui";
import { UnblockButton } from "./client";
import tp from "./[id]/task-page.module.css";
import css from "./waiting-chain.module.css";

type Step = Omit<Chain["steps"][number], "answer" | "answeredAt"> & { answer: string | null; answeredAt: string | null };
const date = (iso: string, zone: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: zone });
export function nextAction(step: Step, zone: string) {
  if (step.next === "closed") return "closed";
  if (step.answer === "not_mine") return "not theirs";
  if (step.answer === "on_it") return step.answeredAt ? `on it since ${date(step.answeredAt, zone)}` : "on it";
  return "no answer yet";
}
export function WaitingRows({ chain, company, now, zone, taskId, removable = [] }: { chain: Chain; company: string | null; now: number; zone: string; taskId: string; removable?: string[] }) {
  return <>
    {chain.steps.length ? <ol className={css.list}>{chain.steps.map((step) => {
      const days = Math.max(0, Math.floor((now - Date.parse(step.since)) / 86400000));
      return <li key={step.linkId} className={css.row} style={{ "--depth": Math.max(0, step.depth - 1) } as CSSProperties}>
        <div className={css.body}>{step.blocker.hidden ? <span>A task you can&apos;t open</span> : <Link href={`/tasks/${encodeURIComponent(step.blocker.id)}`}>{step.blocker.title}</Link>}
          <div className={css.meta}>{step.actor ? <span className={css.person}><Avatar name={step.actor.name} id={step.actor.id} photoAt={step.actor.photoAt} ai={step.actor.ai} size={20} />{step.actor.name}{step.actor.ai ? <AiBadge /> : null}</span> : <span>Nobody owns it yet</span>}
            {company && step.company.name !== company ? <span className={css.company}>{step.company.name}</span> : null}
            <span>{days ? `waiting ${days} ${days === 1 ? "day" : "days"}` : "waiting less than a day"}</span><span>{nextAction(step, zone)}</span>
          </div>
        </div>
        {step.fromId === taskId && removable.includes(step.blocker.id) ? <UnblockButton taskId={taskId} blockerId={step.blocker.id} /> : null}
      </li>;
    })}</ol> : null}
    {chain.declared.map((step, i) => <p className={tp.quiet} key={`${step.kind}:${step.since}:${i}`}>Waiting on the client since {date(step.since, zone)}</p>)}
    {chain.more > 0 ? <p className={tp.quiet}>+{chain.more} more</p> : null}
    {!chain.steps.length && !chain.declared.length && !chain.more ? <p className={tp.quiet}>Nothing is waiting here. Linked blockers and client waits appear here when added.</p> : null}
  </>;
}
export function WaitingChain({ taskId, company, now, zone, removable, children }: { taskId: string; company: string | null; now: number; zone: string; removable: string[]; children?: ReactNode }) {
  const [result, setResult] = useState<{ data?: Chain; error?: string } | null>(null), [attempt, retry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch(`/api/v0/tasks/${encodeURIComponent(taskId)}/waiting`, { cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
        if (!response.ok) throw new Error("Unavailable");
        const data: Chain = await response.json();
        if (!controller.signal.aborted) setResult({ data });
      } catch {
        if (!controller.signal.aborted) setResult({ error: navigator.onLine ? "The waiting chain could not load. Try again." : "You’re offline. Reconnect to load the waiting chain." });
      }
    }
    void load();
    const reconnect = () => { setResult(null); retry((n) => n + 1); };
    window.addEventListener("online", reconnect);
    return () => { controller.abort(); window.removeEventListener("online", reconnect); };
  }, [taskId, attempt, now]);
  return <section className={tp.block} aria-label="Waiting chain" aria-busy={!result}>
    <h2 className={tp.blockHead}><Hourglass size={15} aria-hidden="true" />Waiting chain</h2>
    {!result ? <div role="status" aria-label="Loading waiting chain"><Skeleton /><Skeleton width="70%" /></div> : result.error ? <div role="alert"><p className={tp.quiet}>{result.error}</p><button type="button" className={styles.btn} onClick={() => { setResult(null); retry((n) => n + 1); }}>Try again</button></div>
      : result.data ? <WaitingRows chain={result.data} company={company} now={now} zone={zone} taskId={taskId} removable={removable} /> : null}
    {children}
  </section>;
}
