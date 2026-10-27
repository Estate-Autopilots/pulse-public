"use client";
import { Award, Plus, Trash2, X } from "lucide-react";
import { useState, type FormEvent } from "react";
import { post } from "../client";
import css from "../orgs.module.css";

type Badge = { id: string; title: string; note: string | null; from: string; by: string | null; on: string; carried: boolean; here: boolean };
type Highlight = { id: string; title: string; detail: string | null; from: string; on: string | null };
type Share = { org: string; name: string; current: boolean; profile: boolean; skills: boolean; badges: boolean; highlights: boolean };
export type Portable = { profile: { headline: string | null; about: string | null; skills: string[]; links: { label: string; url: string }[] }; orgSkills: string[]; badges: Badge[]; highlights: Highlight[]; shares: Share[] };
const SHARE_LABEL = { profile: "Headline and about", skills: "Skills", badges: "Badges", highlights: "Highlights" } as const;

export function ProfileView({ initial, error, tasks }: { initial: Portable | null; error: string | null; tasks: { id: string; title: string; on: string }[] }) {
  const [data, setData] = useState(initial);
  const [headline, setHeadline] = useState(initial?.profile.headline ?? ""); const [about, setAbout] = useState(initial?.profile.about ?? "");
  const [skills, setSkills] = useState<string[]>(initial?.profile.skills ?? []); const [skill, setSkill] = useState("");
  const [links, setLinks] = useState(initial?.profile.links ?? []); const [linkUrl, setLinkUrl] = useState("");
  const [note, setNote] = useState<{ tone: "ok" | "error"; text: string } | null>(error ? { tone: "error", text: error } : null);
  const [hTitle, setHTitle] = useState(""); const [hTask, setHTask] = useState("");
  const act = async (work: () => Promise<Portable>, ok?: string) => { setNote(null); try { setData(await work()); if (ok) setNote({ tone: "ok", text: ok }); } catch (e) { setNote({ tone: "error", text: e instanceof Error ? e.message : "That did not work" }); } };
  if (!data) return <div className={css.page}><p className={css.note}>Claim your Pulse handle first, on <a href="/orgs">Organisations</a>.</p></div>;
  const addSkill = () => { const s = skill.trim(); if (s && !skills.includes(s)) setSkills([...skills, s]); setSkill(""); };
  const save = (e: FormEvent) => { e.preventDefault(); void act(() => post<Portable>("account/profile", { headline, about, skills, links }), "Saved. It shows in each organisation you allow."); };
  const addHighlight = (e: FormEvent) => { e.preventDefault(); const body = hTask ? { taskId: hTask } : { title: hTitle }; setHTitle(""); setHTask(""); void act(() => post<Portable>("account/highlights", body), "Highlight added."); };
  const share = (s: Share, key: keyof typeof SHARE_LABEL) => act(() => post<Portable>("account/share", { ...s, [key]: !s[key] }));
  return <div className={css.page}>
    {note ? <p className={css.note} data-tone={note.tone} role={note.tone === "error" ? "alert" : "status"}>{note.text}</p> : null}
    <form className={`${css.card} ${css.form}`} onSubmit={save}>
      <label className={css.field}>Headline<input className={css.input} value={headline} onChange={(e) => setHeadline(e.target.value)} maxLength={120} placeholder="Video editor · reels and property walkthroughs" /></label>
      <label className={css.field}>About you<textarea className={css.textarea} value={about} onChange={(e) => setAbout(e.target.value)} maxLength={2000} /></label>
      <div className={css.field}>Skills
        <div className={css.chips}>{skills.map((s) => <span className={css.chip} key={s}>{s}<button type="button" aria-label={`Remove ${s}`} onClick={() => setSkills(skills.filter((x) => x !== s))}><X size={12} /></button></span>)}</div>
        <div className={css.row}><input className={css.input} value={skill} onChange={(e) => setSkill(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addSkill(); } }} placeholder="Add a skill and press Enter" maxLength={60} />
          {data.orgSkills.some((s) => !skills.includes(s)) ? <button type="button" className={css.btn} onClick={() => setSkills([...new Set([...skills, ...data.orgSkills])])}>Add my skills from here ({data.orgSkills.length})</button> : null}</div>
      </div>
      <div className={css.field}>Links <small>https only</small>
        <div className={css.chips}>{links.map((l) => <span className={css.chip} key={l.url}>{l.label || l.url}<button type="button" aria-label="Remove link" onClick={() => setLinks(links.filter((x) => x.url !== l.url))}><X size={12} /></button></span>)}</div>
        <div className={css.row}><input className={css.input} value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} placeholder="https://your-portfolio.example" />
          <button type="button" className={css.btn} disabled={!/^https:\/\/[^\s/]+\.\S+$/.test(linkUrl)} onClick={() => { setLinks([...links, { label: new URL(linkUrl).hostname, url: linkUrl }]); setLinkUrl(""); }}>Add link</button></div>
      </div>
      <div className={css.cardFoot}><button className={`${css.btn} ${css.primary}`}>Save profile</button></div>
    </form>

    <section className={css.section} aria-labelledby="badges-h">
      <div className={css.sectionHead}><h2 id="badges-h">Badges</h2><p>Given to you by the organisations you work with. Choose which travel.</p></div>
      {data.badges.length ? <div className={css.grid}>{data.badges.map((b) => <div className={css.badge} key={b.id}>
        <span className={css.badgeIcon} aria-hidden="true"><Award size={16} /></span>
        <div className={css.cardTitle}><b>{b.title}</b><small>{b.from}{b.by ? ` · from ${b.by}` : ""} · {b.on}</small>{b.note ? <small>{b.note}</small> : null}
          <label className={css.toggle}><input type="checkbox" checked={b.carried} onChange={() => act(() => post<Portable>(`account/badges/${b.id}`, { carried: !b.carried }))} />Carry it to my other organisations</label></div>
      </div>)}</div> : <p className={css.muted}>No badges yet. Leaders and managers give them from your profile in their organisation.</p>}
    </section>

    <section className={css.section} aria-labelledby="hl-h">
      <div className={css.sectionHead}><h2 id="hl-h">Highlights</h2><p>Work you are proud of. Only what you add here travels: a title, never the organisation&apos;s files or records.</p></div>
      <form className={`${css.card} ${css.form}`} onSubmit={addHighlight}>
        <div className={css.row}>
          {tasks.length ? <label className={css.field}>From your finished tasks here<select className={css.select} value={hTask} onChange={(e) => { setHTask(e.target.value); setHTitle(""); }}><option value="">Choose a task…</option>{tasks.map((t) => <option key={t.id} value={t.id}>{t.title} · {t.on}</option>)}</select></label> : null}
          <label className={css.field}>Or write it<input className={css.input} value={hTitle} onChange={(e) => { setHTitle(e.target.value); setHTask(""); }} maxLength={160} placeholder="Cut the Skyline launch film" /></label>
          <button className={css.btn} disabled={!hTask && hTitle.trim().length < 2}><Plus size={15} aria-hidden="true" />Add</button>
        </div>
      </form>
      {data.highlights.length ? <div className={css.table}>{data.highlights.map((h) => <div className={css.tr} key={h.id}><span><b>{h.title}</b> · {h.from}{h.on ? ` · ${h.on}` : ""}</span>
        <button type="button" className={`${css.btn} ${css.quiet}`} aria-label={`Remove ${h.title}`} onClick={() => act(() => post<Portable>(`account/highlights/${h.id}/remove`))}><Trash2 size={14} aria-hidden="true" /></button></div>)}</div> : null}
    </section>

    <section className={css.section} aria-labelledby="share-h">
      <div className={css.sectionHead}><h2 id="share-h">What each organisation sees</h2><p>Your profile shows on your People page there. Badges an organisation gave you always show in that organisation.</p></div>
      <div className={css.table}>{data.shares.map((s) => <div className={css.tr} key={s.org}><span><b>{s.name}</b>{s.current ? " · here" : ""}</span>
        {(Object.keys(SHARE_LABEL) as (keyof typeof SHARE_LABEL)[]).map((k) => <label className={css.toggle} key={k}><input type="checkbox" checked={s[k]} onChange={() => void share(s, k)} />{SHARE_LABEL[k]}</label>)}
      </div>)}</div>
    </section>
  </div>;
}
