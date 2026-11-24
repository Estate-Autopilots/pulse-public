import Link from "next/link";
import { Panel } from "../ui";
import { plural } from "../lib/format";
import css from "./overview.module.css";
import d from "./delivery-desk.module.css";

/** PM-BUILD-4 (KAZUK-PM-2 phase 6, leadership): going live at risk, what the company waits on its clients for (never
 *  the team's lateness), and the last 30 days' date moves by reason, with whose side each reason is. Data:
 *  projects/health → ceo.delivery (pulse.pm_leadership, 2522). */
export type Delivery = {
  goLive: { id: string; title: string; lead: string | null; live: string; health: string; word: string; reason: string | null }[];
  moves: { reason: string; label: string; side: string; moves: number; steps: number; days: number; projects: number }[];
  clientWaits: { open: number; projects: number; days: number; oldest: string | null } | null;
};
/** Pulse's own date-move reasons (projects/run-client.tsx), for a template without its own list. */
const REASON_LABEL: Record<string, string> = { client_delay: "Client delay", our_delay: "Our delay", client_paused: "Client paused", ea_hold: "Our hold", scope_change: "Scope change", other: "Other" };
const DAY = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
const short = (x: string) => DAY.format(new Date(`${x}T00:00:00Z`));

export function DeliveryDesk({ data, today }: { data: Delivery; today: string }) {
  const most = Math.max(1, ...data.moves.map((m) => m.moves));
  const w = data.clientWaits;
  return <Panel title="Delivery" sub="Going live, client waits and date moves (30 days)">
    <section aria-label="Going live at risk" className={d.block}>
      <h4 className={d.head}>Going live at risk</h4>
      {data.goLive.length ? <ul className={css.needs}>{data.goLive.map((g) => <li key={g.id}>
        <Link href={`/tasks/projects/${g.id}`} className={css.needTitle}>{g.title}</Link>
        <span className={css.needMeta}>{g.live < today ? `Ads live was planned for ${short(g.live)}` : `Ads live ${short(g.live)}`} · {g.word}{g.reason ? `: ${g.reason}` : ""}{g.lead ? ` · ${g.lead}` : ""}</span>
      </li>)}</ul> : <p className={css.empty}>Nothing going live in the next 14 days is at risk.</p>}
    </section>
    <section aria-label="Waiting on clients" className={d.block}>
      <h4 className={d.head}>Waiting on clients</h4>
      {w && w.open ? <p className={d.line}><b>{plural(w.open, "input")}</b> asked of clients on {plural(w.projects, "project")}{w.days ? `, ${plural(w.days, "working day")} of waiting in all` : ""}{w.oldest ? (w.oldest === today ? ", asked today" : `, the oldest asked ${short(w.oldest)}`) : ""}. Not counted as the team being late.</p>
        : <p className={css.empty}>No client input asked and still waiting.</p>}
    </section>
    <section aria-label="Date moves by reason" className={d.block}>
      <h4 className={d.head}>Date moves by reason</h4>
      {data.moves.length ? <ul className={d.bars}>{data.moves.map((m) => <li key={m.reason}>
        <span className={d.label}>{m.label === m.reason ? REASON_LABEL[m.reason] ?? m.reason.replace(/_/g, " ") : m.label}</span>
        <span className={d.bar} data-side={m.side === "client" ? "client" : "us"} role="img" aria-label={m.side === "client" ? "the client's side" : "our side"}><i style={{ width: `${Math.round((m.moves / most) * 100)}%` }} /></span>
        <span className={d.num}>{plural(m.moves, "move")}<small> · {plural(m.steps, "step")}</small></span>
      </li>)}</ul> : <p className={css.empty}>No dates moved in the last 30 days.</p>}
      {data.moves.length ? <p className={d.legend}><i data-side="client" aria-hidden="true" /><span>Client</span><i data-side="us" aria-hidden="true" /><span>Us</span></p> : null}
    </section>
  </Panel>;
}
