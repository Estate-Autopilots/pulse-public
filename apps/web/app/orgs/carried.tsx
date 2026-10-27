"use client";
// ORG: a person's profile from their Pulse account, as this organisation may see it (People → a person → Overview), and
// "Give a badge" for the leaders, HR and the person's manager.
import { Award, ExternalLink, Sparkles } from "lucide-react";
import { useState, type FormEvent } from "react";
import { post } from "./client";
import css from "./orgs.module.css";

export type Carried = { handle: string; self: boolean; headline: string | null; about: string | null; links: { label: string; url: string }[] | null; skills: string[] | null;
  badges: { title: string; note: string | null; from: string; by: string | null; on: string; here: boolean }[]; highlights: { title: string; detail: string | null; from: string; on: string | null }[] };

export function CarriedProfile({ person, card: initial, canGive }: { person: string; card: Carried; canGive: boolean }) {
  const [card, setCard] = useState(initial);
  const [title, setTitle] = useState(""); const [note, setNote] = useState(""); const [busy, setBusy] = useState(false); const [msg, setMsg] = useState<string | null>(null);
  const give = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setMsg(null);
    try {
      await post(`people/${person}/badges`, { title, note });
      const r = await fetch(`/api/v0/people/${person}/carried`, { cache: "no-store" }); if (r.ok) setCard((await r.json()).card);
      setTitle(""); setNote(""); setMsg("Badge given. It travels with them.");
    } catch (err) { setMsg(err instanceof Error ? err.message : "Could not give the badge"); } finally { setBusy(false); }
  };
  return <div className={css.page} style={{ padding: 0 }}>
    <section className={`${css.card} ${css.carried}`}>
      <div className={css.sectionHead}><h2>@{card.handle}</h2>{card.self ? <a href="/orgs/profile" className={css.btn}>Edit what travels</a> : <p>From their Pulse account</p>}</div>
      {card.headline ? <b>{card.headline}</b> : null}
      {card.about ? <p className={css.muted} style={{ whiteSpace: "pre-line" }}>{card.about}</p> : null}
      {card.skills?.length ? <div className={css.chips}>{card.skills.map((s) => <span className={css.chip} key={s} style={{ paddingRight: 10 }}>{s}</span>)}</div> : null}
      {card.links?.length ? <div className={css.chips}>{card.links.map((l) => <a key={l.url} className={css.chip} style={{ paddingRight: 10, textDecoration: "none", color: "inherit" }} href={l.url} target="_blank" rel="noreferrer noopener">{l.label}<ExternalLink size={12} aria-hidden="true" /></a>)}</div> : null}
      {!card.headline && !card.about && !card.skills?.length && !card.badges.length && !card.highlights.length ? <p className={css.muted}><Sparkles size={13} aria-hidden="true" /> Nothing shared yet.</p> : null}
    </section>
    {card.badges.length ? <div className={css.grid}>{card.badges.map((b, i) => <div className={css.badge} key={i}><span className={css.badgeIcon} aria-hidden="true"><Award size={16} /></span>
      <div className={css.cardTitle}><b>{b.title}</b><small>{b.here ? "Given here" : b.from}{b.by ? ` · ${b.by}` : ""} · {b.on}</small>{b.note ? <small>{b.note}</small> : null}</div></div>)}</div> : null}
    {card.highlights.length ? <div className={css.table}>{card.highlights.map((h, i) => <div className={css.tr} key={i}><span><b>{h.title}</b> · {h.from}{h.on ? ` · ${h.on}` : ""}</span></div>)}</div> : null}
    {canGive ? <form className={`${css.card} ${css.form}`} onSubmit={give}>
      <b>Give a badge</b>
      <div className={css.row}>
        <label className={css.field}>Badge<input className={css.input} value={title} onChange={(e) => setTitle(e.target.value)} minLength={2} maxLength={80} required placeholder="Fast turnaround" /></label>
        <label className={css.field}>Why <small>(optional)</small><input className={css.input} value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="Twelve reels in a week" /></label>
        <button className={`${css.btn} ${css.primary}`} disabled={busy}><Award size={15} aria-hidden="true" />{busy ? "Giving…" : "Give"}</button>
      </div>
      {msg ? <p className={css.muted} role="status">{msg}</p> : null}
    </form> : null}
  </div>;
}
