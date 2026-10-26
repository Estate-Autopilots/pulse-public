"use client";
// PULSE-HQ: the ideas, edited like a Notion database (owner, 23 Oct 2026). Sheet, board by stage, compact, gallery, a
// free canvas and the impact × effort matrix over the same rows; click a cell to edit, Enter saves, Tab moves on, "n"
// adds an idea, a pasted list adds many, drag to reorder, select several to change their stage, area or owner at once.
// Priority = impact ÷ effort lifted by votes. Anyone in the organisation adds ideas and votes; the author or a leader
// edits; a leader turns an idea into a feature being built (it joins the catalogue as "Building").
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState, type CSSProperties } from "react";
import { ArrowBigUp, CircleAlert, Grid2x2, Rocket, Search, Trash2, X, Plus } from "lucide-react";
import { hqPost, useDialog, useSoonRefresh } from "../client";
import { CATEGORIES, IDEA_STATUS, plural, priority, type Category, type Hq, type Idea, type IdeaStatus } from "../model";
import { Grid, type Col, type ExtraView } from "../grid/grid";
import { SlashText } from "../grid/slash";
import css from "../hq.module.css";

const AREAS = CATEGORIES.map((c) => ({ key: c.key, label: c.label, tone: `hsl(${c.hue} 60% 45%)` }));
const DEFAULTS = { kind: "sheet", boardBy: "status" };

export function IdeaBoard({ hq, initialOpen }: { hq: Hq; initialOpen: string | null }) {
  const router = useRouter();
  const refresh = useCallback(() => router.refresh(), [router]);
  const soon = useSoonRefresh(refresh);
  const [openId, setOpenId] = useState<string | null>(initialOpen);
  const [votes, setVotes] = useState<Record<string, { votes: number; voted: boolean }>>({});
  const ideas = useMemo(() => hq.ideas.map((i) => ({ ...i, ...votes[i.id] })), [hq.ideas, votes]);
  const close = useCallback(() => setOpenId(null), []);
  const people = hq.people ?? [];
  const featureName = useMemo(() => new Map(hq.features.map((f) => [f.key, f.name])), [hq.features]);
  const links = useMemo(() => hq.features.filter((f) => !f.archived).map((f) => ({ key: f.key, label: f.name })), [hq.features]);

  const vote = useCallback(async (idea: Idea) => {
    const next = { votes: idea.votes + (idea.voted ? -1 : 1), voted: !idea.voted };
    setVotes((v) => ({ ...v, [idea.id]: next }));
    try { const r = await hqPost<{ votes: number; voted: boolean }>(`ideas/${idea.id}/vote`, { on: next.voted }); setVotes((v) => ({ ...v, [idea.id]: r })); }
    catch { setVotes((v) => ({ ...v, [idea.id]: { votes: idea.votes, voted: idea.voted } })); }
  }, []);

  const cols = useMemo<Col<Idea>[]>(() => [
    { key: "title", label: "Idea", kind: "title", width: 300 },
    { key: "status", label: "Stage", kind: "select", options: IDEA_STATUS, group: true, width: 128 },
    { key: "area", label: "Area", kind: "select", options: AREAS, nullable: true, group: true, width: 168 },
    { key: "ownerId", label: "Owner", kind: "person", group: true, width: 160 },
    { key: "impact", label: "Impact", kind: "score", group: true, width: 104 },
    { key: "effort", label: "Effort", kind: "score", group: true, width: 104 },
    { key: "priority", label: "Priority", kind: "view", width: 86, sortValue: (i) => priority(i), render: (i) => <span className={css.priority} title="Impact ÷ effort, lifted by votes">{priority(i)}</span> },
    { key: "votes", label: "Votes", kind: "view", width: 82, sortValue: (i) => i.votes,
      render: (i) => <button type="button" className={css.vote} data-on={i.voted ? "" : undefined} aria-pressed={i.voted} aria-label={i.voted ? "Remove my vote" : "Vote for this idea"}
        onClick={(e) => { e.stopPropagation(); void vote(i); }}><ArrowBigUp size={15} aria-hidden="true" />{i.votes}</button> },
    { key: "forWhom", label: "For whom", kind: "text", width: 200, placeholder: "Who is it for?" },
    { key: "problem", label: "Problem", kind: "long", width: 300, placeholder: "What hurts today?" },
    { key: "details", label: "Details", kind: "long", width: 280, hidden: true },
    { key: "features", label: "Features", kind: "view", width: 200, hidden: true, sortValue: (i) => i.featureKeys.length,
      render: (i) => <span className={css.faint}>{i.featureKeys.map((k) => featureName.get(k) ?? k).join(", ") || "—"}</span> },
    { key: "by", label: "From", kind: "view", width: 140, hidden: true, sortValue: (i) => i.by ?? "", render: (i) => <span>{i.by ?? "—"}</span> },
  ], [vote, featureName]);

  const quads = [
    { q: "win", title: "Quick wins", text: "High impact, low effort: do these first.", test: (i: Idea) => i.impact >= 3 && i.effort <= 3 },
    { q: "bet", title: "Big bets", text: "High impact, high effort: plan them.", test: (i: Idea) => i.impact >= 3 && i.effort > 3 },
    { q: "fill", title: "Fill-ins", text: "Low impact, low effort: when there is room.", test: (i: Idea) => i.impact < 3 && i.effort <= 3 },
    { q: "pit", title: "Money pits", text: "Low impact, high effort: think twice.", test: (i: Idea) => i.impact < 3 && i.effort > 3 },
  ];
  const extraViews: ExtraView<Idea>[] = [{ key: "matrix", label: "Impact × effort", Icon: Grid2x2, render: (rows) => { const live = rows.filter((i) => i.status !== "parked" && i.status !== "shipped");
    return <>
      <div className={css.axis}><span>Effort: low → high</span><span>Impact: high ↑</span></div>
      <div className={css.matrix}>{quads.map((quad) => <section key={quad.q} className={css.quad} data-q={quad.q} aria-label={quad.title}>
        <h3>{quad.title}</h3><p>{quad.text}</p>
        {live.filter(quad.test).sort((a, b) => priority(b) - priority(a)).map((idea, i) => <IdeaCard key={idea.id} idea={idea} i={i} onOpen={() => setOpenId(idea.id)} onVote={() => void vote(idea)} />)}
      </section>)}</div>
    </>; } }];

  const me = hq.me ?? null;
  const live = ideas.filter((i) => i.status !== "parked" && i.status !== "shipped");
  return <>
    <header className={css.pageHead}>
      <div><h1>Ideas</h1><p>{live.length} in play · {ideas.filter((i) => i.status === "planned").length} planned · {plural(ideas.reduce((s, i) => s + i.votes, 0), "vote")}</p></div>
    </header>
    {ideas.some((i) => i.draft) ? <p className={css.draftNote}><CircleAlert size={17} aria-hidden="true" /><span>Seeded ideas are drafts to start the conversation: vote, sharpen or park them.</span></p> : null}
    <Grid<Idea> scope="hq-ideas" rows={ideas} cols={cols} people={people} noun="idea" defaults={DEFAULTS} extraViews={extraViews} links={links}
      canEdit={(i) => hq.canEdit || (!!me && i.byId === me)} canCreate canReorder canRemove bulk={["status", "area", "ownerId", "impact", "effort"]}
      onPatch={async (id, patch) => { await hqPost(`ideas/${id}`, patch); soon(); }}
      onCreate={async (fields) => { await hqPost("ideas", fields); soon(); }}
      onBatch={async (items) => { await hqPost("ideas/batch", { items }); soon(); }}
      onBulk={async (ids, patch) => { await hqPost("ideas/bulk", patch ? { ids, patch } : { ids, remove: true }); soon(); }}
      onReorder={async (ids) => { await hqPost("ideas/reorder", { ids }); soon(); }}
      onOpen={setOpenId}
      cardExtra={(i) => <span className={css.ideaFoot}><span className={css.priority} title="Priority">{priority(i)}</span>
        {i.forWhom ? <span className={css.ideaFor}>For {i.forWhom.replace(/^\w/, (c) => c.toLowerCase())}</span> : null}</span>} />
    <IdeaSheet hq={hq} idea={openId === "new" ? "new" : ideas.find((i) => i.id === openId) ?? null} onClose={close} onSaved={refresh} links={links} />
  </>;
}

function Meter({ label, value, tone }: { label: string; value: number; tone: string }) {
  return <span className={css.meter} style={{ "--tone": tone } as CSSProperties} title={`${label} ${value} of 5`}>{label}<span aria-hidden="true">{[1, 2, 3, 4, 5].map((n) => <i key={n} data-on={n <= value ? "" : undefined} />)}</span></span>;
}

function IdeaCard({ idea, i, onOpen, onVote }: { idea: Idea; i: number; onOpen: () => void; onVote: () => void }) {
  return <article className={css.idea} style={{ "--i": i } as CSSProperties} tabIndex={0} role="button" aria-label={`${idea.title}, priority ${priority(idea)}`}
    onClick={onOpen} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } }}>
    <p className={css.ideaTitle}>{idea.title}</p>
    {idea.forWhom ? <span className={css.ideaFor}>For {idea.forWhom.replace(/^\w/, (c) => c.toLowerCase())}</span> : null}
    <span className={css.ideaFoot}>
      <span className={css.priority} title="Priority: impact ÷ effort, lifted by votes">{priority(idea)}</span>
      <Meter label="Impact" value={idea.impact} tone="var(--good)" />
      <button type="button" className={css.vote} data-on={idea.voted ? "" : undefined} aria-pressed={idea.voted} aria-label={idea.voted ? "Remove my vote" : "Vote for this idea"}
        onClick={(e) => { e.stopPropagation(); onVote(); }}><ArrowBigUp size={16} aria-hidden="true" />{idea.votes}</button>
    </span>
  </article>;
}

type Draft = { title: string; problem: string; forWhom: string; impact: number; effort: number; status: IdeaStatus; featureKeys: string[]; area: Category | null; ownerId: string | null; details: string };

function IdeaSheet({ hq, idea, onClose, onSaved, links }: { hq: Hq; idea: Idea | "new" | null; onClose: () => void; onSaved: () => void; links: { key: string; label: string }[] }) {
  const ref = useDialog(idea !== null, onClose);
  const one = idea === "new" ? null : idea;
  return <dialog ref={ref} className={`${css.sheet} ${css.glassThick}`} aria-label={one?.title ?? "New idea"}>
    {idea ? <IdeaBody key={one?.id ?? "new"} hq={hq} idea={one} onClose={onClose} onSaved={onSaved} links={links} /> : null}
  </dialog>;
}

function IdeaBody({ hq, idea, onClose, onSaved, links }: { hq: Hq; idea: Idea | null; onClose: () => void; onSaved: () => void; links: { key: string; label: string }[] }) {
  const [d, setD] = useState<Draft>(idea ? { title: idea.title, problem: idea.problem, forWhom: idea.forWhom, impact: idea.impact, effort: idea.effort, status: idea.status, featureKeys: idea.featureKeys,
    area: idea.area ?? null, ownerId: idea.ownerId ?? null, details: idea.details ?? "" }
    : { title: "", problem: "", forWhom: "", impact: 3, effort: 3, status: "new", featureKeys: [], area: null, ownerId: hq.me ?? null, details: "" });
  const [find, setFind] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [category, setCategory] = useState<Category>(idea?.area ?? "work");
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const byKey = new Map(hq.features.map((f) => [f.key, f]));
  const found = find.trim().length > 1 ? hq.features.filter((f) => !d.featureKeys.includes(f.key) && `${f.name} ${f.promise}`.toLowerCase().includes(find.trim().toLowerCase())).slice(0, 8) : [];
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await work(); onSaved(); onClose(); } catch (e) { setError(e instanceof Error ? e.message : "Not saved"); } finally { setBusy(false); }
  };
  const feature = idea?.featureId ? hq.features.find((f) => f.id === idea.featureId) : null;
  const save = () => run(() => idea ? hqPost(`ideas/${idea.id}`, { ...d, draft: false }) : hqPost("ideas", d));
  return <>
    <div className={css.sheetScroll}>
      <div className={css.sheetHead}>
        <div><span className={css.subhead}>{idea ? `Idea${idea.by ? ` from ${idea.by}` : ""}` : "New idea"}</span>
          <input className={css.studioName} style={{ fontSize: 24, marginTop: 6, width: "100%" }} value={d.title} maxLength={120} placeholder="Name the idea" onChange={(e) => set("title", e.target.value)} aria-label="Title" autoFocus={!idea}
            onKeyDown={(e) => { if (e.key === "Enter" && d.title.trim().length >= 2) { e.preventDefault(); void save(); } }} /></div>
        <button type="button" className={css.iconBtn} onClick={onClose} aria-label="Close"><X size={17} /></button>
      </div>
      <div className={css.formGrid}>
        <label className={`${css.fieldLabel} ${css.wide}`}><span>The problem <small>/ for blocks</small></span>
          <SlashText className={css.textarea} value={d.problem} maxLength={1000} placeholder="What hurts today, and for whom?" onValue={(v) => set("problem", v)} links={links} onSubmit={() => void save()} /></label>
        <label className={css.fieldLabel}><span>For whom</span><input className={css.input} value={d.forWhom} maxLength={160} placeholder="e.g. Agency founders" onChange={(e) => set("forWhom", e.target.value)} /></label>
        <label className={css.fieldLabel}><span>Stage</span><select className={css.select} value={d.status} onChange={(e) => set("status", e.target.value as IdeaStatus)}>{IDEA_STATUS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select></label>
        <label className={css.fieldLabel}><span>Area</span><select className={css.select} value={d.area ?? ""} onChange={(e) => set("area", (e.target.value || null) as Category | null)}>
          <option value="">None</option>{CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</select></label>
        <label className={css.fieldLabel}><span>Owner</span><select className={css.select} value={d.ownerId ?? ""} onChange={(e) => set("ownerId", e.target.value || null)}>
          <option value="">No one</option>{(hq.people ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <div className={css.fieldLabel}><span>Impact</span><Scale value={d.impact} onChange={(v) => set("impact", v)} label="Impact" /></div>
        <div className={css.fieldLabel}><span>Effort</span><Scale value={d.effort} onChange={(v) => set("effort", v)} label="Effort" /></div>
        <label className={`${css.fieldLabel} ${css.wide}`}><span>Details <small>specs, notes; / for blocks</small></span>
          <SlashText className={css.textarea} value={d.details} maxLength={8000} rows={7} placeholder="What it does, what done looks like…" onValue={(v) => set("details", v)} links={links} onSubmit={() => void save()} /></label>
        <div className={`${css.fieldLabel} ${css.wide}`}><span>Linked features <small>{d.featureKeys.length}</small></span>
          <div className={css.picker}>
            {d.featureKeys.length ? <div className={css.chips}>{d.featureKeys.map((k) => <button key={k} type="button" className={css.tag} onClick={() => set("featureKeys", d.featureKeys.filter((x) => x !== k))} aria-label={`Unlink ${byKey.get(k)?.name ?? k}`}>{byKey.get(k)?.name ?? k}<X size={13} aria-hidden="true" /></button>)}</div> : null}
            <label className={css.search} style={{ maxWidth: "none" }}><Search size={15} aria-hidden="true" /><input value={find} onChange={(e) => setFind(e.target.value)} placeholder="Find a feature to link" aria-label="Find a feature to link" /></label>
            {found.length ? <div className={css.pickList}>{found.map((f) => <button key={f.key} type="button" className={css.pickRow} onClick={() => { set("featureKeys", [...d.featureKeys, f.key]); setFind(""); }}><Plus size={14} aria-hidden="true" />{f.name}<small>{CATEGORIES.find((c) => c.key === f.category)?.label}</small></button>)}</div> : null}
          </div>
        </div>
      </div>
      {idea ? <p className={css.legend}>Priority <b style={{ color: "var(--ink)" }}>{priority({ ...d, votes: idea.votes })}</b> · {idea.votes} {idea.votes === 1 ? "vote" : "votes"}</p> : null}
      {feature ? <p className={css.draftNote} style={{ background: "color-mix(in srgb, var(--good) 9%, var(--surface))" }}><Rocket size={16} aria-hidden="true" /><span>Became a feature: {feature.name} ({feature.status}).</span></p>
        : idea && hq.canEdit ? <div className={css.block} style={{ padding: 16 }}>
          <div className={css.blockHead}><span className={css.stepNo}><Rocket size={15} aria-hidden="true" /></span><div><h3>Build it</h3><p>Adds it to the catalogue as Building and moves the idea to Building.</p></div></div>
          <div className={css.toolbar}><select className={css.select} style={{ flex: 1 }} value={category} onChange={(e) => setCategory(e.target.value as Category)} aria-label="Product area">{CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</select>
            <button type="button" className={css.secondary} disabled={busy} onClick={() => run(async () => { await hqPost(`ideas/${idea.id}`, d); await hqPost(`ideas/${idea.id}/convert`, { category }); })}>Turn into a feature</button></div>
        </div> : null}
      {error ? <p className={css.draftNote} role="alert"><CircleAlert size={16} aria-hidden="true" /><span>{error}</span></p> : null}
    </div>
    <div className={css.sheetFoot}>
      <button type="button" className={css.primary} disabled={busy || d.title.trim().length < 2} onClick={() => void save()}>{idea ? "Save" : "Add idea"}</button>
      <button type="button" className={css.ghost} onClick={onClose}>Cancel</button>
      <span className={css.grow} />
      {idea ? <button type="button" className={`${css.ghost} ${css.danger}`} disabled={busy} onClick={() => { if (window.confirm(`Delete “${idea.title}”?`)) void run(() => hqPost(`ideas/${idea.id}/remove`)); }}><Trash2 size={15} aria-hidden="true" />Delete</button> : null}
    </div>
  </>;
}

function Scale({ value, onChange, label }: { value: number; onChange: (v: number) => void; label: string }) {
  return <span className={css.scale} role="radiogroup" aria-label={label}>{[1, 2, 3, 4, 5].map((n) => <button key={n} type="button" role="radio" aria-checked={value === n} data-on={value === n ? "" : undefined} onClick={() => onChange(n)}>{n}</button>)}</span>;
}
