import { headers } from "next/headers";
import { hostHeader } from "../../../lib/host-mode.mjs";
import css from "./timeline.module.css";

// KAZUK (28 Oct 2026): a project's timeline for its client, signed out. The link is the only key (Pulse stores its
// hash; a new link or Stop ends it). It shows the stages and planned steps with dates and what is done: no people,
// notes, money or internal chats.
type Step = { step: string; stage: string; title: string; start: string | null; due: string | null; done: string | null; state: "done" | "doing" | "planned" };
type Seen = { project: string; company: string; kickoff: string | null; today: string; paused: boolean; stages: { n: number; key: string; label: string }[]; steps: Step[] };
const API = process.env.PULSE_API_URL ?? "http://127.0.0.1:8081";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = (d: string | null) => { if (!d) return "—"; const x = new Date(`${d}T00:00:00Z`); return `${x.getUTCDate()} ${MONTHS[x.getUTCMonth()]}`; };

async function read(token: string): Promise<Seen | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  try {
    const r = await fetch(`${API}/api/v0/share/project/${token}`, { cache: "no-store", headers: hostHeader(await headers()), signal: AbortSignal.timeout(10000) });
    return r.ok ? (await r.json()) as Seen : null;
  } catch { return null; }
}

export default async function ClientTimeline({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const s = await read(token);
  if (!s) return <div className={css.page}><h1>This link is not valid</h1><p className={css.muted}>It may have been replaced. Ask your project team for the current link.</p></div>;
  const done = s.steps.filter((x) => x.state === "done").length;
  return <div className={css.page}>
    <p className={css.muted}>{s.company}</p>
    <h1>{s.project}</h1>
    <p className={css.muted}>{s.kickoff ? `Kick-off ${day(s.kickoff)} · ` : ""}{done} of {s.steps.length} steps done{s.paused ? " · paused" : ""} · as of {day(s.today)}</p>
    {s.stages.map((st) => { const rows = s.steps.filter((x) => x.stage === st.key); if (!rows.length) return null;
      const d = rows.filter((x) => x.state === "done").length;
      return <section key={st.key} className={css.stage}>
        <h2><span>{st.n}</span>{st.label}<small>{d} of {rows.length} done</small></h2>
        <ul>{rows.map((x) => <li key={x.step} data-state={x.state}>
          <b>{x.title}</b>
          <span>{x.state === "done" ? `Done ${day(x.done)}` : x.state === "doing" ? `In progress · expected ${day(x.due)}` : x.due ? `Expected ${day(x.start)}${x.start && x.start !== x.due ? ` – ${day(x.due)}` : ""}` : "Ongoing"}</span>
        </li>)}</ul>
      </section>; })}
  </div>;
}
