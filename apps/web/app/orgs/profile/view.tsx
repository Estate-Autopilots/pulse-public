"use client";
// PROFILE-2 (owner, 17 Nov 2026: "My profile looks extremely idiotic ... beautiful people and company profiles have a strong
// header in the top half ... make account settings simple and out of the way"). The person's own profile, the same in
// every company they are in:
//   - a header that carries the page: cover, a big photo, name, one line about them, where they are, and two actions
//     (Edit profile, Share); account things (username, sign-in, career, resume) sit in a quiet "More" menu;
//   - the body reads like a good profile (LinkedIn, Read.cv, GitHub): About, Skills (edit in place), Work (one line per
//     real company: its name and the person's role there), Education and certifications only when there are some;
//   - the side: contact and links, and "Who sees what" folded away (companies only see what the person ticks).
// Test, demo and archived companies are not listed (migration 2205). Editing is one drawer with the whole form.
import { BriefcaseBusiness, Building2, ChevronDown, Ellipsis, FileText, GraduationCap, Globe, Languages, Link2, Mail, MapPin, Pencil, Phone, Plus, ShieldCheck, Trash2, UserRound, X } from "lucide-react";
import Link from "next/link";
import { useState, type CSSProperties, type ReactNode } from "react";
import { openCompany, post } from "../client";
import { PhotoControls } from "../../records";
import { Avatar, hueStyle } from "../../ui";
import { roleWord } from "../../lib/founder.mjs";
import { orgHue, orgInitials } from "../labels";
import { Menu } from "../../kit/menu";
import { SelectField } from "../../kit/select-field";
import { Drawer, DrawerFooter, DrawerSection } from "../../kit/drawer";
import { toast } from "../../kit/dialogs";
import { SkillPicker } from "../../skill-picker";
import { ShareMenu } from "../../share-menu";
import css from "./profile.module.css";

type Badge = { id: string; title: string; note: string | null; from: string; by: string | null; on: string; carried: boolean; here: boolean };
type Highlight = { id: string; title: string; detail: string | null; from: string; on: string | null };
type Share = { org: string; name: string; current: boolean; profile: boolean; skills: boolean; badges: boolean; highlights: boolean; contact: boolean; career: boolean };
export type Education = { school: string; degree: string | null; from: string | null; to: string | null };
export type Certification = { name: string; issuer: string | null; on: string | null; url: string | null };
export type AccountProfile = {
  headline: string | null; about: string | null; skills: string[]; links: { label: string; url: string }[];
  pronouns?: string | null; location?: string | null; languages?: string[]; skillLevels?: Record<string, number>;
  education?: Education[]; certifications?: Certification[]; contactEmail?: string | null; contactPhone?: string | null;
  skillRefs?: Record<string, string | null>;
};
// IDENTITY-UNIFY (1746): the one @handle, the old usernames that still work, and any company where someone else has it.
export type Names = { handle: string; old: string[]; kept: { company: string; username: string }[] };
export type Portable = { name?: string; handle?: string; me?: string; photoAt?: string | null; hasPhoto?: boolean; profile: AccountProfile; orgSkills: string[]; badges: Badge[]; highlights: Highlight[]; shares: Share[]; names?: Names | null };
const SHARE_LABEL = { profile: "Profile", skills: "Skills", badges: "Badges", highlights: "Highlights", contact: "Contact", career: "Work history" } as const;
export const LEVELS = ["", "Learning", "Working", "Strong", "Expert"] as const;
/** GAP-FOUNDER-VIEW (PM-07): the person's role in one company (that company's own record of their job title). */
export type Role = { org: string; company: string; role: string | null; kind: string; access?: string | null };

const years = (from?: string | null, to?: string | null) => [from, to].filter(Boolean).join(" – ");

export function ProfileView({ initial, error, tasks, roles = [] }: { initial: Portable | null; error: string | null; tasks: { id: string; title: string; on: string }[]; roles?: Role[] }) {
  const [data, setData] = useState(initial);
  const [editing, setEditing] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  if (!data) return <div className={css.page}><p className={css.note} role="alert">{error ?? "Claim your Pulse username first, on Your companies."}</p></div>;
  const names = initial?.names ?? null;
  const p = data.profile;
  const name = data.name || "You";
  const handle = names?.handle ?? data.handle ?? null;
  const roleHere = roles.find((r) => r.role)?.role ?? null;
  const headline = p.headline || (roleHere && roles[0] ? `${roleHere} at ${roles[0].company}` : null);
  const act = async (work: () => Promise<Portable>, ok?: string) => {
    try { const next = await work(); setData(next); if (ok) toast.success(ok); return true; }
    catch (e) { toast.error(e instanceof Error ? e.message : "That did not work. Try again."); return false; }
  };
  const saveSkills = (skills: string[]) => act(() => post<Portable>("account/profile", { skills }), "Skills saved in every company you are in.");
  const share = (s: Share, key: keyof typeof SHARE_LABEL) => act(() => post<Portable>("account/share", { org: s.org, [key]: !s[key] }));
  const about = (p.about ?? "").trim();
  const longAbout = about.length > 640;
  const edu = p.education ?? [], certs = p.certifications ?? [];
  const contact = [p.contactEmail, p.contactPhone].some(Boolean);
  const meta: { icon: ReactNode; text: string }[] = [];
  if (p.location) meta.push({ icon: <MapPin size={14} aria-hidden="true" />, text: p.location });
  if (p.pronouns) meta.push({ icon: <UserRound size={14} aria-hidden="true" />, text: p.pronouns });
  if (handle) meta.push({ icon: null, text: `@${handle}` });
  if (roles.length) meta.push({ icon: <Building2 size={14} aria-hidden="true" />, text: roles.length === 1 ? roles[0].company : `${roles.length} companies` });

  return <div className={css.page} data-profile-page="">
    <section className={css.hero} style={hueStyle(name)} aria-label={name} data-profile-hero="" data-page-header="">
      <h1 className={css.srOnly}>Your profile</h1>
      <div className={css.cover} aria-hidden="true" />
      <div className={css.heroBody}>
        <div className={css.photo}>
          <Avatar name={name} id={data.me} photoAt={data.photoAt ?? null} size={112} className={css.avatar} />
        </div>
        <div className={css.who}>
          <h2 className={css.name}>{name}</h2>
          {headline ? <p className={css.headline}>{headline}</p> : <button type="button" className={css.addLine} onClick={() => setEditing(true)}><Plus size={14} aria-hidden="true" />Add one line about you</button>}
          {meta.length ? <ul className={css.meta}>{meta.map((m, i) => <li key={m.text} data-last={i === meta.length - 1 && roles.length ? "" : undefined}>{m.icon}<span>{m.text}</span></li>)}</ul> : null}
        </div>
        <div className={css.heroActions}>
          <button type="button" className={css.primary} onClick={() => setEditing(true)}><Pencil size={15} aria-hidden="true" />Edit profile</button>
          <ShareMenu className={css.secondary} />
          <Menu label="More" buttonLabel="More for your profile" title="More" className={`${css.secondary} ${css.iconOnly}`} items={[
            { key: "career", label: "My career", icon: <BriefcaseBusiness size={15} aria-hidden="true" />, href: "/orgs/career" },
            { key: "resume", label: "Make my resume", icon: <FileText size={15} aria-hidden="true" />, href: "/orgs/resume" },
            { key: "sep", label: "", separator: true },
            { key: "account", label: "Account settings", hint: handle ? `@${handle}` : undefined, icon: <ShieldCheck size={15} aria-hidden="true" />, href: "/settings?tab=account&part=access" },
          ]}><Ellipsis size={16} aria-hidden="true" /></Menu>
        </div>
      </div>
    </section>

    <div className={css.grid}>
      <div className={css.main}>
        <section className={css.card} aria-labelledby="about-h">
          <div className={css.cardHead}><h2 id="about-h">About</h2>{about ? <button type="button" className={css.ghost} onClick={() => setEditing(true)} aria-label="Edit about"><Pencil size={14} aria-hidden="true" /></button> : null}</div>
          {about ? <>
            <p className={css.about} data-clamp={longAbout && !aboutOpen ? "" : undefined}>{about}</p>
            {longAbout ? <button type="button" className={css.more} onClick={() => setAboutOpen(!aboutOpen)} aria-expanded={aboutOpen}>{aboutOpen ? "Show less" : "Read more"}<ChevronDown size={14} aria-hidden="true" data-up={aboutOpen ? "" : undefined} /></button> : null}
          </> : <button type="button" className={css.emptyAction} onClick={() => setEditing(true)}><Plus size={15} aria-hidden="true" />Say what you do and what you are good at</button>}
        </section>

        <section className={css.card} aria-labelledby="skills-h">
          <div className={css.cardHead}><h2 id="skills-h">Skills</h2></div>
          <SkillPicker skills={p.skills} canEdit role={roleHere ?? p.headline} onSave={saveSkills} />
          {data.orgSkills.some((s) => !p.skills.some((x) => x.toLowerCase() === s.toLowerCase())) ? <button type="button" className={css.more}
            onClick={() => void saveSkills([...p.skills, ...data.orgSkills.filter((s) => !p.skills.some((x) => x.toLowerCase() === s.toLowerCase()))])}>
            <Plus size={14} aria-hidden="true" />Add the {data.orgSkills.length} skills this company lists for you</button> : null}
        </section>

        <section className={css.card} aria-labelledby="work-h">
          <div className={css.cardHead}><h2 id="work-h">Work</h2></div>
          {roles.length ? <ul className={css.work} data-designations="">{roles.map((r) => <li key={r.org}>
            <button type="button" className={css.workRow} onClick={() => void openCompany(r.org, r.company).catch(() => undefined)} aria-label={`Open ${r.company}`}>
              <span className={css.logo} style={{ "--org-hue": orgHue(r.company) } as CSSProperties} aria-hidden="true">{orgInitials(r.company)}</span>
              <span className={css.workText}><b>{roleWord(r.role, r.kind, r.access)}</b><small>{r.company}</small></span>
              <span className={css.open}>Open</span>
            </button></li>)}</ul> : <p className={css.muted}>When you join a company on Pulse, your role there shows here.</p>}
          <p className={css.foot}>Each company sets your job title there.</p>
        </section>

        {data.highlights.length || data.badges.length ? <section className={css.card} aria-labelledby="hl-h">
          <div className={css.cardHead}><h2 id="hl-h">Highlights</h2></div>
          <ul className={css.list}>
            {data.highlights.map((h) => <li key={h.id}><span className={css.listIcon} aria-hidden="true">★</span><span><b>{h.title}</b><small>{[h.from, h.on].filter(Boolean).join(" · ")}</small></span></li>)}
            {data.badges.map((b) => <li key={b.id}><span className={css.listIcon} aria-hidden="true">🏅</span><span><b>{b.title}</b><small>{[b.from, b.by ? `from ${b.by}` : null].filter(Boolean).join(" · ")}</small></span></li>)}
          </ul>
        </section> : null}
      </div>

      <aside className={css.side}>
        <section className={css.card} aria-labelledby="contact-h">
          <div className={css.cardHead}><h2 id="contact-h">Contact</h2></div>
          <ul className={css.facts}>
            {p.contactEmail ? <li><Mail size={15} aria-hidden="true" /><a href={`mailto:${p.contactEmail}`}>{p.contactEmail}</a></li> : null}
            {p.contactPhone ? <li><Phone size={15} aria-hidden="true" /><a href={`tel:${p.contactPhone}`}>{p.contactPhone}</a></li> : null}
            {(p.links ?? []).map((l) => <li key={l.url}><Globe size={15} aria-hidden="true" /><a href={l.url} target="_blank" rel="noreferrer">{l.label || l.url}</a></li>)}
            {(p.languages ?? []).length ? <li><Languages size={15} aria-hidden="true" /><span>{(p.languages ?? []).join(", ")}</span></li> : null}
          </ul>
          {!contact && !(p.links ?? []).length && !(p.languages ?? []).length ? <button type="button" className={css.emptyAction} onClick={() => setEditing(true)}><Plus size={15} aria-hidden="true" />Add a way to reach you</button>
            : <p className={css.foot}>Only companies you allow see your contact.</p>}
        </section>

        {edu.length ? <section className={css.card} aria-labelledby="edu-h">
          <div className={css.cardHead}><h2 id="edu-h">Education</h2></div>
          <ul className={css.list}>{edu.map((x, i) => <li key={i}><span className={css.listIcon} aria-hidden="true"><GraduationCap size={16} /></span><span><b>{x.school}</b><small>{[x.degree, years(x.from, x.to)].filter(Boolean).join(" · ")}</small></span></li>)}</ul>
        </section> : null}
        {certs.length ? <section className={css.card} aria-labelledby="cert-h">
          <div className={css.cardHead}><h2 id="cert-h">Certifications</h2></div>
          <ul className={css.list}>{certs.map((x, i) => <li key={i}><span className={css.listIcon} aria-hidden="true"><ShieldCheck size={16} /></span><span><b>{x.name}</b><small>{[x.issuer, x.on].filter(Boolean).join(" · ")}</small></span></li>)}</ul>
        </section> : null}
        <details className={`${css.card} ${css.fold}`} data-who-sees="">
          <summary><span><b>Who sees what</b><small>{data.shares.length ? `${data.shares.length} ${data.shares.length === 1 ? "company" : "companies"}` : "No companies yet"}</small></span><ChevronDown size={16} aria-hidden="true" /></summary>
          <p className={css.foot}>Pick what each company can see about you. Your photo and name show everywhere; pay, HR notes and a company&apos;s own work never travel.</p>
          <ul className={css.shares}>{data.shares.map((s) => <li key={s.org}>
            <b>{s.name}{s.current ? <small> · open now</small> : null}</b>
            <span className={css.toggles}>{(Object.keys(SHARE_LABEL) as (keyof typeof SHARE_LABEL)[]).map((k) =>
              <label key={k} className={css.toggle} data-on={s[k] ? "" : undefined}><input type="checkbox" checked={!!s[k]} onChange={() => void share(s, k)} />{SHARE_LABEL[k]}</label>)}</span>
          </li>)}</ul>
        </details>

        {/* IDENTITY-UNIFY's facts, kept quiet: the one @handle, old usernames that still work, a company where it differs. */}
        <section className={css.card} aria-labelledby="acct-h" data-identity="">
          <div className={css.cardHead}><h2 id="acct-h">Account</h2></div>
          <p className={css.muted}>{handle ? <>Your username is <b>@{handle}</b>, the same in every company. Sign in with it or your e-mail.</> : "Sign in with your e-mail."}</p>
          {names?.old.length ? <p className={css.foot} data-identity-old="">Your old usernames still sign you in: {names.old.map((o) => `@${o}`).join(", ")}.</p> : null}
          {(names?.kept ?? []).map((k) => <p key={k.company} className={css.foot} data-identity-kept="">In {k.company}, someone else already uses @{names?.handle}, so you are still @{k.username} there.</p>)}
          <Link className={css.textLink} href="/settings?tab=account&part=access">Account settings</Link>
        </section>
      </aside>
    </div>

    {editing ? <EditProfile data={data} tasks={tasks} onClose={() => setEditing(false)} onSaved={(next) => { setData(next); setEditing(false); }} /> : null}
  </div>;
}

/** The whole form in one drawer: who you are, about, contact and links, education, certifications, a highlight. */
function EditProfile({ data, tasks, onClose, onSaved }: { data: Portable; tasks: { id: string; title: string; on: string }[]; onClose: () => void; onSaved: (next: Portable) => void }) {
  const p = data.profile;
  const [name, setName] = useState(data.name ?? "");
  const [headline, setHeadline] = useState(p.headline ?? ""); const [about, setAbout] = useState(p.about ?? "");
  const [pronouns, setPronouns] = useState(p.pronouns ?? ""); const [location, setLocation] = useState(p.location ?? "");
  const [languages, setLanguages] = useState((p.languages ?? []).join(", "));
  const [contactEmail, setContactEmail] = useState(p.contactEmail ?? ""); const [contactPhone, setContactPhone] = useState(p.contactPhone ?? "");
  const [links, setLinks] = useState(p.links ?? []); const [linkUrl, setLinkUrl] = useState("");
  const [education, setEducation] = useState<Education[]>(p.education ?? []);
  const [certs, setCerts] = useState<Certification[]>(p.certifications ?? []);
  const [hTitle, setHTitle] = useState(""); const [hTask, setHTask] = useState("");
  const [busy, setBusy] = useState(false); const [status, setStatus] = useState<string | null>(null);
  const setEdu = (i: number, k: keyof Education, v: string) => setEducation(education.map((x, j) => j === i ? { ...x, [k]: v } : x));
  const setCert = (i: number, k: keyof Certification, v: string) => setCerts(certs.map((x, j) => j === i ? { ...x, [k]: v } : x));
  const linkOk = /^https:\/\/[^\s/]+\.\S+$/.test(linkUrl);
  const save = async () => {
    if (name.trim().length < 2) { setStatus("Write your name (2 letters or more)."); return; }
    setBusy(true); setStatus(null);
    try {
      let next = await post<Portable>("account/profile", {
        name, headline, about, pronouns, location, contactEmail, contactPhone, links, skills: p.skills,
        languages: languages.split(",").map((x) => x.trim()).filter(Boolean),
        education: education.filter((x) => x.school.trim().length >= 2), certifications: certs.filter((x) => x.name.trim().length >= 2),
      });
      if (hTask || hTitle.trim().length >= 2) next = await post<Portable>("account/highlights", hTask ? { taskId: hTask } : { title: hTitle });
      toast.success("Saved. Your profile looks the same in every company you are in.");
      onSaved(next);
    } catch (e) { setStatus(e instanceof Error ? e.message : "That did not save. Try again."); }
    finally { setBusy(false); }
  };
  return <Drawer title="Edit profile" size="lg" onClose={onClose} footer={<DrawerFooter status={status}
    primary={<button type="button" className={css.primary} onClick={() => void save()} disabled={busy}>{busy ? "Saving…" : "Save profile"}</button>}>
    <button type="button" className={css.secondary} onClick={onClose} disabled={busy}>Cancel</button></DrawerFooter>}>
    <DrawerSection title="Photo">
      <div className={css.photoRow}>{data.me ? <Avatar name={name || "You"} id={data.me} photoAt={data.photoAt ?? null} size={64} /> : null}
        {data.me ? <PhotoControls personId={data.me} hasPhoto={!!data.hasPhoto} name={name} /> : null}
        <small className={css.muted}>One photo in every company.</small></div>
    </DrawerSection>
    <DrawerSection title="You">
      <div className={css.formGrid}>
        <label className={css.field}>Name<input className={css.input} value={name} onChange={(e) => setName(e.target.value)} minLength={2} maxLength={120} required /></label>
        <label className={css.field}>Pronouns<input className={css.input} value={pronouns} onChange={(e) => setPronouns(e.target.value)} maxLength={30} placeholder="she/her (optional)" /></label>
        <label className={`${css.field} ${css.wide}`}>One line about you<input className={css.input} value={headline} onChange={(e) => setHeadline(e.target.value)} maxLength={120} placeholder="Video editor · reels and property walkthroughs" /></label>
        <label className={`${css.field} ${css.wide}`}>About<textarea className={css.textarea} value={about} onChange={(e) => setAbout(e.target.value)} maxLength={2000} rows={5} placeholder="What you do, what you are good at, what you want to work on" /></label>
        <label className={css.field}>City<input className={css.input} value={location} onChange={(e) => setLocation(e.target.value)} maxLength={120} placeholder="City, country" /></label>
        <label className={css.field}>Languages<input className={css.input} value={languages} onChange={(e) => setLanguages(e.target.value)} placeholder="English, Hindi" /></label>
      </div>
    </DrawerSection>
    <DrawerSection title="Contact and links" help="Companies see your contact only when you tick Contact for them under Who sees what.">
      <div className={css.formGrid}>
        <label className={css.field}>Personal e-mail<input className={css.input} type="email" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} maxLength={254} /></label>
        <label className={css.field}>Personal phone<input className={css.input} type="tel" value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} maxLength={24} /></label>
      </div>
      {links.length ? <ul className={css.editList}>{links.map((l) => <li key={l.url}><Link2 size={14} aria-hidden="true" /><span>{l.label || l.url}</span>
        <button type="button" className={css.ghost} aria-label={`Remove ${l.label || l.url}`} onClick={() => setLinks(links.filter((x) => x.url !== l.url))}><X size={14} aria-hidden="true" /></button></li>)}</ul> : null}
      <div className={css.inline}><input className={css.input} value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} placeholder="https://your-portfolio.example" aria-label="Add a link" />
        <button type="button" className={css.secondary} disabled={!linkOk} onClick={() => { setLinks([...links, { label: new URL(linkUrl).hostname, url: linkUrl }]); setLinkUrl(""); }}>Add link</button></div>
    </DrawerSection>
    <DrawerSection title="Education">
      {education.map((x, i) => <div className={css.rowEdit} key={i}>
        <input className={css.input} aria-label="School or college" value={x.school} onChange={(e) => setEdu(i, "school", e.target.value)} placeholder="School or college" maxLength={120} />
        <input className={css.input} aria-label="Degree or course" value={x.degree ?? ""} onChange={(e) => setEdu(i, "degree", e.target.value)} placeholder="Degree or course" maxLength={120} />
        <input className={`${css.input} ${css.year}`} aria-label="From year" value={x.from ?? ""} onChange={(e) => setEdu(i, "from", e.target.value)} placeholder="From" maxLength={10} />
        <input className={`${css.input} ${css.year}`} aria-label="To year" value={x.to ?? ""} onChange={(e) => setEdu(i, "to", e.target.value)} placeholder="To" maxLength={10} />
        <button type="button" className={css.ghost} aria-label="Remove education" onClick={() => setEducation(education.filter((_, j) => j !== i))}><Trash2 size={14} aria-hidden="true" /></button>
      </div>)}
      <button type="button" className={css.more} onClick={() => setEducation([...education, { school: "", degree: "", from: "", to: "" }])}><Plus size={14} aria-hidden="true" />Add education</button>
    </DrawerSection>
    <DrawerSection title="Certifications">
      {certs.map((x, i) => <div className={css.rowEdit} key={i}>
        <input className={css.input} aria-label="Certification" value={x.name} onChange={(e) => setCert(i, "name", e.target.value)} placeholder="Certification" maxLength={120} />
        <input className={css.input} aria-label="Issued by" value={x.issuer ?? ""} onChange={(e) => setCert(i, "issuer", e.target.value)} placeholder="Issued by" maxLength={120} />
        <input className={`${css.input} ${css.year}`} aria-label="Year" value={x.on ?? ""} onChange={(e) => setCert(i, "on", e.target.value)} placeholder="Year" maxLength={10} />
        <button type="button" className={css.ghost} aria-label="Remove certification" onClick={() => setCerts(certs.filter((_, j) => j !== i))}><Trash2 size={14} aria-hidden="true" /></button>
      </div>)}
      <button type="button" className={css.more} onClick={() => setCerts([...certs, { name: "", issuer: "", on: "", url: null }])}><Plus size={14} aria-hidden="true" />Add certification</button>
    </DrawerSection>
    <DrawerSection title="Add a highlight" help="Work you are proud of. Only the title travels, never a company's files.">
      <div className={css.formGrid}>
        {tasks.length ? <label className={css.field}>From your finished tasks<SelectField className={css.input} value={hTask} onChange={(e) => { setHTask(e.target.value); setHTitle(""); }}>
          <option value="">Choose a task…</option>{tasks.map((t) => <option key={t.id} value={t.id}>{t.title} · {t.on}</option>)}</SelectField></label> : null}
        <label className={css.field}>Or write it<input className={css.input} value={hTitle} onChange={(e) => { setHTitle(e.target.value); setHTask(""); }} maxLength={160} placeholder="Cut the Skyline launch film" /></label>
      </div>
      {data.highlights.length ? <ul className={css.editList}>{data.highlights.map((h) => <li key={h.id}><span>★</span><span>{h.title}</span>
        <button type="button" className={css.ghost} aria-label={`Remove ${h.title}`} onClick={() => void post<Portable>(`account/highlights/${h.id}/remove`).then(onSaved).catch(() => toast.error("That did not work. Try again."))}><Trash2 size={14} aria-hidden="true" /></button></li>)}</ul> : null}
    </DrawerSection>
  </Drawer>;
}
