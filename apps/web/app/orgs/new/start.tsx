"use client";
import { ArrowRight, Briefcase, Building2, CircleDashed, House, Megaphone, Stethoscope, Sun } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { arrive, post, type Moved } from "../client";
import css from "../orgs.module.css";

export type PackCard = { key: string; name: string; summary: string; examples: string; icon: string };
const ICONS: Record<string, typeof Sun> = { sun: Sun, "building-2": Building2, megaphone: Megaphone, briefcase: Briefcase, stethoscope: Stethoscope, "circle-dashed": CircleDashed, house: House };
const handleOf = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 30);

export function StartOrg({ packs, error, you }: { packs: PackCard[]; error: string | null; you: string }) {
  const [name, setName] = useState(""); const [handle, setHandle] = useState(""); const [touched, setTouched] = useState(false);
  const [pack, setPack] = useState(packs.find((p) => p.key === "neutral")?.key ?? packs[0]?.key ?? "");
  const [busy, setBusy] = useState(false); const [note, setNote] = useState<string | null>(error);
  const shown = touched ? handle : handleOf(name);
  const chosen = useMemo(() => packs.find((p) => p.key === pack), [packs, pack]);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setNote(null);
    try { arrive(await post<Moved>("account/start", { name, handle: shown, pack }), "/dashboard?welcome=1"); }
    catch (err) { setNote(err instanceof Error ? err.message : "Could not start it"); setBusy(false); }
  };
  return <form className={css.page} onSubmit={submit}>
    {note ? <p className={css.note} data-tone="error" role="alert">{note}</p> : null}
    <section className={`${css.card} ${css.form}`}>
      <div className={css.row}>
        <label className={css.field}>Organisation name<input className={css.input} value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={80} placeholder={you ? `${you.split(" ")[0]}'s Studio` : "Putig Solar"} autoFocus /></label>
        <label className={css.field}>Handle <small>how people find it</small><span className={css.prefix}><span>@</span><input className={css.input} value={shown} onChange={(e) => { setTouched(true); setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9._]/g, "")); }} minLength={3} maxLength={30} required autoCapitalize="none" spellCheck={false} /></span></label>
      </div>
    </section>
    <section className={css.section} aria-labelledby="pack-h">
      <div className={css.sectionHead}><h2 id="pack-h">Your industry</h2><p>Brings its words, roles and starter processes. You can change it later in Settings.</p></div>
      <div className={css.packs} role="group" aria-labelledby="pack-h">{packs.map((p) => { const Icon = ICONS[p.icon] ?? CircleDashed; return (
        <button type="button" key={p.key} className={css.pack} aria-pressed={pack === p.key} onClick={() => setPack(p.key)}>
          <Icon size={18} aria-hidden="true" /><b>{p.name}</b><small>{p.examples}</small></button>); })}</div>
    </section>
    <div className={css.cardFoot}>
      <button className={`${css.btn} ${css.primary}`} disabled={busy || name.trim().length < 2}>{busy ? "Starting…" : <>Start {name.trim() || "it"}<ArrowRight size={15} aria-hidden="true" /></>}</button>
      <span className={css.muted}>You become its owner{chosen ? `, set up as ${chosen.name.toLowerCase()}` : ""}. Nothing of your current organisation is copied.</span>
    </div>
  </form>;
}
