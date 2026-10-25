"use client";
// PRODUCT-MAP: journeys per user type, as step flows; and the planner: pick a user type, then click screens (where the
// last step leads, or any screen, or a new proposed one) and say what the user does and expects. Gaps (no link between
// two steps, a screen the user type may not open) show as you build.
import { useState } from "react";
import { ArrowDown, ArrowRight, ArrowUp, ClipboardList, Copy, Plus, Search, Trash2, TriangleAlert, X } from "lucide-react";
import { Drawer, DrawerFooter, DrawerSection } from "../kit";
import hq from "../hq/hq.module.css";
import { STATUS, inMenu, linked, nextScreens, pmPost, screenName, secs, type Journey, type JourneyStatus, type MapData, type Persona, type Step } from "./model";
import { Origin, Tag, tone } from "./workbench";
import css from "./pm.module.css";

type Props = { data: MapData; onSaved: () => void };
const ORDER: JourneyStatus[] = ["planned", "drafted", "discovered", "auto", "shipped"];

export function JourneysView({ data, onSaved }: Props) {
  const [who, setWho] = useState<string>(""), [status, setStatus] = useState<JourneyStatus | "">("");
  const [open, setOpen] = useState<Journey | "new" | null>(null);
  const list = data.journeys.filter((j) => (!who || j.personaKey === who) && (!status || j.status === status))
    .sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || (b.usage?.sessions ?? 0) - (a.usage?.sessions ?? 0));
  const n = (k: string) => data.journeys.filter((j) => j.personaKey === k).length;
  return <div className={css.stack}>
    <div className={css.toolbar}>
      <div className={css.seg} role="group" aria-label="User type"><button type="button" aria-pressed={!who} onClick={() => setWho("")}>Everyone</button>
        {data.personas.filter((p) => n(p.key)).map((p) => <button key={p.key} type="button" aria-pressed={who === p.key} onClick={() => setWho(p.key)}>{p.name} <small>{n(p.key)}</small></button>)}</div>
      <select className={hq.input} value={status} onChange={(e) => setStatus(e.target.value as JourneyStatus | "")} aria-label="Status"><option value="">Every status</option>{ORDER.map((s) => <option key={s} value={s}>{STATUS[s].label}</option>)}</select>
      <span className={css.grow} /><button type="button" className={hq.primary} onClick={() => setOpen("new")}><Plus size={15} aria-hidden="true" />Plan a journey</button>
    </div>
    <ul className={css.journeys}>{list.slice(0, 120).map((j) => <li key={j.id}><button type="button" className={css.journey} onClick={() => setOpen(j)} style={tone(STATUS[j.status].tone)}>
      <span className={css.jHead}><b>{j.title}</b><Tag t={STATUS[j.status].tone}>{STATUS[j.status].label}</Tag>{j.priority ? <Tag t={j.priority === "now" ? "var(--bad)" : "var(--warn)"}>{j.priority}</Tag> : null}
        <Origin origin={j.origin} confidence={j.confidence} />{j.usage?.sessions ? <small className={hq.faint}>{j.usage.sessions} sessions{j.usage.medianMs ? ` · ${secs(j.usage.medianMs)}` : ""}</small> : null}</span>
      <Flow data={data} steps={j.steps} persona={data.personas.find((p) => p.key === j.personaKey)} />
    </button></li>)}</ul>
    {!list.length ? <p className={hq.faint}>No journeys here yet. Connect a source (Pulse proposes journeys on its own) or plan one.</p> : list.length > 120 ? <p className={hq.faint}>Showing 120 of {list.length}.</p> : null}
    {open ? <JourneyEditor data={data} journey={open === "new" ? null : open} defaultPersona={who} onClose={() => setOpen(null)} onSaved={onSaved} /> : null}
  </div>;
}

/** The steps as a chain of screens; a gap (no link, a screen the user type may not open) is marked. */
function Flow({ data, steps, persona }: { data: MapData; steps: Step[]; persona?: Persona }) {
  return <span className={css.flow}>{steps.map((s, i) => { const prev = steps[i - 1]?.screen;
    const gap = i > 0 && prev && prev !== s.screen && !linked(data.edges, prev, s.screen);
    const shut = persona?.role && persona.permissions.length > 0 && !persona.permissions.includes(s.screen) && !data.screens.find((x) => x.key === s.screen)?.proposed;
    const proposed = s.proposed || data.screens.find((x) => x.key === s.screen)?.proposed;
    return <span key={i} className={css.flowStep}>{i ? <span className={css.arrow} data-gap={gap ? (inMenu(data.edges, s.screen) ? "menu" : "none") : undefined} title={gap ? (inMenu(data.edges, s.screen) ? "No direct link: through the menu" : "No link between these steps") : undefined}><ArrowRight size={13} aria-hidden="true" /></span> : null}
      <span className={css.node} data-proposed={proposed || undefined} data-shut={shut || undefined}>{screenName(data.screens, s.screen)}{s.element ? <small>{s.element}</small> : null}</span></span>; })}</span>;
}

function JourneyEditor({ data, journey, defaultPersona, onClose, onSaved }: Props & { journey: Journey | null; defaultPersona: string; onClose: () => void }) {
  const [title, setTitle] = useState(journey?.title ?? ""), [personaKey, setPersonaKey] = useState(journey?.personaKey ?? defaultPersona ?? "");
  const [goal, setGoal] = useState(journey?.goal ?? ""), [status, setStatus] = useState<JourneyStatus>(journey?.status === "auto" || journey?.status === "discovered" ? journey.status : journey?.status ?? "drafted");
  const [priority, setPriority] = useState(journey?.priority ?? ""), [target, setTarget] = useState(journey?.targetVersionId ?? "");
  const [steps, setSteps] = useState<Step[]>(journey?.steps ?? []), [acceptance, setAcceptance] = useState((journey?.acceptance ?? []).join("\n"));
  const [q, setQ] = useState(""), [newScreen, setNewScreen] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [note, setNote] = useState<string | null>(null);
  const persona = data.personas.find((p) => p.key === personaKey);
  // Screens proposed here show by name at once (the map reloads a moment later).
  const [added, setAdded] = useState<MapData["screens"]>([]);
  const screens = [...data.screens, ...added.filter((a) => !data.screens.some((s) => s.key === a.key))];
  const live = screens.filter((s) => s.status !== "removed");
  const allowed = (k: string) => !persona?.permissions.length || persona.permissions.includes(k) || !!live.find((s) => s.key === k)?.proposed;
  const last = steps.at(-1)?.screen;
  const next = last ? nextScreens(data.edges, last).filter((k) => live.some((s) => s.key === k)).slice(0, 14) : [...new Set(data.edges.filter((e) => e.from === "*").map((e) => e.to))].slice(0, 14);
  const hits = q ? live.filter((s) => `${s.title} ${s.route}`.toLowerCase().includes(q.toLowerCase())).slice(0, 12) : [];
  const add = (k: string, proposed = false) => { const el = last ? data.edges.find((e) => e.from === last && e.to === k && e.label)?.label ?? "" : "";
    setSteps((x) => [...x, { screen: k, action: el ? `Opens “${el}”` : `Opens ${screenName(screens, k)}`, element: el, expected: `${screenName(screens, k)} shows`, proposed: proposed || undefined }]); setQ(""); };
  const edit = (i: number, f: Partial<Step>) => setSteps((x) => x.map((s, j) => j === i ? { ...s, ...f } : s));
  const move = (i: number, d: number) => setSteps((x) => { const y = [...x]; const t = y[i + d]; if (!t) return x; y[i + d] = y[i]; y[i] = t; return y; });
  const propose = async () => { if (newScreen.trim().length < 2) return; setBusy(true); setError(null);
    try { const r = await pmPost<{ id: string; key: string }>(`products/${data.product.id}/screens`, { title: newScreen }); setAdded((x) => [...x, { id: r.id, key: r.key, route: "", title: newScreen, purpose: "", area: "", access: [], proposed: true, status: "proposed", sources: ["manual"], use: null, file: null, shot: false }]); setSteps((x) => [...x, { screen: r.key, action: `Opens ${newScreen}`, element: "", expected: `${newScreen} shows`, proposed: true }]); setNewScreen(""); onSaved(); }
    catch (e) { setError(e instanceof Error ? e.message : "Not added"); } finally { setBusy(false); } };
  const body = () => ({ title, personaKey, goal, status, priority, targetVersionId: target || null, steps, acceptance: acceptance.split("\n").map((a) => a.trim()).filter(Boolean) });
  const persist = async (): Promise<string | null> => { setBusy(true); setError(null);
    try { let id = journey?.id ?? null; if (journey) await pmPost(`journeys/${journey.id}`, body()); else id = (await pmPost<{ id: string }>(`products/${data.product.id}/journeys`, body())).id; onSaved(); return id; }
    catch (e) { setError(e instanceof Error ? e.message : "Not saved"); return null; } finally { setBusy(false); } };
  const save = async () => { if (await persist()) onClose(); };
  const tasks = async () => { const id = await persist(); if (!id) return;
    try { const r = await pmPost<{ href: string }>(`journeys/${id}/tasks`, {}); setNote(`A task “Build: ${title}” is in Work with the plan in its notes.`); window.open(r.href, "_blank", "noopener"); } catch (e) { setError(e instanceof Error ? e.message : "Not made"); } };
  const copyPlan = async () => { if (!journey) return; try { const r = await fetch(`/api/v0/product-map/products/${data.product.id}/plan?format=md&journeys=${encodeURIComponent(journey.key)}`); await navigator.clipboard.writeText(await r.text()); setNote("The plan for this journey is copied as Markdown."); } catch { setError("Copy did not work here."); } };
  const remove = async () => { if (!journey || !window.confirm(`Remove “${journey.title}”?`)) return; try { await pmPost(`journeys/${journey.id}/remove`); onSaved(); onClose(); } catch (e) { setError(e instanceof Error ? e.message : "Not removed"); } };
  const gaps = steps.map((s, i) => i > 0 && steps[i - 1].screen !== s.screen && !linked(data.edges, steps[i - 1].screen, s.screen) ? i : -1).filter((i) => i > 0);
  const shut = steps.filter((s) => !allowed(s.screen));
  return <Drawer className={css.vars} title={journey ? journey.title || "Journey" : "Plan a journey"} context={journey ? <span>{STATUS[journey.status].label} · {journey.origin === "manual" ? `by ${journey.by ?? "someone"}` : STATUS[journey.status].hint}</span> : undefined} size="xl" onClose={onClose}
    footer={<DrawerFooter status={error ?? note ?? undefined} tone={error ? "error" : "info"} primary={<button type="button" className={hq.primary} disabled={busy || !title.trim()} onClick={() => void save()}>Save</button>}>
      <button type="button" className={hq.secondary} disabled={busy || !title.trim() || !steps.length} onClick={() => void tasks()}><ClipboardList size={15} aria-hidden="true" />Create a task</button>
      {journey ? <button type="button" className={hq.ghost} onClick={() => void copyPlan()}><Copy size={15} aria-hidden="true" />Copy plan</button> : null}
      {journey && (data.canRemove || journey.byId === data.me) ? <button type="button" className={css.danger} onClick={() => void remove()}><Trash2 size={15} aria-hidden="true" />Remove</button> : null}</DrawerFooter>}>
    <div className={css.row2}>
      <label className={hq.fieldLabel}>Journey<input className={hq.input} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="A new buyer tracks an order" maxLength={160} autoFocus={!journey} /></label>
      <label className={hq.fieldLabel}>User type<select className={hq.input} value={personaKey} onChange={(e) => setPersonaKey(e.target.value)}><option value="">Anyone</option>{data.personas.map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}</select></label></div>
    <label className={hq.fieldLabel}>Goal<input className={hq.input} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="What they want to get done" maxLength={1000} /></label>
    <div className={css.row3}>
      <label className={hq.fieldLabel}>Status<select className={hq.input} value={status} onChange={(e) => setStatus(e.target.value as JourneyStatus)}>{(["drafted", "planned", "shipped", ...(journey?.status === "auto" || journey?.status === "discovered" ? [journey.status] : [])] as JourneyStatus[]).map((s) => <option key={s} value={s}>{STATUS[s].label}</option>)}</select></label>
      <label className={hq.fieldLabel}>Priority<select className={hq.input} value={priority} onChange={(e) => setPriority(e.target.value)}><option value="">—</option><option value="now">now</option><option value="next">next</option><option value="later">later</option></select></label>
      <label className={hq.fieldLabel}>For version<select className={hq.input} value={target} onChange={(e) => setTarget(e.target.value)}><option value="">Not yet</option>{data.versions.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}</select></label></div>
    {journey?.evidence.length ? <details className={css.evidence}><summary>Why Pulse proposed it</summary><ul>{journey.evidence.map((e, i) => <li key={i}><Tag>{e.kind}</Tag> {e.text}{e.ref ? <code> {e.ref}</code> : null}</li>)}</ul></details> : null}
    <DrawerSection title={`Steps (${steps.length})`} aside={gaps.length || shut.length ? <span className={css.warnText}><TriangleAlert size={13} aria-hidden="true" /> {gaps.length ? `${gaps.length} gap${gaps.length > 1 ? "s" : ""}` : ""}{gaps.length && shut.length ? " · " : ""}{shut.length ? `${shut.length} not open to ${persona?.name}` : ""}</span> : undefined}>
      <ol className={css.steps}>{steps.map((s, i) => { const gap = gaps.includes(i);
        return <li key={i} data-proposed={s.proposed || screens.find((x) => x.key === s.screen)?.proposed || undefined} data-shut={!allowed(s.screen) || undefined}>
          {gap ? <p className={css.gap}><TriangleAlert size={13} aria-hidden="true" /> No link from {screenName(screens, steps[i - 1].screen)} to here{inMenu(data.edges, s.screen) ? ": only through the menu" : ""}. Add one, or note how they get here.</p> : null}
          <div className={css.stepHead}><span className={css.stepNo}>{i + 1}</span><b>{screenName(screens, s.screen)}</b>{s.proposed || screens.find((x) => x.key === s.screen)?.proposed ? <Tag t="var(--accent)">proposed</Tag> : null}
            {!allowed(s.screen) ? <Tag t="var(--bad)">not open to {persona?.name}</Tag> : null}<span className={css.grow} />
            <button type="button" className={css.x} onClick={() => move(i, -1)} disabled={!i} aria-label="Move up"><ArrowUp size={14} /></button>
            <button type="button" className={css.x} onClick={() => move(i, 1)} disabled={i === steps.length - 1} aria-label="Move down"><ArrowDown size={14} /></button>
            <button type="button" className={css.x} onClick={() => setSteps((x) => x.filter((_, j) => j !== i))} aria-label="Remove step"><X size={14} /></button></div>
          <div className={css.row2}><input className={hq.input} value={s.action} onChange={(e) => edit(i, { action: e.target.value })} placeholder="What they do" aria-label={`Step ${i + 1}: what they do`} maxLength={200} />
            <input className={hq.input} value={s.expected} onChange={(e) => edit(i, { expected: e.target.value })} placeholder="What they see" aria-label={`Step ${i + 1}: what they see`} maxLength={300} /></div>
        </li>; })}</ol>
      <div className={css.adder}>
        <span className={css.small}>{last ? `From ${screenName(screens, last)} people can go to:` : "Start on:"}</span>
        <div className={css.chips}>{next.map((k) => <button key={k} type="button" className={css.chipOff} onClick={() => add(k)} data-shut={!allowed(k) || undefined}><Plus size={12} aria-hidden="true" />{screenName(screens, k)}</button>)}{!next.length ? <span className={hq.faint}>no links found from here</span> : null}</div>
        <label className={css.searchBox}><Search size={15} aria-hidden="true" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Or find any screen" aria-label="Find a screen" /></label>
        {hits.length ? <div className={css.chips}>{hits.map((s) => <button key={s.key} type="button" className={css.chipOff} onClick={() => add(s.key)}><Plus size={12} aria-hidden="true" />{screenName(screens, s.key)}</button>)}</div> : null}
        <div className={css.addRow}><input className={hq.input} value={newScreen} onChange={(e) => setNewScreen(e.target.value)} placeholder="Or a new screen to build" aria-label="New screen" maxLength={160} />
          <button type="button" className={hq.secondary} disabled={busy || newScreen.trim().length < 2} onClick={() => void propose()}><Plus size={15} aria-hidden="true" />Propose it</button></div>
      </div>
    </DrawerSection>
    <label className={hq.fieldLabel}>Acceptance criteria (one per line; empty: each step’s “what they see”)<textarea className={`${hq.input} ${hq.textarea}`} value={acceptance} onChange={(e) => setAcceptance(e.target.value)} rows={3} /></label>
  </Drawer>;
}
