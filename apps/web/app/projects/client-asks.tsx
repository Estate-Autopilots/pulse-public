import { Inbox } from "lucide-react";
import { api } from "../lib/api";
import { day } from "./pm-shared";
import { ClientAskActions } from "./client-asks-client";
import css from "./pm-project.module.css";

/** PM-BUILD-4 (KAZUK-PM-2 phase 3; 2520): what the project needs from its client, counted apart from the team's work.
 *  Each open client step with how long it has waited since the lead asked; "Copy the request" gives the lead the drafted
 *  words to send in the client's group themselves (Vitals OS sends nothing), and "Mark as asked" starts the wait. */
type Asks = { today: string; canAsk: boolean; client: string | null; draft: string | null;
  items: { id: string; code: string | null; title: string; due: string | null; asked: string | null; days: number }[] };

export async function ClientAsks({ projectId }: { projectId: string }) {
  const d = (await api<Asks>(`projects/${encodeURIComponent(projectId)}/client-asks`)).data;
  if (!d || !d.items.length) return null;
  const notAsked = d.items.filter((x) => !x.asked);
  return <section className={css.sideCard} aria-label="We need from the client">
    <h3><Inbox size={16} aria-hidden="true" />We need from the client<small className={css.count}>{d.items.length}</small></h3>
    <p className={css.sideNote}>Only the client can give these. Time waiting on them is never the team being late.</p>
    <ul className={css.asks}>{d.items.slice(0, 6).map((x) => <li key={x.id}>
      <b className={css.askTitle}>{x.title}</b>
      <span className={css.askMeta} data-tone={x.asked ? "client" : undefined}>{x.asked ? (x.asked === d.today ? "Asked today · waiting on the client" : `Asked on ${day(x.asked)} · waiting ${x.days} working ${x.days === 1 ? "day" : "days"}`)
        : `Not asked yet${x.due ? ` · needed by ${day(x.due)}` : ""}`}</span>
    </li>)}</ul>
    {d.items.length > 6 ? <p className={css.sideNote}>and {d.items.length - 6} more</p> : null}
    {d.canAsk && notAsked.length && d.draft ? <ClientAskActions projectId={projectId} draft={d.draft} taskIds={notAsked.map((x) => x.id)} />
      : !notAsked.length ? <p className={css.sideNote}>All asked. When the client sends it, mark the step done and the waiting time stops.</p> : null}
  </section>;
}
