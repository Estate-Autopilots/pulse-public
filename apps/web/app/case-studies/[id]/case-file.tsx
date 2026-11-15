"use client";
// CASE-STUDIES (owner, 10 Nov 2026): one company's case file. Codex concept 2's right pane on a computer, concept 3 on a
// phone: the name, kind of business and day of 45; a ring for the stage; the 8-stage stepper; four tabs.
//  - Steps: this stage's checklist (a tick draws itself and pops), each step with a way to do it here, and one primary
//    button, "Mark this stage done" (a celebration; it only opens when every step is ticked).
//  - Numbers: starting numbers month by month (typed "4.2 L" works), where they came from, the suggested goals (typed
//    rules, no AI guessing) with "Make it a goal", and the numbers after 45 days on the same measures.
//  - Talks & links: Meetings, Docs, Goals, the Client record, projects and AI employees this case links to (live names,
//    nothing copied), with a clip line for podcasts.
//  - Story: the tags the archive sorts by, pain points, and the case study itself as a Doc.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, BookOpenCheck, Bot, Building2, FileText, FolderKanban, Link2, Mic, Plus, Sparkles, Target, Trash2, type LucideIcon } from "lucide-react";
import { Drawer, DrawerFooter, DrawerSection, useConfirm } from "../../kit";
import { ActionButton, Chip, EmptyState, GameCard, GamePage, Milestone, PageHeader, ProgressRing, Quest, QuestList, SegmentedTabs, Stepper, celebrate, toast } from "../../kit/game";
import { readAmount, rupees } from "../../lib/goals.mjs";
import { styles } from "../../ui";
import { caseGet, casePost, LINK_WORDS, SECTORS, type CaseFile, type CaseMonth, type LinkKind, type Suggestion } from "../model";
import { dayText, initial } from "../list";
import { SuggestionCard } from "../suggestion";
import css from "../case.module.css";

type Tab = "steps" | "numbers" | "links" | "story";
const KIND_ICON: Record<LinkKind, LucideIcon> = { meeting: Mic, doc: FileText, goal: Target, client: Building2, project: FolderKanban, ai_employee: Bot };
const KINDS: LinkKind[] = ["meeting", "doc", "goal", "client", "project", "ai_employee"];
/** Where each step is done in this app (a tab, or the link drawer opened on a kind). */
const HELP: Record<string, { label: string; tab?: Tab; link?: LinkKind }> = {
  "convince.offer": { label: "Link the offer doc", link: "doc" }, "data.agent": { label: "Link the AI employee", link: "ai_employee" },
  "data.numbers": { label: "Enter the numbers", tab: "numbers" }, "understand.pains": { label: "Write the pain points", tab: "story" },
  "understand.meeting": { label: "Link the meeting", link: "meeting" }, "podcasts.record": { label: "Link the podcast", link: "meeting" },
  "insights.goals": { label: "See the suggested goals", tab: "numbers" }, "insights.projects": { label: "Link the projects", link: "project" },
  "price.after": { label: "Enter the results", tab: "numbers" }, "price.story": { label: "Write the story", tab: "story" },
};
const FROM: [CaseFile["numbersFrom"], string][] = [["owner", "The owner told us"], ["export", "Their own exports"], ["finance", "Their Finance in Vitals"], ["workbench", "The test workbench"]];

export function CaseFileView({ initial: first }: { initial: CaseFile }) {
  const [f, setF] = useState(first);
  const [tab, setTab] = useState<Tab>("steps");
  const [linking, setLinking] = useState<LinkKind | null>(null);
  const [moved, setMoved] = useState<string | null>(null);
  const current = f.stages[Math.min(f.stage, 8) - 1];
  const run = async (fn: () => Promise<{ case: CaseFile }>, ok?: string) => {
    try { const r = await fn(); setF(r.case); if (ok) toast(ok); return r; } catch (e) { toast(e instanceof Error ? e.message : "Not saved", { tone: "bad" }); return null; }
  };
  const tick = (id: string, done: boolean) => run(() => casePost(`case-studies/${f.id}/check`, { item: id, done }), done ? undefined : "Step opened again");
  const doneCount = current.checks.filter((c) => c.done).length;
  const advance = async (el: HTMLElement) => {
    const r = await run(() => casePost(`case-studies/${f.id}/stage`, { to: f.stage + 1 }));
    if (r) { celebrate(el, { big: true }); setMoved(r.case.finished ? "All 8 stages done!" : `On to stage ${r.case.stage}: ${r.case.stageLabel}`); }
  };
  const back = () => run(() => casePost(`case-studies/${f.id}/stage`, { to: f.stage - 1 }), "Moved back a stage");

  return <GamePage label={`Case study: ${f.name}`}>
    <Link href="/case-studies" className={css.back}><ArrowLeft size={16} aria-hidden="true" />All case studies</Link>
    <PageHeader eyebrow={<span className={css.eyebrow}><span className={css.logoSm} aria-hidden="true">{initial(f.name)}</span>Case study</span>}
      title={f.name} subtitle={<span className={css.headLine}>{f.sector ? <Chip>{f.sector}</Chip> : null}<Chip tone={f.over && !f.finished ? "warn" : undefined}>{dayText(f)}</Chip>{f.aim ? <span>{f.aim}</span> : null}</span>}
      side={<ProgressRing value={f.finished ? 1 : (f.stage - 1) / 8} size={72} label={f.finished ? "All 8 stages done" : `Stage ${f.stage} of 8`}>
        <span className={css.ringWords}><small>Stage</small><b>{f.finished ? "8" : f.stage} of 8</b></span></ProgressRing>} />
    <div className={css.stepperBox}><Stepper steps={f.stages.map((s) => s.label)} current={f.finished ? 8 : f.stage - 1} label="The 8 stages" /></div>
    <Milestone show={moved !== null} id={`case-${f.id}-${f.stage}`} title={moved ?? ""} text="Nice work. The next steps are ready." once={false} />
    <div className={css.tabs}>
      <SegmentedTabs label="Case file" value={tab} onChange={setTab} fill options={[
        { value: "steps", label: "Steps", count: f.finished ? undefined : `${doneCount}/${current.checks.length}` },
        { value: "numbers", label: "Numbers", count: f.months.length || undefined },
        { value: "links", label: "Talks & links", count: f.links.length || undefined },
        { value: "story", label: "Story" }]} />
    </div>

    {tab === "steps" ? <StepsTab f={f} current={current} doneCount={doneCount} tick={tick} advance={advance} back={back}
      go={(h) => { if (h.tab) setTab(h.tab); else if (h.link) { setTab("links"); setLinking(h.link); } }} /> : null}
    {tab === "numbers" ? <NumbersTab f={f} run={run} /> : null}
    {tab === "links" ? <LinksTab f={f} run={run} add={(k) => setLinking(k)} /> : null}
    {tab === "story" ? <StoryTab f={f} run={run} /> : null}
    {linking ? <LinkDrawer caseId={f.id} kind={linking} onClose={() => setLinking(null)} onDone={(c) => { setF(c); setLinking(null); toast("Linked"); }} /> : null}
  </GamePage>;
}

function StepsTab({ f, current, doneCount, tick, advance, back, go }: { f: CaseFile; current: CaseFile["stages"][number]; doneCount: number;
  tick: (id: string, done: boolean) => void; advance: (el: HTMLElement) => void; back: () => void; go: (h: { tab?: Tab; link?: LinkKind }) => void }) {
  const btn = useRef<HTMLButtonElement>(null);
  if (f.finished) return <GameCard><EmptyState art="done" title="All 8 stages are done" text={f.published ? "The story is published. Well done." : "Write the story and get their OK to publish it."}
    action={{ label: "Go back to stage 8", onClick: back }} /></GameCard>;
  const all = doneCount === current.checks.length;
  return <div className={css.grid2}>
    <GameCard title={<>Stage {current.n}: {current.label}</>} note={`${doneCount} of ${current.checks.length} steps done`}>
      <p className={css.what}>{current.what}</p>
      <div className={css.bar} aria-hidden="true"><span style={{ width: `${(doneCount / current.checks.length) * 100}%` }} /></div>
      <QuestList label={`Steps of ${current.label}`}>
        {current.checks.map((c) => { const h = HELP[c.id]; return <Quest key={c.id} title={c.label} state={c.done ? "done" : "todo"}
          toggleLabel={c.done ? `Open again: ${c.label}` : `Mark done: ${c.label}`} onToggle={(done) => tick(c.id, done)}
          end={h && !c.done ? <button type="button" className={css.linkBtn} onClick={() => go(h)}>{h.label}</button> : c.done ? <Chip tone="good">+1</Chip> : undefined} />; })}
      </QuestList>
      <div className={css.stageActions}>
        {f.stage > 1 ? <button type="button" className={css.linkBtn} onClick={back}>Go back a stage</button> : <span />}
        <button ref={btn} type="button" className={`${styles.btn} ${styles.btnPrimary} ${css.bigBtn}`} disabled={!all} onClick={() => btn.current && advance(btn.current)}
          title={all ? undefined : "Tick every step first"}>{f.stage === 8 ? "Finish the journey" : "Mark this stage done"}</button>
      </div>
      {!all ? <p className={css.help}>Tick every step to move on.</p> : null}
    </GameCard>
    <GameCard title="Coming next">
      <ol className={css.upNext}>
        {f.stages.filter((s) => s.n > current.n).slice(0, 3).map((s) => <li key={s.key}><b>{s.n}. {s.label}</b><span>{s.what}</span></li>)}
        {current.n === 8 ? <li><b>Done</b><span>Publish the story once they say yes.</span></li> : null}
      </ol>
    </GameCard>
  </div>;
}

const prevMonth = (m: string) => { const [y, mo] = m.split("-").map(Number); const d = new Date(Date.UTC(y, mo - 2, 1)); return d.toISOString().slice(0, 7); };
const show = (n: number | null | undefined, money: boolean) => n === null || n === undefined ? "" : money ? rupees(n) : String(n);
const monthName = (m: string) => { const [y, mo] = m.split("-").map(Number); return `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][mo - 1]} ${y}`; };

function NumbersTab({ f, run }: { f: CaseFile; run: (fn: () => Promise<{ case: CaseFile }>, ok?: string) => Promise<unknown> }) {
  const [rows, setRows] = useState(() => f.months.map((m) => ({ month: m.month, revenue: show(m.revenue, true), clients: show(m.clients, false), leads: show(m.leads, false) })));
  const [from, setFrom] = useState(f.numbersFrom);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [after, setAfter] = useState({ revenue: show(f.after.revenue, true), clients: show(f.after.clients, false), leads: show(f.after.leads, false), note: f.after.note ?? "" });
  const addMonth = () => { const now = new Date().toISOString().slice(0, 7);
    setRows((r) => [{ month: prevMonth(r.length ? r[0].month : now), revenue: "", clients: "", leads: "" }, ...r]); };
  const parse = (t: string, money: boolean) => { if (!t.trim()) return null; const n = money ? readAmount(t) : Number(t.replace(/[,\s]/g, "")); return n === null || !Number.isFinite(n) || n < 0 ? NaN : n; };
  const save = async () => {
    const months: CaseMonth[] = rows.map((r) => ({ month: r.month, revenue: parse(r.revenue, true), clients: parse(r.clients, false), leads: parse(r.leads, false) }));
    if (months.some((m) => [m.revenue, m.clients, m.leads].some((v) => Number.isNaN(v)))) { setError("Write numbers only, like 4.2 L or 420000"); return; }
    setBusy(true); setError(null);
    await run(() => casePost(`case-studies/${f.id}`, { months, numbersFrom: from }), "Numbers saved");
    setBusy(false);
  };
  const saveAfter = async () => {
    const a = { revenue: parse(after.revenue, true), clients: parse(after.clients, false), leads: parse(after.leads, false), note: after.note };
    if ([a.revenue, a.clients, a.leads].some((v) => Number.isNaN(v))) { toast("Write numbers only, like 4.2 L or 12", { tone: "bad" }); return; }
    await run(() => casePost(`case-studies/${f.id}`, { after: a }), "Results saved");
  };
  const makeGoal = async (s: Suggestion, el: HTMLElement) => {
    const r = await run(() => casePost(`case-studies/${f.id}/goal`, { metric: s.metric }));
    if (r) { celebrate(el); toast("Goal made and linked. Find it in Goals."); }
  };
  const cell = (i: number, k: "revenue" | "clients" | "leads", label: string) => <input className={styles.input} inputMode={k === "revenue" ? "text" : "numeric"} aria-label={`${label}, ${monthName(rows[i].month)}`}
    value={rows[i][k]} placeholder={k === "revenue" ? "₹" : "0"} onChange={(e) => setRows((r) => r.map((x, j) => j === i ? { ...x, [k]: e.target.value } : x))} />;

  return <div className={css.stack}>
    <GameCard title="Starting numbers" note="Month by month, before we started">
      {rows.length ? <div className={css.tableBox}><table className={css.table}>
        <thead><tr><th scope="col">Month</th><th scope="col">Revenue</th><th scope="col">New clients</th><th scope="col">Leads</th><th scope="col"><span className={css.srOnly}>Remove</span></th></tr></thead>
        <tbody>{rows.map((r, i) => <tr key={r.month}><th scope="row">{monthName(r.month)}</th><td>{cell(i, "revenue", "Revenue")}</td><td>{cell(i, "clients", "New clients")}</td><td>{cell(i, "leads", "Leads")}</td>
          <td><button type="button" className={css.iconBtn} aria-label={`Remove ${monthName(r.month)}`} onClick={() => setRows((x) => x.filter((_, j) => j !== i))}><Trash2 size={16} aria-hidden="true" /></button></td></tr>)}</tbody>
      </table></div> : <p className={css.help}>No numbers yet. Add the last 3 months at least: revenue, new clients and leads.</p>}
      <div className={css.formRow}>
        <button type="button" className={styles.btn} onClick={addMonth}><Plus size={14} aria-hidden="true" />Add a month</button>
        <label className={`${styles.field} ${css.fromField}`}>Where they came from<select value={from} onChange={(e) => setFrom(e.target.value as CaseFile["numbersFrom"])}>
          {FROM.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={save} disabled={busy}>{busy ? "Saving…" : "Save numbers"}</button>
      </div>
      {error ? <p className={css.error} role="alert">{error}</p> : null}
    </GameCard>
    <GameCard title={<><Sparkles size={16} aria-hidden="true" />Suggested goals</>} note="From their numbers, by fixed rules">
      <ul className={css.sugs}>{f.suggestions.map((s) => <SuggestionCard key={s.metric} s={s} make={makeGoal} />)}</ul>
    </GameCard>
    <GameCard title="After 45 days" note="The same measures, for the before and after">
      <div className={css.afterGrid}>
        <label className={styles.field}>Revenue a month<input value={after.revenue} onChange={(e) => setAfter({ ...after, revenue: e.target.value })} placeholder="₹" /></label>
        <label className={styles.field}>New clients a month<input inputMode="numeric" value={after.clients} onChange={(e) => setAfter({ ...after, clients: e.target.value })} placeholder="0" /></label>
        <label className={styles.field}>Leads a month<input inputMode="numeric" value={after.leads} onChange={(e) => setAfter({ ...after, leads: e.target.value })} placeholder="0" /></label>
        <label className={`${styles.field} ${css.wide}`}>What else changed<input value={after.note} maxLength={300} onChange={(e) => setAfter({ ...after, note: e.target.value })} placeholder="For example: the owner now takes Sundays off" /></label>
      </div>
      <div className={css.formRow}><span /><ActionButton action={{ label: "Save results", onClick: saveAfter }} /></div>
    </GameCard>
  </div>;
}

function LinksTab({ f, run, add }: { f: CaseFile; run: (fn: () => Promise<{ case: CaseFile }>, ok?: string) => Promise<unknown>; add: (k: LinkKind) => void }) {
  const ask = useConfirm();
  const remove = async (id: string, title: string) => {
    if (!(await ask({ title: `Remove the link to "${title}"?`, body: "The record itself stays where it is.", confirmLabel: "Remove link" }))) return;
    await run(() => casePost(`case-studies/${f.id}/links/${id}/remove`), "Link removed");
  };
  if (!f.links.length) return <GameCard><EmptyState art="connect" title="Nothing linked yet" text="Link the meetings, podcasts, docs and goals of this case. They stay where they are; this page just points to them."
    action={{ label: "Link a meeting", icon: Link2, onClick: () => add("meeting") }} /></GameCard>;
  return <div className={css.stack}>
    <div className={css.formRow}><span className={css.help}>Records stay in their own apps. This page points to them.</span>
      <ActionButton primary action={{ label: "Link a record", icon: Link2, onClick: () => add("meeting") }} /></div>
    <div className={css.linkGrid}>{KINDS.map((k) => { const items = f.links.filter((l) => l.kind === k); const Icon = KIND_ICON[k];
      return <GameCard key={k} title={<><Icon size={16} aria-hidden="true" />{LINK_WORDS[k].many}</>} note={items.length ? String(items.length) : undefined}>
        {items.length ? <ul className={css.links}>{items.map((l) => <li key={l.id}>
          {l.missing ? <span className={css.missing}>A {LINK_WORDS[k].one.toLowerCase()} you can&apos;t see</span> : <Link href={l.href}>{l.title}</Link>}
          {l.note ? <small>{l.note}</small> : null}
          <button type="button" className={css.iconBtn} aria-label={`Remove link to ${l.title ?? LINK_WORDS[k].one}`} onClick={() => remove(l.id, l.title ?? LINK_WORDS[k].one)}><Trash2 size={14} aria-hidden="true" /></button>
        </li>)}</ul> : null}
        <button type="button" className={css.linkBtn} onClick={() => add(k)}><Plus size={14} aria-hidden="true" />Link {k === "ai_employee" ? "an" : "a"} {LINK_WORDS[k].one.toLowerCase()}</button>
      </GameCard>; })}</div>
  </div>;
}

function LinkDrawer({ caseId, kind: first, onClose, onDone }: { caseId: string; kind: LinkKind; onClose: () => void; onDone: (c: CaseFile) => void }) {
  const [kind, setKind] = useState<LinkKind>(first);
  const [q, setQ] = useState(""), [options, setOptions] = useState<{ id: string; title: string; when: string | null }[] | null>(null);
  const [pick, setPick] = useState<string | null>(null), [note, setNote] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  // Loads the records of this kind matching the search (newest first); a newer search wins.
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      caseGet<{ options: { id: string; title: string; when: string | null }[] }>(`case-studies/link-options?kind=${kind}&q=${encodeURIComponent(q)}`)
        .then((r) => { if (live) setOptions(r.options); })
        .catch((e) => { if (live) { setError(e instanceof Error ? e.message : "Did not load"); setOptions([]); } });
    }, q ? 250 : 0);
    return () => { live = false; clearTimeout(t); };
  }, [kind, q]);
  const save = async () => {
    if (!pick) { setError("Pick one from the list"); return; }
    setBusy(true); setError(null);
    try { onDone((await casePost<{ case: CaseFile }>(`case-studies/${caseId}/links`, { kind, refId: pick, note })).case); }
    catch (e) { setError(e instanceof Error ? e.message : "Not linked"); setBusy(false); }
  };
  return <Drawer title="Link a record" onClose={onClose} size="md" footer={<DrawerFooter status={error}
    primary={<button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={save} disabled={busy || !pick}>{busy ? "Linking…" : "Link it"}</button>} />}>
    <DrawerSection title="What is it?">
      <div className={css.kindChips} role="radiogroup" aria-label="What to link">
        {KINDS.map((k) => { const Icon = KIND_ICON[k]; return <button key={k} type="button" role="radio" aria-checked={kind === k} className={css.kindChip}
          onClick={() => { setKind(k); setQ(""); setOptions(null); setPick(null); }}><Icon size={14} aria-hidden="true" />{LINK_WORDS[k].one}</button>; })}
      </div>
    </DrawerSection>
    <DrawerSection title="Pick one">
      <input className={styles.input} value={q} placeholder="Search by name" aria-label="Search by name" onChange={(e) => { setQ(e.target.value); setOptions(null); setPick(null); }} />
      {options === null ? <p className={css.help}>Loading…</p> : options.length ? <ul className={css.options} role="listbox" aria-label="Records">
        {options.map((o) => <li key={o.id}><button type="button" role="option" aria-selected={pick === o.id} className={css.option} onClick={() => setPick(o.id)}>
          <b>{o.title}</b>{o.when ? <small>{o.when.slice(0, 10)}</small> : null}</button></li>)}
      </ul> : <p className={css.help}>Nothing found. Make it in its own app first, then link it here.</p>}
    </DrawerSection>
    <DrawerSection title={kind === "meeting" ? "A line about it (for a podcast, the clip)" : "A line about it (optional)"}>
      <input className={styles.input} value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} aria-label="A line about it"
        placeholder={kind === "meeting" ? "For example: 12:30–13:10 “We doubled our leads”" : "For example: the offer we sent"} />
    </DrawerSection>
  </Drawer>;
}

function StoryTab({ f, run }: { f: CaseFile; run: (fn: () => Promise<{ case: CaseFile }>, ok?: string) => Promise<unknown> }) {
  const router = useRouter();
  const [pains, setPains] = useState(f.pains.join("\n"));
  const [sector, setSector] = useState(f.sector ?? "");
  const [busy, setBusy] = useState(false);
  const toggle = (key: "problems" | "moves", t: string) => { const now = f[key].includes(t) ? f[key].filter((x) => x !== t) : [...f[key], t]; void run(() => casePost(`case-studies/${f.id}`, { [key]: now })); };
  const savePains = () => run(() => casePost(`case-studies/${f.id}`, { pains: pains.split("\n").map((x) => x.trim()).filter(Boolean), sector }), "Saved");
  const write = async () => {
    setBusy(true);
    try { const r = await casePost<{ docId: string; case: CaseFile }>(`case-studies/${f.id}/story`); router.push(`/docs/${r.docId}`); }
    catch (e) { toast(e instanceof Error ? e.message : "Not made", { tone: "bad" }); setBusy(false); }
  };
  const publish = async (on: boolean, el: HTMLElement) => { const r = await run(() => casePost(`case-studies/${f.id}/story`, { publish: on }), on ? "Marked as published" : "Marked as not published"); if (r && on) celebrate(el, { big: true }); };
  return <div className={css.stack}>
    <GameCard title={<><BookOpenCheck size={16} aria-hidden="true" />The case study</>} note={f.published ? "Published" : f.storyDocId ? "Draft" : undefined}>
      {f.storyDocId && f.storyTitle ? <div className={css.storyRow}>
        <Link href={`/docs/${f.storyDocId}`} className={css.storyLink}><FileText size={18} aria-hidden="true" />{f.storyTitle}</Link>
        {f.published ? <button type="button" className={css.linkBtn} onClick={(e) => publish(false, e.currentTarget)}>Mark as not published</button>
          : <ActionButton primary action={{ label: "Mark as published", onClick: () => { const el = document.activeElement as HTMLElement; void publish(true, el); } }} />}
      </div> : <EmptyState art="done" title="No story yet" text="We start a Doc with the case-study outline, filled from this page: the problem, what we did and the numbers before and after. You finish it in your words."
        action={{ label: busy ? "Starting…" : "Write the story", onClick: write, busy }} />}
      <p className={css.help}>Publish only after the owner has read it and said yes.</p>
    </GameCard>
    <GameCard title="Pain points" note="One per line">
      <label className={styles.field}>Kind of business<select value={sector} onChange={(e) => setSector(e.target.value)}>
        <option value="">Not sure yet</option>{[...new Set([...SECTORS, ...(f.sector ? [f.sector] : [])])].map((s) => <option key={s} value={s}>{s}</option>)}</select></label>
      <label className={styles.field}>What slows them down<textarea value={pains} onChange={(e) => setPains(e.target.value)} rows={4} placeholder={"Slow replies to new leads\nQuotes take too long"} /></label>
      <div className={css.formRow}><span /><ActionButton action={{ label: "Save", onClick: () => void savePains() }} /></div>
    </GameCard>
    <GameCard title="Tags for the library" note="So people can find stories like theirs">
      <p className={css.tagHead}>The problem</p>
      <div className={css.kindChips}>{f.lists.problems.map((t) => <button key={t} type="button" className={css.kindChip} aria-pressed={f.problems.includes(t)} onClick={() => toggle("problems", t)}>{t}</button>)}</div>
      <p className={css.tagHead}>What we did</p>
      <div className={css.kindChips}>{f.lists.moves.map((t) => <button key={t} type="button" className={css.kindChip} aria-pressed={f.moves.includes(t)} onClick={() => toggle("moves", t)}>{t}</button>)}</div>
    </GameCard>
  </div>;
}
