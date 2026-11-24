import Link from "next/link";
import { MessagesSquare, Sparkles } from "lucide-react";
import { api } from "../lib/api";
import { AssistantQuiet, StepCardView, type StepCardData } from "../chats/step-cards";
import css from "./step-cards.module.css";

/** PM-BUILD-4 (KAZUK-PM-2 phases 3-4): the step cards waiting for the viewer. "Your assistant · Quick check for today"
 *  (2521: at most 3 of their own steps once a day, plus a step someone else waits on) with Done / Not yet and "Stop
 *  checking on me"; and "From your chats" (2520: what they wrote in a project's group, and "Were these finished too?").
 *  Only they see them; nothing shows when there are none. */
type Data = { cards: StepCardData[]; assistant: { quiet: boolean; endedWhy: string | null; today: { asked: number; answered: number } | null } };

export async function MyStepCards() {
  const r = (await api<Data>("step-cards")).data;
  const open = (r?.cards ?? []).filter((c) => c.state === "open");
  const checks = open.filter((c) => c.kind === "checkin"), chats = open.filter((c) => c.kind !== "checkin");
  const quiet = !!r?.assistant?.quiet;
  if (!checks.length && !chats.length) return null;
  return <>
    {checks.length ? <section className={css.box} aria-labelledby="my-checkins">
      <h2 id="my-checkins" className={css.head}><Sparkles size={16} aria-hidden="true" />Quick check for today<small>{checks.length}</small></h2>
      <p className={css.sub}>Your assistant asks; only you see these.</p>
      <ul className={css.list}>{checks.map((c, i) => <li key={c.id}>
        {c.project ? <p className={css.where}><Link href={`/tasks/projects/${c.projectId}`}>{c.project}</Link></p> : null}
        <StepCardView card={c} quiet={i > 0} />
      </li>)}</ul>
      <p className={css.foot}><AssistantQuiet quiet={quiet} /></p>
    </section> : null}
    {chats.length ? <section className={css.box} aria-labelledby="my-step-cards">
      <h2 id="my-step-cards" className={css.head}><MessagesSquare size={16} aria-hidden="true" />From your chats<small>{chats.length}</small></h2>
      <p className={css.sub}>Only you see these.</p>
      <ul className={css.list}>{chats.map((c, i) => <li key={c.id}>
        {c.project ? <p className={css.where}><Link href={`/tasks/projects/${c.projectId}`}>{c.project}</Link></p> : null}
        <StepCardView card={c} quiet={checks.length > 0 || i > 0} note={c.kind === "chat" && c.quote ? `You wrote “${c.quote}”` : "After the step you finished"} />
      </li>)}</ul>
    </section> : null}
  </>;
}
