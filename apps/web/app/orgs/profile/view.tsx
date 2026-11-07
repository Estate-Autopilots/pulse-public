"use client";
import { Award, BriefcaseBusiness, FileText, Plus, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { post } from "../client";
import css from "../orgs.module.css";
import { SelectField } from "../../kit/select-field";
import { PhotoControls } from "../../records";
import { Avatar } from "../../ui";

type Badge = { id: string; title: string; note: string | null; from: string; by: string | null; on: string; carried: boolean; here: boolean };
type Highlight = { id: string; title: string; detail: string | null; from: string; on: string | null };
type Share = { org: string; name: string; current: boolean; profile: boolean; skills: boolean; badges: boolean; highlights: boolean; contact: boolean; career: boolean };
export type Education = { school: string; degree: string | null; from: string | null; to: string | null };
export type Certification = { name: string; issuer: string | null; on: string | null; url: string | null };
export type AccountProfile = {
  headline: string | null; about: string | null; skills: string[]; links: { label: string; url: string }[];
  pronouns?: string | null; location?: string | null; languages?: string[]; skillLevels?: Record<string, number>;
  education?: Education[]; certifications?: Certification[]; contactEmail?: string | null; contactPhone?: string | null;
};
export type Portable = { name?: string; handle?: string; me?: string; photoAt?: string | null; hasPhoto?: boolean; profile: AccountProfile; orgSkills: string[]; badges: Badge[]; highlights: Highlight[]; shares: Share[] };
const SHARE_LABEL = { profile: "Profile", skills: "Skills", badges: "Badges", highlights: "Highlights", contact: "Personal contact", career: "Career (roles and dates)" } as const;
export const LEVELS = ["", "Learning", "Working", "Strong", "Expert"] as const;

export function ProfileView({ initial, error, tasks }: { initial: Portable | null; error: string | null; tasks: { id: string; title: string; on: string }[] }) {
  const [data, setData] = useState(initial);
  const p = initial?.profile;
  const [name, setName] = useState(initial?.name ?? "");
  const [headline, setHeadline] = useState(p?.headline ?? ""); const [about, setAbout] = useState(p?.about ?? "");
  const [pronouns, setPronouns] = useState(p?.pronouns ?? ""); const [location, setLocation] = useState(p?.location ?? "");
  const [languages, setLanguages] = useState((p?.languages ?? []).join(", "));
  const [contactEmail, setContactEmail] = useState(p?.contactEmail ?? ""); const [contactPhone, setContactPhone] = useState(p?.contactPhone ?? "");
  const [skills, setSkills] = useState<string[]>(p?.skills ?? []); const [skill, setSkill] = useState("");
  const [levels, setLevels] = useState<Record<string, number>>(p?.skillLevels ?? {});
  const [links, setLinks] = useState(p?.links ?? []); const [linkUrl, setLinkUrl] = useState("");
  const [education, setEducation] = useState<Education[]>(p?.education ?? []);
  const [certs, setCerts] = useState<Certification[]>(p?.certifications ?? []);
  const [note, setNote] = useState<{ tone: "ok" | "error"; text: string } | null>(error ? { tone: "error", text: error } : null);
  const [hTitle, setHTitle] = useState(""); const [hTask, setHTask] = useState("");
  const act = async (work: () => Promise<Portable>, ok?: string) => { setNote(null); try { setData(await work()); if (ok) setNote({ tone: "ok", text: ok }); } catch (e) { setNote({ tone: "error", text: e instanceof Error ? e.message : "That did not work" }); } };
  if (!data) return <div className={css.page}><p className={css.note}>Claim your Pulse handle first, on <a href="/orgs">Organisations</a>.</p></div>;
  const addSkill = () => { const s = skill.trim(); if (s && !skills.includes(s)) setSkills([...skills, s]); setSkill(""); };
  const save = (e: FormEvent) => {
    e.preventDefault();
    void act(() => post<Portable>("account/profile", {
      name, headline, about, pronouns, location, contactEmail, contactPhone, skills, links,
      languages: languages.split(",").map((x) => x.trim()).filter(Boolean),
      skillLevels: Object.fromEntries(Object.entries(levels).filter(([k, v]) => skills.includes(k) && v > 0)),
      education: education.filter((x) => x.school.trim().length >= 2), certifications: certs.filter((x) => x.name.trim().length >= 2),
    }), "Saved. Your photo and details now show the same in every company you are in.");
  };
  const addHighlight = (e: FormEvent) => { e.preventDefault(); const body = hTask ? { taskId: hTask } : { title: hTitle }; setHTitle(""); setHTask(""); void act(() => post<Portable>("account/highlights", body), "Highlight added."); };
  const share = (s: Share, key: keyof typeof SHARE_LABEL) => act(() => post<Portable>("account/share", { org: s.org, [key]: !s[key] }));
  const setEdu = (i: number, k: keyof Education, v: string) => setEducation(education.map((x, j) => j === i ? { ...x, [k]: v } : x));
  const setCert = (i: number, k: keyof Certification, v: string) => setCerts(certs.map((x, j) => j === i ? { ...x, [k]: v } : x));
  return <div className={css.page}>
    {note ? <p className={css.note} data-tone={note.tone} role={note.tone === "error" ? "alert" : "status"}>{note.text}</p> : null}
    <p>Kept once on your Pulse account (@{data.handle ?? "you"}) and shown in every company you work with. Each company keeps its own work record: role, team, manager, pay, attendance and documents. <a href="/orgs#acct-h">Change your @handle →</a></p>
    <div className={css.cardFoot}>
      <Link className={css.btn} href="/orgs/career"><BriefcaseBusiness size={15} aria-hidden="true" />My career</Link>
      <Link className={css.btn} href="/orgs/resume"><FileText size={15} aria-hidden="true" />Build my resume</Link>
    </div>
    <form className={`${css.card} ${css.form}`} onSubmit={save} aria-label="Your profile">
      <div className={css.row} data-profile-photo="">
        {data.me ? <Avatar name={name || data.name || "You"} id={data.me} photoAt={data.photoAt ?? null} size={64} /> : null}
        {data.me ? <PhotoControls personId={data.me} hasPhoto={!!data.hasPhoto} name={name || data.name} /> : null}
        <small className={css.muted}>Your photo changes in every company at once.</small>
      </div>
      <div className={css.row}>
        <label className={css.field}>Name<input className={css.input} value={name} onChange={(e) => setName(e.target.value)} minLength={2} maxLength={120} required /></label>
        <label className={css.field}>Pronouns <small>(optional)</small><input className={css.input} value={pronouns} onChange={(e) => setPronouns(e.target.value)} maxLength={30} placeholder="she/her" /></label>
      </div>
      <label className={css.field}>Headline<input className={css.input} value={headline} onChange={(e) => setHeadline(e.target.value)} maxLength={120} placeholder="Video editor · reels and property walkthroughs" /></label>
      <label className={css.field}>About you<textarea className={css.textarea} value={about} onChange={(e) => setAbout(e.target.value)} maxLength={2000} /></label>
      <div className={css.row}>
        <label className={css.field}>Location<input className={css.input} value={location} onChange={(e) => setLocation(e.target.value)} maxLength={120} placeholder="City, country" /></label>
        <label className={css.field}>Languages <small>(comma separated)</small><input className={css.input} value={languages} onChange={(e) => setLanguages(e.target.value)} placeholder="English, Hindi" /></label>
      </div>
      <div className={css.row}>
        <label className={css.field}>Personal e-mail <small>(only companies you tick below see it)</small><input className={css.input} type="email" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} maxLength={254} /></label>
        <label className={css.field}>Personal phone<input className={css.input} type="tel" value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} maxLength={24} /></label>
      </div>
      <div className={css.field}>Skills <small>with your level</small>
        <div className={css.chips}>{skills.map((s) => <span className={css.chip} key={s}>{s}
          <SelectField aria-label={`Level for ${s}`} value={levels[s] ?? 0} onChange={(e) => setLevels({ ...levels, [s]: Number(e.target.value) })}>
            {LEVELS.map((l, i) => <option key={i} value={i}>{l || "Level"}</option>)}</SelectField>
          <button type="button" aria-label={`Remove ${s}`} onClick={() => setSkills(skills.filter((x) => x !== s))}><X size={12} /></button></span>)}</div>
        <div className={css.row}><input className={css.input} value={skill} onChange={(e) => setSkill(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addSkill(); } }} placeholder="Add a skill and press Enter" maxLength={60} />
          {data.orgSkills.some((s) => !skills.includes(s)) ? <button type="button" className={css.btn} onClick={() => setSkills([...new Set([...skills, ...data.orgSkills])])}>Add my skills from here ({data.orgSkills.length})</button> : null}</div>
      </div>
      <div className={css.field}>Links <small>https only</small>
        <div className={css.chips}>{links.map((l) => <span className={css.chip} key={l.url}>{l.label || l.url}<button type="button" aria-label="Remove link" onClick={() => setLinks(links.filter((x) => x.url !== l.url))}><X size={12} /></button></span>)}</div>
        <div className={css.row}><input className={css.input} value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} placeholder="https://your-portfolio.example" />
          <button type="button" className={css.btn} disabled={!/^https:\/\/[^\s/]+\.\S+$/.test(linkUrl)} onClick={() => { setLinks([...links, { label: new URL(linkUrl).hostname, url: linkUrl }]); setLinkUrl(""); }}>Add link</button></div>
      </div>
      <div className={css.field}>Education
        {education.map((x, i) => <div className={css.row} key={i}>
          <input className={css.input} aria-label="School or college" value={x.school} onChange={(e) => setEdu(i, "school", e.target.value)} placeholder="School or college" maxLength={120} />
          <input className={css.input} aria-label="Degree or course" value={x.degree ?? ""} onChange={(e) => setEdu(i, "degree", e.target.value)} placeholder="Degree or course" maxLength={120} />
          <input className={css.input} aria-label="From year" value={x.from ?? ""} onChange={(e) => setEdu(i, "from", e.target.value)} placeholder="From" maxLength={10} style={{ maxWidth: 90 }} />
          <input className={css.input} aria-label="To year" value={x.to ?? ""} onChange={(e) => setEdu(i, "to", e.target.value)} placeholder="To" maxLength={10} style={{ maxWidth: 90 }} />
          <button type="button" className={`${css.btn} ${css.quiet}`} aria-label="Remove education" onClick={() => setEducation(education.filter((_, j) => j !== i))}><Trash2 size={14} aria-hidden="true" /></button>
        </div>)}
        <div><button type="button" className={css.btn} onClick={() => setEducation([...education, { school: "", degree: "", from: "", to: "" }])}><Plus size={14} aria-hidden="true" />Add education</button></div>
      </div>
      <div className={css.field}>Certifications
        {certs.map((x, i) => <div className={css.row} key={i}>
          <input className={css.input} aria-label="Certification" value={x.name} onChange={(e) => setCert(i, "name", e.target.value)} placeholder="Certification" maxLength={120} />
          <input className={css.input} aria-label="Issued by" value={x.issuer ?? ""} onChange={(e) => setCert(i, "issuer", e.target.value)} placeholder="Issued by" maxLength={120} />
          <input className={css.input} aria-label="Year" value={x.on ?? ""} onChange={(e) => setCert(i, "on", e.target.value)} placeholder="Year" maxLength={10} style={{ maxWidth: 90 }} />
          <button type="button" className={`${css.btn} ${css.quiet}`} aria-label="Remove certification" onClick={() => setCerts(certs.filter((_, j) => j !== i))}><Trash2 size={14} aria-hidden="true" /></button>
        </div>)}
        <div><button type="button" className={css.btn} onClick={() => setCerts([...certs, { name: "", issuer: "", on: "", url: null }])}><Plus size={14} aria-hidden="true" />Add certification</button></div>
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
          {tasks.length ? <label className={css.field}>From your finished tasks here<SelectField className={css.select} value={hTask} onChange={(e) => { setHTask(e.target.value); setHTitle(""); }}><option value="">Choose a task…</option>{tasks.map((t) => <option key={t.id} value={t.id}>{t.title} · {t.on}</option>)}</SelectField></label> : null}
          <label className={css.field}>Or write it<input className={css.input} value={hTitle} onChange={(e) => { setHTitle(e.target.value); setHTask(""); }} maxLength={160} placeholder="Cut the Skyline launch film" /></label>
          <button className={css.btn} disabled={!hTask && hTitle.trim().length < 2}><Plus size={15} aria-hidden="true" />Add</button>
        </div>
      </form>
      {data.highlights.length ? <div className={css.table}>{data.highlights.map((h) => <div className={css.tr} key={h.id}><span><b>{h.title}</b> · {h.from}{h.on ? ` · ${h.on}` : ""}</span>
        <button type="button" className={`${css.btn} ${css.quiet}`} aria-label={`Remove ${h.title}`} onClick={() => act(() => post<Portable>(`account/highlights/${h.id}/remove`))}><Trash2 size={14} aria-hidden="true" /></button></div>)}</div> : null}
    </section>

    <section className={css.section} aria-labelledby="share-h">
      <div className={css.sectionHead}><h2 id="share-h">What each organisation sees</h2><p>Your photo and name show everywhere. Personal contact and your career are off until you tick them. Pay, HR notes and a company&apos;s tasks never travel.</p></div>
      <div className={css.table}>{data.shares.map((s) => <div className={css.tr} key={s.org}><span><b>{s.name}</b>{s.current ? " · here" : ""}</span>
        {(Object.keys(SHARE_LABEL) as (keyof typeof SHARE_LABEL)[]).map((k) => <label className={css.toggle} key={k}><input type="checkbox" checked={!!s[k]} onChange={() => void share(s, k)} />{SHARE_LABEL[k]}</label>)}
      </div>)}</div>
    </section>
  </div>;
}
