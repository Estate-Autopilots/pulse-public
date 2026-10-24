"use client";
// R48: HR's and admins' view of the skills list. Where an imported taxonomy came from (it stays empty until the owner
// approves a download and licence: errand E16), local skills HR adds for what the taxonomy lacks, local names (marked
// local, never official translations) and the proficiency scale. The database decides who may change what.
import { Database, Languages, Plus, Ruler, Search, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { notify } from "@pulse/ui-shell";
import { Modal, RecordForm, post } from "../../records";
import { Badge, styles } from "../../ui";
import css from "../[id]/skills.module.css";

type Source = { family: string; version: string; language: string; fileName: string; fileSha256: string; dataLicence: string; softwareLicence: string | null; attribution: string;
  adapted: string; sourceUrl: string | null; slice: string; approvalRef: string; counts: Record<string, number>; importedAt: string; supersededAt: string | null };
type Level = { level: number; label: string; description: string };
export type SetupData = { sources: Source[]; local: { id: string; label: string; description: string | null; createdBy: string | null; createdAt: string }[];
  names: { id: string; label: string; language: string; conceptId: string; skill: string; family: string; createdBy: string | null }[];
  rubric: { confirmed: boolean; levels: Level[] } };
type Hit = { id: string; family: string; label: string; status: string };

const FAMILY: Record<string, string> = { esco: "ESCO", onet: "O*NET", local: "Local" };
const LANGUAGES = [["hi", "Hindi"], ["mr", "Marathi"], ["en", "English"], ["gu", "Gujarati"], ["kn", "Kannada"], ["ta", "Tamil"], ["te", "Telugu"], ["bn", "Bengali"]];
const day = (d: string) => new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
const message = (e: unknown) => e instanceof Error ? e.message : "Not saved";

function Card({ id, icon, title, sub, tools, children, wide }: { id: string; icon: ReactNode; title: string; sub?: ReactNode; tools?: ReactNode; children: ReactNode; wide?: boolean }) {
  return <section className={css.card} data-wide={wide ? "" : undefined} aria-labelledby={`setup-${id}`}>
    <header className={css.cardHead}><span className={css.cardIcon} aria-hidden="true">{icon}</span><div><h3 id={`setup-${id}`}>{title}</h3>{sub ? <p>{sub}</p> : null}</div>{tools ? <span className={css.tools}>{tools}</span> : null}</header>
    <div className={css.cardBody}>{children}</div>
  </section>;
}

export function SkillsSetup({ data }: { data: SetupData }) {
  const router = useRouter();
  async function withdraw(id: string, label: string) {
    if (!window.confirm(`Take back the local name “${label}”?`)) return;
    try { await post(`skills/names/${id}/withdraw`); notify({ id: "names", tone: "success", title: "Name taken back", timeout: 2500 }); router.refresh(); }
    catch (e) { notify({ id: "names", tone: "error", title: "Not changed", message: message(e) }); }
  }
  return <div className={css.page} data-grow="">
    <div className={css.grid}>
      <Card id="taxonomy" wide icon={<Database size={16} />} title="Industry taxonomy"
        sub="Imported only from a download the owner approved, with its version, file hash, licences and attribution. Nothing is fetched or scraped; Lightcast needs a contract.">
        {data.sources.length ? <ul className={css.list}>{data.sources.map((s) => <li key={`${s.family}${s.version}${s.language}`}>
          <div className={css.head}><span className={css.name}><b>{FAMILY[s.family] ?? s.family} {s.version}</b><Badge tone="neutral">{s.language}</Badge>
            {s.supersededAt ? <Badge tone="neutral">Superseded {day(s.supersededAt)}</Badge> : <Badge tone="success">Current</Badge>}</span>
            <span className={css.level}>Imported {day(s.importedAt)}</span></div>
          <p className={css.meta}>{s.slice} · {s.counts.concepts ?? 0} concepts ({s.counts.added ?? 0} new, {s.counts.deprecated ?? 0} deprecated, {s.counts.absent ?? 0} no longer in the list)</p>
          <p className={css.text}><b>Data licence:</b> {s.dataLicence} · <b>Software licence:</b> {s.softwareLicence ?? "none (a downloaded file, no API)"}</p>
          <p className={css.text}><b>Attribution:</b> {s.attribution} {s.adapted}</p>
          <p className={css.meta}>{s.fileName} · SHA-256 {s.fileSha256.slice(0, 12)}… · approval: {s.approvalRef}{s.sourceUrl ? <> · <a className={styles.fill} href={s.sourceUrl} target="_blank" rel="noreferrer">source</a></> : null}</p>
        </li>)}</ul> : <p className={css.muted}>None yet. The owner’s errand E16 (approve the ESCO download and its licence, the scale and example skills) comes first; then the operator imports the approved slice (docs/ops/SKILLS.md). Until then people pick from HR’s local skills.</p>}
      </Card>

      <Card id="local" icon={<Sparkles size={16} />} title="Local skills" sub="What the taxonomy lacks. Shown as “Local” wherever they appear."
        tools={<RecordForm path="skills/local" complete title="Add a local skill" label="Add" icon="add" variant="ghost" done="Added"
          fields={[{ key: "label", label: "Skill", required: true, wide: true, maxLength: 80, placeholder: "e.g. Model shoot direction" }, { key: "description", label: "What it means here (optional)", type: "textarea", maxLength: 400 }]}
          note="If the list already has this skill, add a local name to it instead." />}>
        {data.local.length ? <ul className={css.list}>{data.local.map((l) => <li key={l.id}><span className={css.name}><b>{l.label}</b></span>
          <p className={css.meta}>{l.description ? `${l.description} · ` : ""}added by {l.createdBy ?? "HR"} · {day(l.createdAt)}</p></li>)}</ul>
          : <p className={css.muted}>No local skills yet.</p>}
      </Card>

      <Card id="names" icon={<Languages size={16} />} title="Local names" sub="Other names for a skill, for example in Hindi or Marathi. Marked local: never an official translation."
        tools={<NameAdder />}>
        {data.names.length ? <ul className={css.list}>{data.names.map((n) => <li key={n.id}><div className={css.head}><span className={css.name}><b>{n.label}</b><Badge tone="accent">local · {n.language}</Badge></span>
          <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} onClick={() => void withdraw(n.id, n.label)}>Take back</button></div>
          <p className={css.meta}>for {n.skill} ({FAMILY[n.family] ?? n.family}) · added by {n.createdBy ?? "HR"}</p></li>)}</ul>
          : <p className={css.muted}>No local names yet.</p>}
      </Card>

      <Card id="scale" icon={<Ruler size={16} />} title="Proficiency scale" sub={data.rubric.confirmed ? "Confirmed by HR. Levels can be renamed or added, never removed." : "Pulse’s starting scale. Confirm it, or write HR’s own (3 to 5 levels)."}
        tools={<ScaleEditor levels={data.rubric.levels} confirmed={data.rubric.confirmed} />}>
        <ol className={css.scale}>{data.rubric.levels.map((l) => <li key={l.level}><b>{l.level}</b><span>{l.label}<small>{l.description}</small></span></li>)}</ol>
      </Card>
    </div>
  </div>;
}

/** Add a local name to a skill: find the skill, then the name and its language. */
function NameAdder() {
  const router = useRouter();
  const [open, setOpen] = useState(false), [q, setQ] = useState(""), [found, setFound] = useState<{ q: string; items: Hit[] } | null>(null), [pick, setPick] = useState<Hit | null>(null);
  const term = q.trim(), hits = found && found.q === term ? found.items : null;
  const [label, setLabel] = useState(""), [language, setLanguage] = useState("hi"), [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => {
    if (!open || pick || term.length < 2) return;
    const ctl = new AbortController();
    const t = window.setTimeout(() => { fetch(`/api/v0/skills/catalog?q=${encodeURIComponent(term)}`, { signal: ctl.signal }).then((r) => r.json()).then((d) => setFound({ q: term, items: d.items ?? [] })).catch(() => undefined); }, 220);
    return () => { window.clearTimeout(t); ctl.abort(); };
  }, [term, open, pick]);
  async function save() {
    if (!pick) return;
    setBusy(true); setError("");
    try { await post("skills/names", { conceptId: pick.id, label, language }); setOpen(false); notify({ id: "names", tone: "success", title: "Local name added", timeout: 2500 }); router.refresh(); }
    catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  return <>
    <button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={() => { setOpen(true); setPick(null); setQ(""); setLabel(""); setError(""); }}><Plus size={14} aria-hidden="true" />Add</button>
    {open ? <Modal title="Add a local name" sub="People find the skill by this name too. It stays marked local." onClose={() => setOpen(false)} scroll
      foot={<div className={styles.modalFoot}><p role="alert" className={styles.status}>{error}</p><button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={() => setOpen(false)}>Cancel</button>
        <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || !pick || label.trim().length < 2} onClick={() => void save()}>Add</button></div>}>
      <div className={css.form}>
        {pick ? <div className={css.picked}><b>{pick.label}<Badge tone="neutral">{FAMILY[pick.family] ?? pick.family}</Badge></b><button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} onClick={() => setPick(null)}>Change</button></div>
          : <div className={css.fieldset}><label className={css.search}><Search size={15} aria-hidden="true" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find the skill" aria-label="Find the skill" autoComplete="off" /></label>
            {hits?.length ? <ul className={css.results}>{hits.map((h) => <li key={h.id}><button type="button" className={css.result} onClick={() => setPick(h)}><b>{h.label}<Badge tone="neutral">{FAMILY[h.family] ?? h.family}</Badge></b></button></li>)}</ul>
              : hits ? <p className={css.muted}>Nothing matches.</p> : null}</div>}
        <label className={styles.field}><span>Local name</span><input value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. वीडियो एडिटिंग" /></label>
        <label className={styles.field}><span>Language</span><select value={language} onChange={(e) => setLanguage(e.target.value)}>{LANGUAGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
      </div>
    </Modal> : null}
  </>;
}

/** HR's scale: rename levels or add up to five; confirming records HR as its owner. */
function ScaleEditor({ levels, confirmed }: { levels: Level[]; confirmed: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false), [rows, setRows] = useState(levels), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const set = (i: number, k: "label" | "description", v: string) => setRows((cur) => cur.map((r, j) => j === i ? { ...r, [k]: v } : r));
  async function save() {
    setBusy(true); setError("");
    try { await post("skills/scale", { levels: rows.map(({ label, description }) => ({ label, description })) }); setOpen(false); notify({ id: "scale", tone: "success", title: "Scale confirmed", timeout: 2500 }); router.refresh(); }
    catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  return <>
    <button type="button" className={`${styles.btn}${confirmed ? ` ${styles.btnGhost}` : ` ${styles.btnPrimary}`}`} onClick={() => { setRows(levels); setError(""); setOpen(true); }}>{confirmed ? "Edit" : "Confirm or change"}</button>
    {open ? <Modal title="Proficiency scale" sub="People assess themselves on it; verifiers mark the level they saw on it." onClose={() => setOpen(false)} scroll
      foot={<div className={styles.modalFoot}><p role="alert" className={styles.status}>{error}</p><button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={() => setOpen(false)}>Cancel</button>
        <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy} onClick={() => void save()}>Confirm</button></div>}>
      <div className={css.form}>
        {rows.map((r, i) => <fieldset key={i} className={css.fieldset}><legend>Level {i + 1}</legend>
          <label className={styles.field}><span>Name</span><input value={r.label} maxLength={40} onChange={(e) => set(i, "label", e.target.value)} /></label>
          <label className={styles.field}><span>What it means</span><textarea value={r.description} maxLength={400} onChange={(e) => set(i, "description", e.target.value)} /></label>
        </fieldset>)}
        {rows.length < 5 ? <button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={() => setRows((cur) => [...cur, { level: cur.length + 1, label: "", description: "" }])}><Plus size={14} aria-hidden="true" />Add a level</button> : null}
        <p className={css.muted}>Levels can be renamed or added, never removed: people’s skills and verifications use them.</p>
      </div>
    </Modal> : null}
  </>;
}
