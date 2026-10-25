"use client";
// PULSE-HQ (owner, 23 Oct 2026): Stack Intelligence, the workbench. The tools an organisation weighs in the fast sheet
// (sheet, board by status or verdict, compact, gallery, free) plus four views of its own: the radar (rings by verdict,
// sectors by category), a comparison of 2–5 tools side by side, the budget (adopted and trial monthly cost by category,
// three scenarios and every stack's total) and the stacks (named sets of tools, shared by link or published to the
// Pulse stack directory). A row opens the tool's sheet with every field, its sources and benchmarks.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Boxes, CircleAlert, Copy, ExternalLink, Globe, Layers, Link2, Plus, Radar as RadarIcon, Scale, Share2, Trash2, Wallet, X } from "lucide-react";
import { useDialog, useSoonRefresh } from "../hq/client";
import { Grid, type Col, type ExtraView } from "../hq/grid/grid";
import { Floating, OptionList } from "../hq/grid/pop";
import { SlashText } from "../hq/grid/slash";
import { patchGridSettings } from "../hq/grid/state";
import hq from "../hq/hq.module.css";
import { CATEGORY_OF, STACK_CATEGORIES, TOOL_STATUS, VERDICTS, dollars, inrOf, rupees, stackCost, usdOf, type Metric, type Source, type Stack, type StackData, type StackItem, type Tool } from "./model";
import css from "./stack.module.css";
import { spreadDots } from "../lib/radar-spread.mjs";

export async function stackPost<T = { ok: true }>(path: string, body: unknown = {}): Promise<T> {
  const r = await fetch(`/api/v0/stack/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(typeof d?.error === "string" ? d.error : typeof d?.message === "string" ? d.message : "That did not save. Try again.");
  return d as T;
}

const CAT_OPTS = STACK_CATEGORIES.map((c) => ({ key: c.key, label: c.label, tone: `hsl(${c.hue} 60% 45%)` }));
const DEFAULTS = { kind: "sheet", boardBy: "status", groupBy: "category" };
const cost = (t: Tool) => inrOf(t.costInr, t.costUsd);

export function StackWorkbench({ data, openStack }: { data: StackData; openStack: string | null }) {
  const router = useRouter();
  const refresh = useCallback(() => router.refresh(), [router]);
  const soon = useSoonRefresh(refresh);
  const [openTool, setOpenTool] = useState<string | null>(null);
  const [stackId, setStackId] = useState<string | null>(openStack);
  const [compare, setCompare] = useState<string[]>([]);
  const tools = data.tools;
  const byId = useMemo(() => new Map(tools.map((t) => [t.id, t])), [tools]);
  const people = data.people;

  const cols = useMemo<Col<Tool>[]>(() => [
    { key: "name", label: "Tool", kind: "title", width: 240 },
    { key: "category", label: "Category", kind: "select", options: CAT_OPTS, group: true, width: 160 },
    { key: "verdict", label: "Verdict", kind: "select", options: VERDICTS, group: true, width: 108 },
    { key: "status", label: "Status", kind: "select", options: TOOL_STATUS, group: true, width: 122 },
    { key: "ownerId", label: "Owner", kind: "person", group: true, width: 140 },
    { key: "useCase", label: "Use case", kind: "text", width: 230 },
    { key: "plan", label: "Plan", kind: "text", width: 190 },
    { key: "costUsd", label: "$ / month", kind: "money", currency: "USD", width: 100 },
    { key: "costInr", label: "₹ / month", kind: "money", currency: "INR", width: 108 },
    { key: "freeTier", label: "Free tier", kind: "long", width: 240 },
    { key: "bestFor", label: "Best for", kind: "text", width: 180 },
    { key: "pros", label: "Pros", kind: "long", width: 220, hidden: true },
    { key: "cons", label: "Cons", kind: "long", width: 220, hidden: true },
    { key: "limits", label: "Limits", kind: "long", width: 220, hidden: true },
    { key: "verdictNote", label: "Verdict note", kind: "text", width: 240, hidden: true },
    { key: "benchmark", label: "Benchmark notes", kind: "long", width: 220, hidden: true },
    { key: "sources", label: "Sources", kind: "view", width: 110, hidden: true, sortValue: (t) => t.sources.length,
      render: (t) => t.sources.length ? <span className={hq.faint}>{t.sources.length} · {t.sources[0].checked || "date?"}</span> : <span className={hq.faint}>—</span> },
  ], []);

  const extraViews: ExtraView<Tool>[] = [
    { key: "radar", label: "Radar", Icon: RadarIcon, render: (rows) => <RadarView tools={rows} onOpen={setOpenTool} /> },
    { key: "compare", label: "Compare", Icon: Scale, render: (rows) => <CompareView tools={rows} all={tools} picked={compare} setPicked={setCompare} onOpen={setOpenTool} /> },
    { key: "budget", label: "Budget", Icon: Wallet, render: (rows) => <BudgetView tools={rows} stacks={data.stacks} byId={byId} onStack={setStackId} /> },
    { key: "stacks", label: "Stacks", Icon: Layers, render: () => <StacksView data={data} byId={byId} onOpen={setStackId} soon={soon} /> },
  ];

  const adopted = tools.filter((t) => t.status === "adopted"), planned = tools.filter((t) => t.verdict === "adopt" || t.verdict === "trial");
  const sum = (list: Tool[]) => list.reduce((n, t) => n + (cost(t) ?? 0), 0);
  return <>
    <header className={hq.pageHead}>
      <div><h1>Stack Intelligence</h1><p>The tools, services, infrastructure and AI models we weigh: cost, free tier, verdict and sources, side by side. Share a stack with any Pulse organisation.</p></div>
      <div className={hq.headActions}><Link href="/stack/directory" className={hq.secondary}><Globe size={15} aria-hidden="true" />Stack directory</Link></div>
    </header>
    <section className={hq.kpis} aria-label="At a glance">
      <div className={hq.kpi}><span className={hq.kpiLabel}>Tools</span><span className={hq.kpiValue}>{tools.length}</span>
        <span className={css.verdictBar} role="img" aria-label={VERDICTS.map((v) => `${tools.filter((t) => t.verdict === v.key).length} ${v.label.toLowerCase()}`).join(", ")}>
          {VERDICTS.map((v) => <i key={v.key} style={{ flexGrow: tools.filter((t) => t.verdict === v.key).length, background: v.tone }} />)}</span></div>
      <div className={hq.kpi}><span className={hq.kpiLabel}>Adopted, per month</span><span className={hq.kpiValue}>{rupees(sum(adopted))}</span><span className={hq.kpiSub}>{adopted.length} adopted · {dollars(adopted.reduce((n, t) => n + (usdOf(t.costInr, t.costUsd) ?? 0), 0))}</span></div>
      <div className={hq.kpi}><span className={hq.kpiLabel}>Adopt + trial on the radar</span><span className={hq.kpiValue}>{rupees(sum(planned))}</span><span className={hq.kpiSub}>{toolCount(planned.length)} at their listed plans</span></div>
      <div className={hq.kpi}><span className={hq.kpiLabel}>Stacks</span><span className={hq.kpiValue}>{data.stacks.length}</span><span className={hq.kpiSub}>{data.stacks.filter((s) => s.shareToken).length} shared · {data.stacks.filter((s) => s.sharedPublic).length} in the directory</span></div>
    </section>
    <Grid<Tool> scope="stack-tools" rows={tools} cols={cols} people={people} noun="tool" defaults={DEFAULTS} extraViews={extraViews}
      canEdit={() => true} canCreate canReorder canRemove={data.canEdit} bulk={["status", "verdict", "category", "ownerId"]}
      onPatch={async (id, patch) => { await stackPost(`tools/${id}`, patch); soon(); }}
      onCreate={async (fields) => { await stackPost("tools", fields); soon(); }}
      onBatch={async (items) => { await stackPost("tools/batch", { items }); soon(); }}
      onBulk={async (ids, patch) => { await stackPost("tools/bulk", patch ? { ids, patch } : { ids, remove: true }); soon(); }}
      onReorder={async (ids) => { await stackPost("tools/reorder", { ids }); soon(); }}
      onOpen={setOpenTool}
      bulkExtra={(ids, clear) => <>
        <AddToStack stacks={data.stacks} ids={ids} done={() => { clear(); soon(); }} />
        {ids.length >= 2 && ids.length <= 5 ? <button type="button" className={css.bulkBtn} onClick={() => { setCompare(ids); clear(); patchGridSettings("stack-tools", { kind: "compare" }); }}><Scale size={14} aria-hidden="true" />Compare</button> : null}
      </>}
      cardExtra={(t) => <span className={css.cardCost}>{cost(t) === null ? "Price unknown" : cost(t) === 0 ? "Free" : `${rupees(cost(t))}/mo`}{t.plan ? <small> · {t.plan}</small> : null}</span>} />
    <ToolSheet tool={openTool ? byId.get(openTool) ?? null : null} people={people} canRemove={data.canEdit} onClose={() => setOpenTool(null)} onSaved={soon} />
    <StackSheet stack={stackId ? data.stacks.find((s) => s.id === stackId) ?? null : null} tools={tools} byId={byId} canEdit={data.canEdit} org={data.org || "this organisation"} onClose={() => setStackId(null)} onSaved={soon} />
  </>;
}

/* ------------------------------------------------------------------------------------------------ radar */

const RINGS: { key: Tool["verdict"]; r0: number; r1: number }[] = [{ key: "adopt", r0: 0, r1: 112 }, { key: "trial", r0: 112, r1: 182 }, { key: "assess", r0: 182, r1: 240 }, { key: "hold", r0: 240, r1: 292 }];
const hash = (s: string, seed: number) => { let h = seed; for (const ch of s) h = (h * 33 + ch.charCodeAt(0)) >>> 0; return (h % 1000) / 1000; };

const toolCount = (n: number) => `${n} ${n === 1 ? "tool" : "tools"}`;

function RadarView({ tools, onOpen }: { tools: Tool[]; onOpen: (id: string) => void }) {
  const cats = useMemo(() => STACK_CATEGORIES.filter((c) => tools.some((t) => t.category === c.key)), [tools]);
  const span = (Math.PI * 2) / Math.max(1, cats.length);
  const dots = useMemo(() => spreadDots(tools.filter((t) => t.status !== "dropped").map((t, i) => {
    const ci = cats.findIndex((c) => c.key === t.category), ring = RINGS.find((r) => r.key === t.verdict) ?? RINGS[2];
    const a0 = -Math.PI / 2 + ci * span, rMin = ring.r0 + (ring.key === "adopt" ? 26 : 12), rMax = ring.r1 - 12;
    const a = a0 + (0.12 + hash(t.name, 7) * 0.76) * span, rr = rMin + hash(t.name, 13) * (rMax - rMin);
    return { t, n: i + 1, x: 300 + Math.cos(a) * rr, y: 300 + Math.sin(a) * rr, a0, a1: a0 + span, rMin, rMax };
  })), [tools, cats, span]);
  const [hover, setHover] = useState<string | null>(null);
  return <div className={css.radarWrap}>
    <figure className={css.radar}>
      <svg viewBox="0 0 600 600" role="img" aria-label={`Tech radar of ${dots.length} tools`}>
        {RINGS.slice().reverse().map((r) => <circle key={r.key} cx="300" cy="300" r={r.r1} className={css.ring} data-ring={r.key} />)}
        {cats.map((c, i) => { const a = -Math.PI / 2 + i * span; return <line key={c.key} x1="300" y1="300" x2={300 + Math.cos(a) * 292} y2={300 + Math.sin(a) * 292} className={css.spoke} />; })}
        {RINGS.map((r) => <text key={r.key} x="300" y={300 - r.r1 + 14} className={css.ringLabel}>{VERDICTS.find((v) => v.key === r.key)?.label}</text>)}
        {dots.map((d) => <g key={d.t.id} className={css.dot} data-on={hover === d.t.id ? "" : undefined} style={{ "--hue": CATEGORY_OF[d.t.category]?.hue ?? 0 } as CSSProperties}
          onMouseEnter={() => setHover(d.t.id)} onMouseLeave={() => setHover(null)} onClick={() => onOpen(d.t.id)} tabIndex={0} role="button" aria-label={`${d.t.name}: ${d.t.verdict}`}
          onKeyDown={(e) => { if (e.key === "Enter") onOpen(d.t.id); }}>
          <circle cx={d.x} cy={d.y} r="9" /><text x={d.x} y={d.y + 3.5}>{d.n}</text>
        </g>)}
      </svg>
      <figcaption className={css.cats}>{cats.map((c, i) => <span key={c.key} style={{ "--hue": c.hue } as CSSProperties}><i />{i + 1}. {c.label}</span>)}</figcaption>
    </figure>
    <div className={css.radarList}>
      {RINGS.map((r) => { const own = dots.filter((d) => d.t.verdict === r.key); const v = VERDICTS.find((x) => x.key === r.key)!;
        return <section key={r.key} aria-label={v.label}><h3 style={{ color: v.tone }}>{v.label} <small>{own.length} · {v.hint}</small></h3>
          <ol className={css.radarItems}>{own.map((d) => <li key={d.t.id}><button type="button" data-on={hover === d.t.id ? "" : undefined} onMouseEnter={() => setHover(d.t.id)} onMouseLeave={() => setHover(null)} onClick={() => onOpen(d.t.id)}>
            <b style={{ "--hue": CATEGORY_OF[d.t.category]?.hue ?? 0 } as CSSProperties}>{d.n}</b><span>{d.t.name}</span><small>{CATEGORY_OF[d.t.category]?.label}</small></button></li>)}</ol>
        </section>; })}
    </div>
  </div>;
}

/* ------------------------------------------------------------------------------------------------ compare */

function CompareView({ tools, all, picked, setPicked, onOpen }: { tools: Tool[]; all: Tool[]; picked: string[]; setPicked: (ids: string[]) => void; onOpen: (id: string) => void }) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const list = picked.map((id) => all.find((t) => t.id === id)).filter((t): t is Tool => !!t);
  const cheapest = Math.min(...list.map((t) => cost(t) ?? Infinity));
  const rows: { label: string; get: (t: Tool) => ReactNode; best?: (t: Tool) => boolean }[] = [
    { label: "Category", get: (t) => CATEGORY_OF[t.category]?.label },
    { label: "Verdict", get: (t) => <span className={css.pill} style={{ "--tone": VERDICTS.find((v) => v.key === t.verdict)?.tone } as CSSProperties}>{VERDICTS.find((v) => v.key === t.verdict)?.label}</span> },
    { label: "Status", get: (t) => TOOL_STATUS.find((s) => s.key === t.status)?.label },
    { label: "Use case", get: (t) => t.useCase || "—" },
    { label: "Plan", get: (t) => t.plan || "—" },
    { label: "Monthly cost", get: (t) => <>{rupees(cost(t))}<small> · {dollars(usdOf(t.costInr, t.costUsd))}</small></>, best: (t) => list.length > 1 && cost(t) === cheapest },
    { label: "Free tier", get: (t) => t.freeTier || "—" },
    { label: "Limits", get: (t) => t.limits || "—" },
    { label: "Pros", get: (t) => <Lines text={t.pros} /> },
    { label: "Cons", get: (t) => <Lines text={t.cons} /> },
    { label: "Best for", get: (t) => t.bestFor || "—" },
    { label: "Verdict note", get: (t) => t.verdictNote || "—" },
    { label: "Benchmarks", get: (t) => <>{t.metrics.map((m) => <span key={m.label} className={css.metric}>{m.label}: <b>{m.value}{m.unit ? ` ${m.unit}` : ""}</b></span>)}{t.benchmark ? <Lines text={t.benchmark} /> : t.metrics.length ? null : "—"}</> },
    { label: "Sources", get: (t) => t.sources.length ? <ul className={css.sources}>{t.sources.map((s) => <li key={s.url}><a href={s.url} target="_blank" rel="noreferrer">{s.label || hostOf(s.url)}</a>{s.checked ? <small> · {s.checked}</small> : null}</li>)}</ul> : "—" },
  ];
  const choices = tools.filter((t) => !picked.includes(t.id)).map((t) => ({ key: t.id, label: t.name, hint: CATEGORY_OF[t.category]?.label }));
  return <div className={css.compare}>
    <div className={css.pickBar}>
      {list.map((t) => <span key={t.id} className={css.picked}><button type="button" onClick={() => onOpen(t.id)}>{t.name}</button><button type="button" aria-label={`Remove ${t.name}`} onClick={() => setPicked(picked.filter((x) => x !== t.id))}><X size={13} /></button></span>)}
      {list.length < 5 ? <button type="button" className={css.addPick} onClick={(e) => setEl(el ? null : e.currentTarget)}><Plus size={14} aria-hidden="true" />{list.length ? "Add a tool" : "Pick 2–5 tools"}</button> : null}
      {el ? <Floating anchor={el} onClose={() => setEl(null)} label="Add a tool to compare" width={320}>
        <OptionList choices={choices} value={[]} onPick={(k) => { setPicked([...picked, k].slice(0, 5)); setEl(null); }} onCancel={() => setEl(null)} placeholder="Find a tool…" />
      </Floating> : null}
      <span className={hq.grow} />
      {list.length ? <button type="button" className={hq.linkBtn} onClick={() => setPicked([])}>Clear</button> : null}
    </div>
    {list.length < 2 ? <p className={css.empty}><Scale size={20} aria-hidden="true" />Pick two to five tools to see them side by side, or select them in the sheet and press Compare.</p>
      : <div className={css.compareWrap}><table className={css.compareTable} style={{ "--n": list.length } as CSSProperties}>
        <thead><tr><th scope="col"><span className={hq.vh}>Field</span></th>{list.map((t) => <th key={t.id} scope="col"><button type="button" className={css.colHead} onClick={() => onOpen(t.id)}>{t.name}</button></th>)}</tr></thead>
        <tbody>{rows.map((r) => <tr key={r.label}><th scope="row">{r.label}</th>{list.map((t) => <td key={t.id} data-best={r.best?.(t) ? "" : undefined}>{r.get(t)}</td>)}</tr>)}</tbody>
      </table></div>}
  </div>;
}
const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };
function Lines({ text }: { text: string }) {
  const lines = text.split("\n").map((l) => l.replace(/^[•\-*]\s*/, "").trim()).filter(Boolean);
  return lines.length > 1 ? <ul className={css.lines}>{lines.map((l, i) => <li key={i}>{l}</li>)}</ul> : <>{lines[0] ?? "—"}</>;
}

/* ------------------------------------------------------------------------------------------------ budget */

function BudgetView({ tools, stacks, byId, onStack }: { tools: Tool[]; stacks: Stack[]; byId: Map<string, Tool>; onStack: (id: string) => void }) {
  const scenarios = [
    { key: "now", label: "Adopted now", hint: "Tools with status Adopted", pick: (t: Tool) => t.status === "adopted" },
    { key: "trial", label: "Adopted + on trial", hint: "Status Adopted or Trial", pick: (t: Tool) => t.status === "adopted" || t.status === "trial" },
    { key: "radar", label: "Radar plan", hint: "Verdict Adopt or Trial, at their listed plans", pick: (t: Tool) => t.verdict === "adopt" || t.verdict === "trial" },
  ].map((s) => { const own = tools.filter(s.pick);
    const byCat = STACK_CATEGORIES.map((c) => ({ ...c, inr: own.filter((t) => t.category === c.key).reduce((n, t) => n + (cost(t) ?? 0), 0), n: own.filter((t) => t.category === c.key).length })).filter((c) => c.n);
    return { ...s, own, byCat, inr: byCat.reduce((n, c) => n + c.inr, 0), usd: own.reduce((n, t) => n + (usdOf(t.costInr, t.costUsd) ?? 0), 0), unknown: own.filter((t) => cost(t) === null).length }; });
  const max = Math.max(1, ...scenarios.flatMap((s) => s.byCat.map((c) => c.inr)));
  return <div className={css.budget}>
    <div className={css.scenarios}>{scenarios.map((s) => <section key={s.key} className={css.scenario} aria-label={s.label}>
      <p className={css.scLabel}>{s.label}<small>{s.hint}</small></p>
      <p className={css.scTotal}>{rupees(s.inr)}<small>/month · {dollars(Math.round(s.usd * 100) / 100)}</small></p>
      <p className={css.scSub}>{toolCount(s.own.length)}{s.unknown ? ` · ${s.unknown} without a price` : ""}</p>
      <ul className={css.catBars}>{s.byCat.sort((a, b) => b.inr - a.inr).map((c) => <li key={c.key} style={{ "--hue": c.hue } as CSSProperties}>
        <span>{c.label}<small>{c.n}</small></span><i style={{ width: `${Math.max(2, (c.inr / max) * 100)}%` }} /><b>{c.inr ? rupees(c.inr) : "Free"}</b></li>)}</ul>
    </section>)}</div>
    {stacks.length ? <section className={css.stackTotals} aria-labelledby="budget-stacks">
      <h2 id="budget-stacks">Stacks, new spend per month</h2>
      <ul>{stacks.map((s) => { const c = stackCost(s, byId); return <li key={s.id}><button type="button" onClick={() => onStack(s.id)}>
        <span>{s.name}<small>{toolCount(s.items.length)}{c.existing ? ` · plus ${rupees(c.existing)} already paid` : ""}</small></span><b>{rupees(c.inr)}</b></button></li>; })}</ul>
    </section> : null}
  </div>;
}

/* ------------------------------------------------------------------------------------------------ stacks */

function StacksView({ data, byId, onOpen, soon }: { data: StackData; byId: Map<string, Tool>; onOpen: (id: string) => void; soon: () => void }) {
  const org = data.org || "us";
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  return <div className={css.stacks}>
    <form className={css.newStack} onSubmit={async (e) => { e.preventDefault(); if (name.trim().length < 2) return;
      try { const r = await stackPost<{ id: string }>("stacks", { name: name.trim(), items: [] }); setName(""); soon(); onOpen(r.id); } catch (x) { setError(x instanceof Error ? x.message : "Not saved"); } }}>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New stack, e.g. “Small AI dev team”" aria-label="New stack name" maxLength={80} />
      <button type="submit" className={hq.primary} disabled={name.trim().length < 2}><Plus size={15} aria-hidden="true" />Create</button>
      <span className={hq.faint}>Or select tools in the sheet and choose “Add to stack”.</span>
    </form>
    {error ? <p className={hq.draftNote} role="alert"><CircleAlert size={16} aria-hidden="true" /><span>{error}</span></p> : null}
    <ul className={css.stackGrid}>{data.stacks.map((s) => { const c = stackCost(s, byId);
      const cats = [...new Set(s.items.map((i) => byId.get(i.toolId)?.category).filter(Boolean))] as Tool["category"][];
      return <li key={s.id}><button type="button" className={css.stackCard} onClick={() => onOpen(s.id)}>
        <span className={css.stackTop}><Boxes size={18} aria-hidden="true" /><b>{s.name}</b>{s.sharedPublic ? <span className={css.badge}><Globe size={12} aria-hidden="true" />Directory</span> : s.shareToken ? <span className={css.badge}><Link2 size={12} aria-hidden="true" />Shared</span> : null}</span>
        {s.blurb ? <span className={css.stackBlurb}>{s.blurb}</span> : null}
        <span className={css.stackCost}>{rupees(c.inr)}<small>/month new spend</small></span>
        {c.existing ? <span className={css.costNote} title={`${rupees(c.existing)} a month ${org} already pays for: not counted as new spend`}>+ {rupees(c.existing)} already paid, not counted</span> : null}
        <span className={css.stackCats}>{cats.slice(0, 6).map((k) => <i key={k} style={{ "--hue": CATEGORY_OF[k]?.hue ?? 0 } as CSSProperties}>{CATEGORY_OF[k]?.label}</i>)}</span>
        <span className={hq.faint}>{toolCount(s.items.length)}{s.copiedFrom ? ` · from ${s.copiedFrom}` : ""}</span>
      </button></li>; })}</ul>
  </div>;
}

function AddToStack({ stacks, ids, done }: { stacks: Stack[]; ids: string[]; done: () => void }) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const add = async (key: string) => {
    setEl(null);
    try {
      if (key === "+new") { const name = window.prompt("Name the new stack"); if (!name || name.trim().length < 2) return; await stackPost("stacks", { name: name.trim(), toolIds: ids }); }
      else { const s = stacks.find((x) => x.id === key); if (!s) return; const have = new Set(s.items.map((i) => i.toolId));
        await stackPost(`stacks/${s.id}`, { items: [...s.items, ...ids.filter((id) => !have.has(id)).map((toolId) => ({ toolId }))] }); }
      done();
    } catch (e) { setError(e instanceof Error ? e.message : "Not saved"); }
  };
  return <>
    <button type="button" className={css.bulkBtn} onClick={(e) => setEl(el ? null : e.currentTarget)} title={error ?? undefined}><Layers size={14} aria-hidden="true" />Add to stack</button>
    {el ? <Floating anchor={el} onClose={() => setEl(null)} label="Add to stack">
      <OptionList choices={[{ key: "+new", label: "New stack…" }, ...stacks.map((s) => ({ key: s.id, label: s.name, hint: `${s.items.length}` }))]} value={[]} onPick={(k) => void add(k)} onCancel={() => setEl(null)} placeholder="Stack…" />
    </Floating> : null}
  </>;
}

function StackSheet({ stack, tools, byId, canEdit, org, onClose, onSaved }: { stack: Stack | null; tools: Tool[]; byId: Map<string, Tool>; canEdit: boolean; org: string; onClose: () => void; onSaved: () => void }) {
  const ref = useDialog(stack !== null, onClose);
  return <dialog ref={ref} className={`${hq.sheet} ${hq.glassThick} ${css.wideSheet}`} aria-label={stack?.name ?? "Stack"}>
    {stack ? <StackBody key={stack.id + stack.updatedAt} stack={stack} tools={tools} byId={byId} canEdit={canEdit} org={org} onClose={onClose} onSaved={onSaved} /> : null}
  </dialog>;
}

function StackBody({ stack, tools, byId, canEdit, org, onClose, onSaved }: { stack: Stack; tools: Tool[]; byId: Map<string, Tool>; canEdit: boolean; org: string; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(stack.name);
  const [blurb, setBlurb] = useState(stack.blurb);
  const [items, setItems] = useState<StackItem[]>(stack.items.filter((i) => byId.has(i.toolId)));
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [token, setToken] = useState(stack.shareToken);
  const [pub, setPub] = useState(stack.sharedPublic);
  const dirty = name !== stack.name || blurb !== stack.blurb || JSON.stringify(items) !== JSON.stringify(stack.items.filter((i) => byId.has(i.toolId)));
  const c = stackCost({ items }, byId);
  const run = async (work: () => Promise<unknown>, msg?: string) => { setBusy(true); setNote(null);
    try { await work(); onSaved(); if (msg) setNote(msg); } catch (e) { setNote(e instanceof Error ? e.message : "Not saved"); } finally { setBusy(false); } };
  const setItem = (i: number, patch: Partial<StackItem>) => setItems((x) => x.map((it, j) => j === i ? { ...it, ...patch } : it));
  const num = (v: string) => v.trim() === "" ? null : Math.max(0, Number(v.replace(/[,₹$\s]/g, "")) || 0);
  const link = token ? `/stack/s/${token}` : null;
  return <>
    <div className={hq.sheetScroll}>
      <div className={hq.sheetHead}>
        <div><span className={hq.subhead}>Stack{stack.copiedFrom ? ` · from ${stack.copiedFrom}` : ""}</span>
          <input className={hq.studioName} style={{ fontSize: 24, marginTop: 6, width: "100%" }} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} aria-label="Stack name" />
          <textarea className={hq.textarea} style={{ marginTop: 8, minHeight: 64 }} value={blurb} maxLength={600} placeholder="Who it is for and what it costs" onChange={(e) => setBlurb(e.target.value)} aria-label="About this stack" /></div>
        <button type="button" className={hq.iconBtn} onClick={onClose} aria-label="Close"><X size={17} /></button>
      </div>
      <p className={css.spendHead} data-testid="new-spend"><span>New spend for {org}</span><b>{rupees(c.inr)}<small>/month · {dollars(Math.round(c.usd * 100) / 100)}</small></b>
        {c.existing || c.unknown ? <small>{c.existing ? `${rupees(c.existing)} already paid by ${org}, not counted` : ""}{c.existing && c.unknown ? " · " : ""}{c.unknown ? `${c.unknown} without a price` : ""}</small> : null}</p>
      <div className={css.itemsWrap}><table className={css.items}>
        <thead><tr><th scope="col">Tool</th><th scope="col">Plan in this stack</th><th scope="col">₹ / month</th><th scope="col">$ / month</th><th scope="col">Note</th><th scope="col"><span className={hq.vh}>Already paid by {org}, remove</span></th></tr></thead>
        <tbody>{items.map((it, i) => { const t = byId.get(it.toolId)!; return <tr key={it.toolId}>
          <th scope="row"><span>{t.name}</span><small>{CATEGORY_OF[t.category]?.label}</small>
            {it.existing ? <small className={css.paidOurs}>Already paid by {org}</small> : it.paidBy ? <small className={css.paidBy}>Paid by {it.paidBy}, not by {org}</small> : null}</th>
          <td><input value={it.plan ?? ""} placeholder={t.plan} onChange={(e) => setItem(i, { plan: e.target.value })} aria-label={`${t.name} plan`} /></td>
          <td><input inputMode="decimal" value={it.inr ?? ""} placeholder={t.costInr === null ? "" : String(t.costInr)} onChange={(e) => setItem(i, { inr: num(e.target.value) })} aria-label={`${t.name} rupees per month`} /></td>
          <td><input inputMode="decimal" value={it.usd ?? ""} placeholder={t.costUsd === null ? "" : String(t.costUsd)} onChange={(e) => setItem(i, { usd: num(e.target.value) })} aria-label={`${t.name} dollars per month`} /></td>
          <td><input value={it.note ?? ""} onChange={(e) => setItem(i, { note: e.target.value })} aria-label={`${t.name} note`} /></td>
          <td className={css.itemActs}><label title={`${org} already pays for it: left out of new spend`}><input type="checkbox" checked={!!it.existing} onChange={(e) => setItem(i, { existing: e.target.checked })} />Paid</label>
            <button type="button" className={hq.iconBtn} aria-label={`Remove ${t.name}`} onClick={() => setItems((x) => x.filter((_, j) => j !== i))}><X size={15} /></button></td>
        </tr>; })}</tbody>
      </table></div>
      <div className={hq.toolbar}>
        <button type="button" className={hq.secondary} onClick={(e) => setEl(el ? null : e.currentTarget)}><Plus size={15} aria-hidden="true" />Add a tool</button>
        {el ? <Floating anchor={el} onClose={() => setEl(null)} label="Add a tool" width={320}>
          <OptionList choices={tools.filter((t) => !items.some((i) => i.toolId === t.id)).map((t) => ({ key: t.id, label: t.name, hint: CATEGORY_OF[t.category]?.label }))} value={[]}
            onPick={(k) => { setItems((x) => [...x, { toolId: k }]); setEl(null); }} onCancel={() => setEl(null)} placeholder="Find a tool…" />
        </Floating> : null}
      </div>
      {canEdit ? <section className={css.share} aria-label="Share">
        <h3><Share2 size={16} aria-hidden="true" />Share this stack</h3>
        <p>Others signed in to Pulse see a read-only copy and can use it in their organisation. Saving again updates what they see.</p>
        {token && link ? <div className={css.shareRow}><input readOnly value={link} aria-label="Share link" onFocus={(e) => e.target.select()} />
          <button type="button" className={hq.secondary} onClick={() => { void navigator.clipboard?.writeText(window.location.origin + link).then(() => setNote("Link copied")); }}><Copy size={15} aria-hidden="true" />Copy</button>
          <Link className={hq.secondary} href={`/stack/s/${token}`}><ExternalLink size={15} aria-hidden="true" />View</Link></div> : null}
        <div className={hq.toolbar}>
          <label className={css.toggle}><input type="checkbox" checked={pub} disabled={busy} onChange={(e) => { const on = e.target.checked; setPub(on); void run(async () => { try { const r = await stackPost<{ token: string; public: boolean }>(`stacks/${stack.id}/share`, { public: on }); setToken(r.token); setPub(r.public); } catch (x) { setPub(!on); throw x; } }, on ? "Published to the Pulse stack directory" : "Removed from the directory; the link still works"); }} />
            List it in the Pulse stack directory</label>
          {!token ? <button type="button" className={hq.secondary} disabled={busy} onClick={() => void run(async () => { const r = await stackPost<{ token: string; public: boolean }>(`stacks/${stack.id}/share`, { public: false }); setToken(r.token); setPub(false); }, "Share link made")}><Link2 size={15} aria-hidden="true" />Make a share link</button>
            : <button type="button" className={hq.ghost} disabled={busy} onClick={() => void run(async () => { await stackPost(`stacks/${stack.id}/unshare`); setToken(null); setPub(false); }, "No longer shared")}>Stop sharing</button>}
        </div>
      </section> : null}
      {note ? <p className={hq.draftNote} role="status"><CircleAlert size={16} aria-hidden="true" /><span>{note}</span></p> : null}
    </div>
    <div className={hq.sheetFoot}>
      <button type="button" className={hq.primary} disabled={busy || !dirty || name.trim().length < 2} onClick={() => void run(() => stackPost(`stacks/${stack.id}`, { name, blurb, items }), "Saved")}>Save</button>
      <button type="button" className={hq.ghost} onClick={onClose}>Close</button>
      <span className={hq.grow} />
      {canEdit ? <button type="button" className={`${hq.ghost} ${hq.danger}`} disabled={busy} onClick={() => { if (window.confirm(`Delete the stack “${stack.name}”? Its tools stay.`)) void run(async () => { await stackPost(`stacks/${stack.id}/remove`); onClose(); }); }}><Trash2 size={15} aria-hidden="true" />Delete</button> : null}
    </div>
  </>;
}

/* ------------------------------------------------------------------------------------------------ one tool */

type ToolDraft = Omit<Tool, "id" | "owner" | "sort" | "createdAt" | "updatedAt">;
const draftOf = (t: Tool): ToolDraft => ({ name: t.name, category: t.category, useCase: t.useCase, plan: t.plan, costUsd: t.costUsd, costInr: t.costInr, freeTier: t.freeTier, limits: t.limits,
  pros: t.pros, cons: t.cons, bestFor: t.bestFor, verdict: t.verdict, verdictNote: t.verdictNote, status: t.status, ownerId: t.ownerId, sources: t.sources, benchmark: t.benchmark, metrics: t.metrics, url: t.url });

function ToolSheet({ tool, people, canRemove, onClose, onSaved }: { tool: Tool | null; people: { id: string; name: string }[]; canRemove: boolean; onClose: () => void; onSaved: () => void }) {
  const ref = useDialog(tool !== null, onClose);
  return <dialog ref={ref} className={`${hq.sheet} ${hq.glassThick} ${css.wideSheet}`} aria-label={tool?.name ?? "Tool"}>
    {tool ? <ToolBody key={tool.id + tool.updatedAt} tool={tool} people={people} canRemove={canRemove} onClose={onClose} onSaved={onSaved} /> : null}
  </dialog>;
}

function ToolBody({ tool, people, canRemove, onClose, onSaved }: { tool: Tool; people: { id: string; name: string }[]; canRemove: boolean; onClose: () => void; onSaved: () => void }) {
  const [d, setD] = useState<ToolDraft>(() => draftOf(tool));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof ToolDraft>(k: K, v: ToolDraft[K]) => setD((x) => ({ ...x, [k]: v }));
  const num = (v: string) => v.trim() === "" ? null : Math.max(0, Number(v.replace(/[,₹$\s]/g, "")) || 0);
  const today = new Date().toISOString().slice(0, 10);
  const run = async (work: () => Promise<unknown>, close = true) => { setBusy(true); setError(null);
    try { await work(); onSaved(); if (close) onClose(); } catch (e) { setError(e instanceof Error ? e.message : "Not saved"); } finally { setBusy(false); } };
  const save = () => run(() => stackPost(`tools/${tool.id}`, { ...d, url: d.url ?? "" }));
  const setSource = (i: number, p: Partial<Source>) => set("sources", d.sources.map((s, j) => j === i ? { ...s, ...p } : s));
  const setMetric = (i: number, p: Partial<Metric>) => set("metrics", d.metrics.map((m, j) => j === i ? { ...m, ...p } : m));
  const field = (label: string, k: "useCase" | "plan" | "bestFor" | "verdictNote", wide = false, max = 300) =>
    <label className={`${hq.fieldLabel} ${wide ? hq.wide : ""}`}><span>{label}</span><input className={hq.input} value={d[k]} maxLength={max} onChange={(e) => set(k, e.target.value)} /></label>;
  const long = (label: string, k: "freeTier" | "limits" | "pros" | "cons" | "benchmark", hint?: string) =>
    <label className={`${hq.fieldLabel} ${hq.wide}`}><span>{label}{hint ? <small>{hint}</small> : null}</span><SlashText className={hq.textarea} value={d[k]} onValue={(v) => set(k, v)} onSubmit={() => void save()} rows={3} /></label>;
  return <>
    <div className={hq.sheetScroll}>
      <div className={hq.sheetHead} style={{ "--hue": CATEGORY_OF[d.category]?.hue ?? 0 } as CSSProperties}>
        <div><span className={hq.subhead}>{CATEGORY_OF[d.category]?.label} · {VERDICTS.find((v) => v.key === d.verdict)?.label}</span>
          <input className={hq.studioName} style={{ fontSize: 24, marginTop: 6, width: "100%" }} value={d.name} maxLength={80} onChange={(e) => set("name", e.target.value)} aria-label="Tool name" /></div>
        <button type="button" className={hq.iconBtn} onClick={onClose} aria-label="Close"><X size={17} /></button>
      </div>
      <div className={hq.formGrid}>
        <label className={hq.fieldLabel}><span>Category</span><select className={hq.select} value={d.category} onChange={(e) => set("category", e.target.value as Tool["category"])}>{STACK_CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</select></label>
        <label className={hq.fieldLabel}><span>Owner</span><select className={hq.select} value={d.ownerId ?? ""} onChange={(e) => set("ownerId", e.target.value || null)}><option value="">No one</option>{people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <label className={hq.fieldLabel}><span>Verdict</span><select className={hq.select} value={d.verdict} onChange={(e) => set("verdict", e.target.value as Tool["verdict"])}>{VERDICTS.map((v) => <option key={v.key} value={v.key}>{v.label} · {v.hint}</option>)}</select></label>
        <label className={hq.fieldLabel}><span>Status</span><select className={hq.select} value={d.status} onChange={(e) => set("status", e.target.value as Tool["status"])}>{TOOL_STATUS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select></label>
        {field("Use case", "useCase", true, 600)}
        {field("Plan", "plan", true)}
        <label className={hq.fieldLabel}><span>$ per month</span><input className={hq.input} inputMode="decimal" value={d.costUsd ?? ""} onChange={(e) => set("costUsd", num(e.target.value))} placeholder={d.costInr !== null ? `≈ ${usdOf(d.costInr, null)}` : ""} /></label>
        <label className={hq.fieldLabel}><span>₹ per month</span><input className={hq.input} inputMode="decimal" value={d.costInr ?? ""} onChange={(e) => set("costInr", num(e.target.value))} placeholder={d.costUsd !== null ? `≈ ${inrOf(null, d.costUsd)}` : ""} /></label>
        {long("Free tier", "freeTier")}
        {long("Limits", "limits")}
        {long("Pros", "pros", "one per line; / for blocks")}
        {long("Cons", "cons", "one per line")}
        {field("Best for", "bestFor", true)}
        {field("Verdict note", "verdictNote", true, 400)}
        <label className={`${hq.fieldLabel} ${hq.wide}`}><span>Website</span><input className={`${hq.input} ${hq.mono}`} value={d.url ?? ""} placeholder="https://" onChange={(e) => set("url", e.target.value)} /></label>
        <div className={`${hq.fieldLabel} ${hq.wide}`}><span>Sources <small>link and the day it was checked</small></span>
          <div className={css.rowsEdit}>{d.sources.map((s, i) => <div key={i} className={css.sourceRow}>
            <input className={`${hq.input} ${hq.mono}`} value={s.url} placeholder="https://" onChange={(e) => setSource(i, { url: e.target.value })} aria-label="Source link" />
            <input className={hq.input} type="date" value={s.checked ?? ""} onChange={(e) => setSource(i, { checked: e.target.value })} aria-label="Checked on" />
            <button type="button" className={hq.iconBtn} aria-label="Remove source" onClick={() => set("sources", d.sources.filter((_, j) => j !== i))}><X size={15} /></button></div>)}
            <button type="button" className={hq.linkBtn} onClick={() => set("sources", [...d.sources, { url: "", checked: today }])}>+ Add a source</button></div></div>
        <div className={`${hq.fieldLabel} ${hq.wide}`}><span>Benchmarks <small>a number per line, e.g. build time 4.2 min</small></span>
          <div className={css.rowsEdit}>{d.metrics.map((m, i) => <div key={i} className={css.metricRow}>
            <input className={hq.input} value={m.label} placeholder="What was measured" onChange={(e) => setMetric(i, { label: e.target.value })} aria-label="Measure" />
            <input className={hq.input} value={m.value} placeholder="Value" onChange={(e) => setMetric(i, { value: e.target.value })} aria-label="Value" />
            <input className={hq.input} value={m.unit ?? ""} placeholder="Unit" onChange={(e) => setMetric(i, { unit: e.target.value })} aria-label="Unit" />
            <button type="button" className={hq.iconBtn} aria-label="Remove benchmark" onClick={() => set("metrics", d.metrics.filter((_, j) => j !== i))}><X size={15} /></button></div>)}
            <button type="button" className={hq.linkBtn} onClick={() => set("metrics", [...d.metrics, { label: "", value: "", unit: "" }])}>+ Add a benchmark</button></div></div>
        {long("Benchmark notes", "benchmark")}
      </div>
      {error ? <p className={hq.draftNote} role="alert"><CircleAlert size={16} aria-hidden="true" /><span>{error}</span></p> : null}
    </div>
    <div className={hq.sheetFoot}>
      <button type="button" className={hq.primary} disabled={busy || d.name.trim().length < 2} onClick={() => void save()}>Save</button>
      <button type="button" className={hq.ghost} onClick={onClose}>Cancel</button>
      <span className={hq.grow} />
      {canRemove ? <button type="button" className={`${hq.ghost} ${hq.danger}`} disabled={busy} onClick={() => { if (window.confirm(`Delete “${tool.name}”?`)) void run(() => stackPost(`tools/${tool.id}/remove`)); }}><Trash2 size={15} aria-hidden="true" />Delete</button> : null}
    </div>
  </>;
}
