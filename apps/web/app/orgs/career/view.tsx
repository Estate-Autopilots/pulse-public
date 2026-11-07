"use client";
import { ArrowRightLeft, Award, BriefcaseBusiness, FileSignature, Sparkles } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { arrive, post, type Moved } from "../client";
import css from "../orgs.module.css";

export type Stint = {
  org: string; company: string; handle: string | null; kind: string; role: string | null; from: string | null; to: string | null; current: boolean;
  how: "left" | "moved" | null; movedTo: string | null; team?: string | null; employment?: string | null;
  tasksDone?: number; projects?: number; deliveries?: number;
  highlights?: { title: string; detail: string | null; on: string | null }[]; badges?: { title: string; note: string | null; by: string | null; on: string }[];
  contracts?: { key: string; title: string; kind: string; status: string; role: string; startsOn: string | null; endsOn: string | null }[];
};
export type Career = { career: Stint[]; moves: { id: string; org: string; from: string; title: string | null; at: string }[] };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const month = (d: string | null) => { if (!d) return "?"; const [y, m] = d.split("-"); return m ? `${MONTHS[Number(m) - 1]} ${y}` : y; };
const plural = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
export const span = (s: { from: string | null; to: string | null; current: boolean }) => `${month(s.from)} – ${s.current ? "now" : month(s.to)}`;

export function CareerView({ data, error }: { data: Career | null; error: string | null }) {
  const [busy, setBusy] = useState<string | null>(null); const [msg, setMsg] = useState<string | null>(error);
  if (!data) return <div className={css.page}><p className={css.note} data-tone="error">{msg ?? "Your career could not be read."}</p></div>;
  const accept = async (id: string) => { setBusy(id); setMsg(null); try { arrive(await post<Moved>("account/accept", { id })); } catch (e) { setMsg(e instanceof Error ? e.message : "That did not work"); setBusy(null); } };
  const total = (k: "tasksDone" | "projects" | "deliveries") => data.career.reduce((n, s) => n + (s[k] ?? 0), 0);
  return <div className={css.page}>
    {msg ? <p className={css.note} data-tone="error" role="alert">{msg}</p> : null}
    {data.moves.length ? <section className={css.section} aria-labelledby="moves-h">
      <div className={css.sectionHead}><h2 id="moves-h">A move waiting for you</h2><p>Your profile goes with you at once; the new company starts a fresh work record and your old seat becomes alumni with its history kept.</p></div>
      <div className={css.table}>{data.moves.map((m) => <div className={css.tr} key={m.id}><span><b>{m.org}</b> · from {m.from}{m.title ? ` · as ${m.title}` : ""}</span>
        <button type="button" className={`${css.btn} ${css.primary}`} disabled={!!busy} onClick={() => void accept(m.id)}><ArrowRightLeft size={15} aria-hidden="true" />{busy === m.id ? "Moving…" : "Accept and move"}</button></div>)}</div>
    </section> : null}
    <div className={css.cardFoot}>
      <span className={css.pill}>{data.career.length} {data.career.length === 1 ? "company" : "companies"}</span>
      <span className={css.pill}>{plural(total("tasksDone"), "task", "tasks")} done</span>
      <span className={css.pill}>{plural(total("projects"), "project", "projects")}</span>
      <span className={css.pill}>{plural(total("deliveries"), "delivery", "deliveries")}</span>
    </div>
    <ol className={css.section} style={{ listStyle: "none", padding: 0, margin: 0 }} aria-label="Career timeline">
      {data.career.map((s) => <li key={`${s.org}-${s.from}`} className={`${css.card} ${css.form}`} data-current={s.current ? "" : undefined} data-stint="">
        <div className={css.sectionHead}>
          <h2><BriefcaseBusiness size={15} aria-hidden="true" /> {s.role ?? "Member"} · {s.company}</h2>
          <p>{span(s)}{s.current ? "" : s.how === "moved" ? ` · moved to ${s.movedTo ?? "another company"}` : " · alumni"}</p>
        </div>
        <p className={css.muted}>{[s.team, s.employment?.replace("_", " "), s.kind !== "staff" ? s.kind : null].filter(Boolean).join(" · ") || " "}</p>
        <div className={css.cardFoot}>
          <span className={css.pill}>{plural(s.tasksDone ?? 0, "task", "tasks")} done</span><span className={css.pill}>{plural(s.projects ?? 0, "project", "projects")}</span><span className={css.pill}>{plural(s.deliveries ?? 0, "delivery", "deliveries")}</span>
        </div>
        {s.highlights?.length || s.badges?.length ? <div className={css.chips}>
          {s.badges?.map((b, i) => <span className={css.chip} key={`b${i}`} style={{ paddingRight: 10 }}><Award size={12} aria-hidden="true" />{b.title}</span>)}
          {s.highlights?.map((h, i) => <span className={css.chip} key={`h${i}`} style={{ paddingRight: 10 }}><Sparkles size={12} aria-hidden="true" />{h.title}</span>)}
        </div> : null}
        {s.contracts?.length ? <div className={css.table}>{s.contracts.map((c) => <div className={css.tr} key={c.key}>
          <span><FileSignature size={13} aria-hidden="true" /> <Link href="/contracts">{c.title}</Link> · {c.kind.replace("_", " ")} · {c.status}</span>
          <small className={css.muted}>{c.startsOn ? month(c.startsOn) : ""}{c.endsOn ? ` – ${month(c.endsOn)}` : ""}</small></div>)}</div> : null}
      </li>)}
    </ol>
    <p className={css.muted}>Pay, attendance, HR notes and a company&apos;s own tasks stay inside that company. Counts here are yours alone; companies see roles and dates only when you publish your career to them on <Link href="/orgs/profile#share-h">your profile</Link>.</p>
  </div>;
}
