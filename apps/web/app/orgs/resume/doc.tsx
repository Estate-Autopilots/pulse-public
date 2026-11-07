// PROFILE-UNIFY (1683): the resume itself, one layout for the builder's preview, its PDF (the browser's print to PDF,
// with the print rules in resume.module.css) and the person's public link (/accept/cv/<token>).
import css from "./resume.module.css";

export type ResumeData = {
  name: string; headline?: string | null; pronouns?: string | null; location?: string | null; photo?: string | null;
  about?: string | null; languages?: string[] | null; contact?: { email: string | null; phone: string | null } | null;
  skills?: string[] | null; skillLevels?: Record<string, number> | null; links?: { label: string; url: string }[] | null;
  education?: { school: string; degree: string | null; from: string | null; to: string | null }[] | null;
  certifications?: { name: string; issuer: string | null; on: string | null }[] | null;
  experience?: { company: string; role: string | null; from: string | null; to: string | null; current: boolean; tasksDone?: number; projects?: number; deliveries?: number }[] | null;
  highlights?: { title: string; from: string; on: string | null }[] | null; badges?: { title: string; from: string; on: string }[] | null;
};
export const SECTIONS = [
  ["photo", "Photo"], ["about", "About"], ["contact", "Personal contact"], ["experience", "Experience"], ["work", "Work counts"],
  ["skills", "Skills"], ["education", "Education"], ["certifications", "Certifications"], ["highlights", "Highlights"], ["badges", "Badges"], ["links", "Links"],
] as const;
const LEVEL = ["", "Learning", "Working", "Strong", "Expert"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const month = (d: string | null) => { if (!d) return ""; const [y, m] = d.split("-"); return m ? `${MONTHS[Number(m) - 1]} ${y}` : y; };

export function ResumeDoc({ r }: { r: ResumeData }) {
  const meta = [r.pronouns, r.location, r.contact?.email, r.contact?.phone].filter(Boolean);
  return <article className={css.doc} data-resume="">
    <header className={css.head}>
      {r.photo ? <div className={css.photo} style={{ backgroundImage: `url("${r.photo}")` }} role="img" aria-label={`Photo of ${r.name}`} /> : null}
      <div><h1>{r.name}</h1>{r.headline ? <p className={css.headline}>{r.headline}</p> : null}{meta.length ? <p className={css.meta}>{meta.join(" · ")}</p> : null}</div>
    </header>
    {r.about ? <section><h2>About</h2><p className={css.prose}>{r.about}</p>{r.languages?.length ? <p className={css.meta}>Languages: {r.languages.join(", ")}</p> : null}</section> : null}
    {r.experience?.length ? <section><h2>Experience</h2>{r.experience.map((x, i) => <div className={css.item} key={i}>
      <div className={css.itemHead}><b>{x.role ?? "Member"}</b><span>{month(x.from)} – {x.current ? "Present" : month(x.to)}</span></div>
      <p className={css.meta}>{x.company}{x.tasksDone !== undefined ? ` · ${x.tasksDone} tasks done · ${x.projects ?? 0} projects · ${x.deliveries ?? 0} deliveries` : ""}</p>
    </div>)}</section> : null}
    {r.skills?.length ? <section><h2>Skills</h2><ul className={css.tags}>{r.skills.map((s) => <li key={s}>{s}{r.skillLevels?.[s] ? <small> · {LEVEL[r.skillLevels[s]]}</small> : null}</li>)}</ul></section> : null}
    {r.education?.length ? <section><h2>Education</h2>{r.education.map((e, i) => <div className={css.item} key={i}><div className={css.itemHead}><b>{e.school}</b><span>{[e.from, e.to].filter(Boolean).join(" – ")}</span></div>{e.degree ? <p className={css.meta}>{e.degree}</p> : null}</div>)}</section> : null}
    {r.certifications?.length ? <section><h2>Certifications</h2>{r.certifications.map((c, i) => <div className={css.item} key={i}><div className={css.itemHead}><b>{c.name}</b><span>{c.on ?? ""}</span></div>{c.issuer ? <p className={css.meta}>{c.issuer}</p> : null}</div>)}</section> : null}
    {r.highlights?.length ? <section><h2>Highlights</h2><ul className={css.list}>{r.highlights.map((h, i) => <li key={i}>{h.title}<small> · {h.from}{h.on ? `, ${month(h.on)}` : ""}</small></li>)}</ul></section> : null}
    {r.badges?.length ? <section><h2>Recognition</h2><ul className={css.list}>{r.badges.map((b, i) => <li key={i}>{b.title}<small> · {b.from}, {month(b.on)}</small></li>)}</ul></section> : null}
    {r.links?.length ? <section><h2>Links</h2><ul className={css.list}>{r.links.map((l) => <li key={l.url}><a href={l.url} rel="noreferrer noopener">{l.label || l.url}</a></li>)}</ul></section> : null}
  </article>;
}
