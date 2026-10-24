"use client";
// WORKFLOW BUILDER (owner, 18 Oct 2026): a board of workflows, one tab per person's or role's job. Each tab is a
// workflow built from blocks on a canvas: add a block from the palette (it wires itself to the chosen block when the
// types fit), drag blocks, wire outputs to inputs, open a block for who does it, its form, its SOP checklist and where a
// Hand-off passes the work. Save keeps the draft; Publish makes new runs follow it. Test mode runs the tab as it is now on
// a copy of a project's values, as the people each block would go to, and draws where the test stands.
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { FileText, FlaskConical, Plus, Rocket, Save, Search, Settings2, Trash2 } from "lucide-react";
import { Button, IconTile, Tag } from "@pulse/design-system/ui";
import { blockIcon, ENGINE_LABEL, GROUP_HUE } from "./block-icons";
import { notify } from "@pulse/ui-shell";
import { Drawer, DrawerFooter, DrawerSection, PersonSelect, type PickPerson } from "../kit";
import { useWorkOptions } from "../create";
import { autoLayout, canWire, detailOf, explicit, freeSpot, specOf } from "../lib/wf-canvas.mjs";
import { post } from "../records";
import { styles } from "../ui";
import { BlockPanel } from "./block-panel";
import { BlockCanvas, type NodeState } from "./canvas";
import { SopImport, type SopBlock } from "./sop-import";
import { TestPanel } from "./test-panel";
import { ENGINE_WORD, type BlockDef, type BlockSpec, type BlockStep, type BoardDetail, type Tab } from "./board-types";
import { ASSIGN_LABEL } from "./types";
import css from "./blocks.module.css";

const msg = (e: unknown) => e instanceof Error ? e.message : "That did not work. Try again.";
const GROUPS = ["Start", "Sales", "Billing", "Field", "Flow", "Apps"] as const;
const STATE_WORD = { waiting: "Waiting", active: "Doing", done: "Done", skipped: "Skipped", cancelled: "Stopped" } as const;

/** A tab's name in the tab strip: "1 · Sales · Adunor". */
export function tabLabel(t: Pick<Tab, "name" | "tabPerson" | "tabRole">, i: number) {
  const who = t.tabPerson?.split(" ")[0] ?? t.tabRole;
  return [`${i + 1}`, t.name, who && who.toLowerCase() !== t.name.toLowerCase() ? who : null].filter(Boolean).join(" · ");
}
const prepare = (d: BlockDef, byModule: Record<string, BlockSpec>): BlockDef => ({ ...d, steps: autoLayout(explicit(d.steps, byModule), byModule) });

export function BoardBuilder({ data }: { data: BoardDetail }) {
  const router = useRouter(); const params = useSearchParams();
  const byModule = useMemo(() => Object.fromEntries(data.blocks.map((b) => [b.module, b])) as Record<string, BlockSpec>, [data.blocks]);
  const [cur, setCur] = useState<string | null>(() => data.tabs.find((t) => t.id === params.get("tab"))?.id ?? data.tabs[0]?.id ?? null);
  const tab = data.tabs.find((t) => t.id === cur) ?? data.tabs[0] ?? null;
  const [drafts, setDrafts] = useState<Record<string, BlockDef>>({});
  const def = tab ? drafts[tab.id] ?? prepare(tab.definition, byModule) : null;
  const steps = def?.steps ?? [];
  const [sel, setSel] = useState<string | null>(null), [panel, setPanel] = useState(false);
  const [offer, setOffer] = useState<{ from: string; port: string | null; to: string; inKey: string | null; why: string; adapters: string[] } | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [test, setTest] = useState(params.get("test") === "1");
  const [testRun, setTestRun] = useState<string | null>(null);
  const [tabDrawer, setTabDrawer] = useState<"new" | "edit" | null>(null), [importing, setImporting] = useState(false);
  const dirty = !!(tab && drafts[tab.id]);
  useEffect(() => { const u = new URL(window.location.href); if (cur) u.searchParams.set("tab", cur); if (test) u.searchParams.set("test", "1"); else u.searchParams.delete("test"); window.history.replaceState(null, "", u); }, [cur, test]);
  // Leaving with unsaved blocks asks first.
  useEffect(() => { const any = Object.keys(drafts).length > 0; const warn = (e: BeforeUnloadEvent) => { if (any) e.preventDefault(); }; window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn); }, [drafts]);

  const switchTab = (id: string | null) => { setCur(id); setSel(null); setPanel(false); setOffer(null); setError(""); };
  const change = (next: BlockStep[]) => { if (!tab || !def) return; setDrafts((d) => ({ ...d, [tab.id]: { ...def, steps: next } })); };
  const persons = useMemo(() => Object.fromEntries(data.persons.map((p) => [p.id, p])), [data.persons]);
  const who = (s: BlockStep) => {
    const spec = specOf(s as never, byModule);
    if (spec.engine === "auto") return spec.module === "handoff" ? "Passes the work on" : "Runs by itself";
    if (s.kind === "wait") return `Waits ${s.waitHours ?? 24} h`;
    if (s.kind === "end") return "The run ends";
    if (s.assign.by === "role") { const r = s.assign.role ?? s.role ?? ""; const h = data.people[r] ?? []; return r ? `${r}${h.length ? ` · ${h.slice(0, 2).map((x) => x.name.split(" ")[0]).join(", ")}${h.length > 2 ? ` +${h.length - 2}` : ""}` : " · nobody yet"}` : "Choose a role"; }
    if (s.assign.by === "person") return persons[s.assign.personId ?? ""]?.name ?? "A person";
    return ASSIGN_LABEL[s.assign.by];
  };
  const tabName = (id: string | undefined) => { const i = data.tabs.findIndex((t) => t.id === id); return i >= 0 ? tabLabel(data.tabs[i], i) : data.workflows.find((w) => w.id === id)?.name ?? null; };
  const handoffName = (s: BlockStep) => tabName(s.handoff?.workflowId) ?? "Choose the tab";
  const newId = () => { let n = steps.length + 1; while (steps.some((s) => s.id === `b${n}`)) n++; return `b${n}`; };
  const labelFor = (s: BlockStep, port: string | null) => (s.kind === "approval" || s.kind === "decision") ? specOf(s as never, byModule).outputs.find((o) => o.key === port)?.label ?? null : null;
  const withWire = (list: BlockStep[], from: string, port: string | null, to: string, inKey: string | null) => list.map((s) => s.id !== from || (s.next ?? []).some((n) => n.to === to && (n.port ?? null) === port) ? s
    : { ...s, next: [...(s.next ?? []), { to, label: labelFor(s, port), ...(port ? { port } : {}), ...(inKey ? { in: inKey } : {}) }] });

  function addBlock(module: string, at?: { x: number; y: number }, near0?: BlockStep | null) {
    const spec = byModule[module]; const id = newId();
    const near = near0 === undefined ? steps.find((s) => s.id === sel) ?? [...steps].reverse().find((s) => s.pos) ?? null : near0;
    const block: BlockStep = { id, title: spec.label, detail: detailOf(spec.checklist), kind: spec.kind, role: near?.role ?? null, personId: null, involves: [], phase: null, inputs: [], outputs: [],
      kpis: [], minutes: null, slaHours: spec.slaHours ?? null, links: [], next: [], assign: spec.engine === "auto" ? { by: "starter" } : near && specOf(near as never, byModule).engine !== "auto" ? { ...near.assign } : { by: "starter" },
      category: null, formId: null, join: "any", waitHours: spec.kind === "wait" ? spec.waitHours ?? 24 : null, module, pos: at ?? freeSpot(steps as never, byModule, near as never) };
    let list = [...steps, block];
    // Wired to the chosen block at once, from its first free output whose type fits.
    if (near && !at && near.module !== "handoff") {
      const outs = specOf(near as never, byModule).outputs; const free = outs.filter((o) => !(near.next ?? []).some((n) => n.port === o.key));
      for (const o of [...free, ...outs]) if (canWire(list as never, byModule, data.blocks, near.id, o.key, id, null).ok) { list = withWire(list, near.id, o.key, id, null); break; }
    }
    change(list); setSel(id); return list;
  }
  // SOPs from Drive: one Checklist block each, wired one after another to the right of the blocks, joined to the chosen block.
  function addSopBlocks(list: SopBlock[]) {
    const near = steps.find((s) => s.id === sel) ?? [...steps].reverse().find((s) => s.pos) ?? null;
    const spec = byModule.checklist;
    let x = Math.max(0, ...steps.map((s) => s.pos?.x ?? 0)), y = near?.pos?.y ?? 120;
    let all = [...steps]; const made: string[] = [];
    list.forEach((b) => {
      let n = all.length + 1; while (all.some((s) => s.id === `b${n}`)) n++;
      const id = `b${n}`;
      x += 300; if (x > 7600) { x = 40; y += 200; }
      all = [...all, { ...addBlockShape(spec, id, { x, y }), title: b.title, detail: b.detail, role: b.role, assign: b.role ? { by: "role", role: b.role } : { by: "starter" } } as BlockStep];
      if (made.length) all = withWire(all, made[made.length - 1], "done", id, null);
      made.push(id);
    });
    if (near && made.length && near.module !== "handoff") for (const o of specOf(near as never, byModule).outputs)
      if (canWire(all as never, byModule, data.blocks, near.id, o.key, made[0], null).ok) { all = withWire(all, near.id, o.key, made[0], null); break; }
    change(all); setImporting(false); if (made[0]) setSel(made[0]);
    notify({ id: "wf-sops", tone: "success", title: `${made.length} SOP ${made.length === 1 ? "block" : "blocks"} added: Save to keep them`, timeout: 3500 });
  }
  function wireUp(from: string, port: string | null, to: string, inKey: string | null) {
    const r = canWire(steps as never, byModule, data.blocks, from, port, to, inKey);
    if (!r.ok) { setOffer({ from, port, to, inKey, why: r.why, adapters: r.adapters ?? [] }); return; }
    setOffer(null); change(withWire(steps, from, port, to, inKey));
  }
  function insertAdapter(module: string) {
    if (!offer) return;
    const a = steps.find((s) => s.id === offer.from), b = steps.find((s) => s.id === offer.to); if (!a?.pos || !b?.pos) return;
    const spec = byModule[module]; const id = newId();
    const mid = { x: Math.round((a.pos.x + b.pos.x) / 2), y: Math.round(Math.max(a.pos.y, b.pos.y) + 150) };
    let list = [...steps, { ...addBlockShape(spec, id, mid), assign: { ...a.assign } } as BlockStep];
    // The adapter's input that takes what the source gives (a Quotation takes a lead or the items asked for on a call).
    const input = spec.inputs.find((i) => canWire(list as never, byModule, data.blocks, offer.from, offer.port, id, i.key).ok) ?? spec.inputs[0];
    list = withWire(list, offer.from, offer.port, id, input?.key ?? null);
    const out = spec.outputs.find((o) => canWire(list as never, byModule, data.blocks, id, o.key, offer.to, offer.inKey).ok);
    if (out) list = withWire(list, id, out.key, offer.to, offer.inKey);
    change(list); setOffer(null); setSel(id);
  }
  const unwire = (from: string, index: number) => change(steps.map((s) => s.id === from ? { ...s, next: (s.next ?? []).filter((_, i) => i !== index) } : s));
  const patch = (id: string, p: Partial<BlockStep>) => change(steps.map((s) => s.id === id ? { ...s, ...p } : s));
  const remove = (id: string) => { change(steps.filter((s) => s.id !== id).map((s) => ({ ...s, next: (s.next ?? []).filter((n) => n.to !== id) }))); setSel(null); setPanel(false); };

  async function save(publish = false) {
    if (!tab || !def) return;
    setBusy(true); setError("");
    try {
      await post(`workflows/${tab.id}`, { name: tab.name, purpose: tab.purpose, definition: def, trigger: tab.trigger, sopId: tab.sopId, clientId: tab.clientId });
      if (publish) await post(`workflows/${tab.id}/publish`);
      setDrafts((d) => { const n = { ...d }; delete n[tab.id]; return n; });
      notify({ id: "wf-board", tone: "success", title: publish ? "Published: new runs follow this tab" : tab.status === "live" ? "Saved: new runs follow the change" : "Saved", timeout: 3000 });
      router.refresh();
    } catch (e) { setError(msg(e)); } finally { setBusy(false); }
  }

  // Where the chosen test run (or the newest one of this tab) stands on each block.
  const runs = data.tests.filter((r) => r.workflowId === tab?.id);
  const shown = runs.find((r) => r.id === testRun) ?? (test ? runs[0] : undefined);
  const states = useMemo(() => shown ? Object.fromEntries(shown.steps.map((s) => [s.key, { status: s.status, text: [STATE_WORD[s.status], s.status === "active" ? s.person?.split(" ")[0] ?? "nobody yet" : s.outcome].filter(Boolean).join(" · ") } as NodeState])) : undefined, [shown]);
  const block = steps.find((s) => s.id === sel) ?? null;

  if (!tab || !def) return <div className={`${css.board} ${css.vars}`}><p className={css.note}>This board has no tabs yet.</p>
    {data.canEdit ? <span><button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => setTabDrawer("new")}><Plus size={14} aria-hidden="true" />Add a workflow</button></span> : null}
    {tabDrawer ? <TabDrawer data={data} tab={null} onClose={() => setTabDrawer(null)} onDone={(id) => { setTabDrawer(null); if (id) switchTab(id); router.refresh(); }} /> : null}</div>;

  return <div className={`${css.board} ${css.vars}`}>
    <div className={css.tabs} role="tablist" aria-label="Workflows on this board">
      {data.tabs.map((t, i) => <button key={t.id} type="button" role="tab" className={css.tab} aria-selected={t.id === tab.id} onClick={() => switchTab(t.id)}>
        {tabLabel(t, i)}{drafts[t.id] ? <em>unsaved</em> : t.status === "live" ? null : <em>{t.status === "draft" ? "draft" : t.status}</em>}</button>)}
      {data.canEdit ? <button type="button" className={css.tab} data-add="" onClick={() => setTabDrawer("new")}><Plus size={14} aria-hidden="true" />Workflow</button> : null}
    </div>
    <div className={css.bar}>
      <span className={css.grow}><span className={css.chip} data-tone={tab.status === "live" ? "live" : undefined}>{tab.status === "live" ? `Live · version ${tab.version}` : tab.status === "paused" ? "Paused" : "Draft"}</span>{" "}
        <span className={css.status}>{tab.tabPerson ? `${tab.tabPerson}'s job` : tab.tabRole ? `The ${tab.tabRole}'s job` : "Nobody named for this tab"} · {steps.length} blocks</span></span>
      {error ? <span className={css.error} role="alert">{error}</span> : dirty ? <span className={css.status}>Unsaved changes</span> : null}
      {data.canEdit ? <>
        <Button variant="ghost" icon={<Settings2 />} onClick={() => setTabDrawer("edit")}>Tab</Button>
        <Button variant={test ? "secondary" : "ghost"} icon={<FlaskConical />} aria-pressed={test} onClick={() => setTest((x) => !x)}>{test ? "Close test mode" : "Test mode"}</Button>
        <Button icon={<Save />} disabled={busy || !dirty} onClick={() => void save(false)}>Save</Button>
        <Button variant="primary" icon={<Rocket />} disabled={busy || (!dirty && tab.status === "live")} onClick={() => void save(true)}>Publish</Button></> : null}
    </div>
    <div className={css.work} data-side={test ? "" : undefined} data-library={data.canEdit ? "" : undefined}>
      {data.canEdit ? <BlockLibrary blocks={data.blocks} onAdd={(m) => addBlock(m)} onSops={() => setImporting(true)} /> : null}
      <div style={{ minWidth: 0 }}>
        <BlockCanvas steps={steps} blocks={data.blocks} types={data.types} selected={sel} label={`${tab.name}: the blocks`} readOnly={!data.canEdit}
          onSelect={(id) => { setSel(id); setPanel(!!id); }} onMove={(id, pos) => patch(id, { pos })} onWire={wireUp} onUnwire={unwire} who={who} handoffName={handoffName} states={states} />
        {offer ? <div className={css.offer} role="alert">
          <span><b>{offer.why}.</b> {offer.adapters.length ? "Put an adapter block between them:" : "No block turns one into the other yet."}</span>
          {offer.adapters.map((m) => <button key={m} type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => insertAdapter(m)}><Plus size={12} aria-hidden="true" />{byModule[m].label}</button>)}
          <button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => setOffer(null)}>Cancel</button></div> : null}
      </div>
      {test ? <TestPanel data={data} tab={tab} dirty={dirty} runs={runs} shown={shown?.id ?? null} onShow={setTestRun} onChanged={() => router.refresh()} /> : null}
    </div>
    {panel && block ? <BlockPanel key={block.id} data={data} tab={tab} step={block} steps={steps} byModule={byModule} who={who(block)} onClose={() => setPanel(false)}
      onPatch={(p) => patch(block.id, p)} onRemove={() => remove(block.id)} onWire={wireUp} onUnwire={unwire} tabName={tabName} /> : null}
    {importing ? <SopImport onClose={() => setImporting(false)} onAdd={addSopBlocks} /> : null}
    {tabDrawer ? <TabDrawer data={data} tab={tabDrawer === "edit" ? tab : null} onClose={() => setTabDrawer(null)} onDone={(id) => { setTabDrawer(null); if (id) switchTab(id); router.refresh(); }} /> : null}
  </div>;
}

/** Owner workbench (21 Oct 2026): the blocks as a searchable library beside the canvas, grouped, each with its icon, its
 *  group's hue, what it does and how much of it is built; a click adds it after the chosen block. */
function BlockLibrary({ blocks, onAdd, onSops }: { blocks: BlockSpec[]; onAdd: (module: string) => void; onSops: () => void }) {
  const [q, setQ] = useState("");
  const words = q.trim().toLowerCase();
  const shown = blocks.filter((b) => b.module !== "lead_capture" && b.module !== "handoff_in" && (!words || `${b.label} ${b.what} ${b.group}`.toLowerCase().includes(words)));
  return <aside className={css.library} aria-label="Block library">
    <label className={css.libSearch}><Search size={15} aria-hidden="true" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search blocks" aria-label="Search blocks" /></label>
    <button type="button" className={css.libItem} onClick={onSops}><IconTile icon={<FileText />} hue="indigo" size="sm" /><span><b>From SOPs</b><small>Each SOP from Drive becomes a checklist block</small></span></button>
    {GROUPS.map((g) => { const list = shown.filter((b) => b.group === g); return list.length ? <section key={g} className={css.libGroup} aria-label={g}>
      <p className={css.libHead}>{g}</p>
      {list.map((b) => <button key={b.module} type="button" className={css.libItem} onClick={() => onAdd(b.module)} title={`${b.what} ${b.status}`} data-engine={b.engine}>
        <IconTile icon={blockIcon(b.module)} hue={GROUP_HUE[g]} size="sm" />
        <span><b>{b.label}</b><small>{b.what}</small></span>
        {b.engine === "stub" || b.engine === "partial" ? <Tag hue={b.engine === "stub" ? "slate" : "amber"}>{ENGINE_LABEL[b.engine]}</Tag> : null}
      </button>)}
    </section> : null; })}
    {!shown.length ? <p className={css.note}>No block matches {q}.</p> : null}
  </aside>;
}

function addBlockShape(spec: BlockSpec, id: string, pos: { x: number; y: number }): BlockStep {
  return { id, title: spec.label, detail: detailOf(spec.checklist), kind: spec.kind, role: null, personId: null, involves: [], phase: null, inputs: [], outputs: [], kpis: [], minutes: null,
    slaHours: spec.slaHours ?? null, links: [], next: [], assign: { by: "starter" }, category: null, formId: null, join: "any", waitHours: spec.kind === "wait" ? spec.waitHours ?? 24 : null, module: spec.module, pos };
}

/** A new tab (a blank workflow, or one already made), or this tab's name and whose job it is. */
function TabDrawer({ data, tab, onClose, onDone }: { data: BoardDetail; tab: Tab | null; onClose: () => void; onDone: (id: string | null) => void }) {
  const { data: options } = useWorkOptions();
  const [name, setName] = useState(tab?.name ?? ""), [role, setRole] = useState(tab?.tabRole ?? ""), [person, setPerson] = useState<string | null>(tab?.tabPersonId ?? null);
  const [start, setStart] = useState<"lead" | "handoff">(data.tabs.length ? "handoff" : "lead"), [existing, setExisting] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const people = useMemo(() => (options?.people ?? []).map((p) => ({ id: p.id, name: p.name, photoAt: p.photoAt ?? null, pod: p.pod ?? null, role: p.role ?? null })) as PickPerson[], [options]);
  async function go(removeIt = false) {
    setBusy(true); setError("");
    try {
      if (!tab) { const r = await post<{ id: string }>(`workflows/boards/${data.board.id}/tabs`, { name, role: role || null, personId: person, start, workflowId: existing || null }); onDone(r.id); return; }
      if (removeIt) { await post(`workflows/${tab.id}/tab`, { boardId: null }); onDone(null); return; }
      if (name.trim() && name.trim() !== tab.name) await post(`workflows/${tab.id}`, { name: name.trim(), purpose: tab.purpose, definition: tab.definition, trigger: tab.trigger, sopId: tab.sopId, clientId: tab.clientId });
      await post(`workflows/${tab.id}/tab`, { boardId: data.board.id, position: tab.position, role: role || null, personId: person });
      onDone(tab.id);
    } catch (e) { setError(msg(e)); setBusy(false); }
  }
  const free = data.workflows.filter((w) => !data.tabs.some((t) => t.id === w.id));
  return <Drawer title={tab ? "This tab" : "Add a workflow"} help="Each tab is one person's or role's job. A Hand-off block passes the work from one tab to the next." onClose={onClose} size="sm"
    footer={<DrawerFooter status={error}>{tab ? <button type="button" className={styles.btn} disabled={busy} onClick={() => void go(true)}><Trash2 size={14} aria-hidden="true" />Take off the board</button> : null}
      <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || (!tab && !existing && !name.trim())} onClick={() => void go()}>{tab ? "Save" : "Add"}</button></DrawerFooter>}>
    <DrawerSection>
      {!tab && free.length ? <label className={css.field}><span>A workflow already made (optional)</span><select value={existing} onChange={(e) => setExisting(e.target.value)}>
        <option value="">No: start a new one</option>{free.map((w) => <option key={w.id} value={w.id}>{w.name}{w.board ? ` (on ${w.board})` : ""}</option>)}</select></label> : null}
      {!existing ? <label className={css.field}><span>Name</span><input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} placeholder="Site team" data-autofocus="" /></label> : null}
      {!tab && !existing ? <div className={css.field}><span>Its runs start</span><select value={start} onChange={(e) => setStart(e.target.value as "lead" | "handoff")}>
        <option value="lead">From a lead or a project (Lead capture)</option><option value="handoff">When another tab hands work over</option></select></div> : null}
    </DrawerSection>
    <DrawerSection title="Whose job">
      <label className={css.field}><span>Role</span><input value={role} onChange={(e) => setRole(e.target.value)} maxLength={80} placeholder="Sales" /></label>
      <div className={css.field}><span>Person (optional)</span><PersonSelect label="Person" people={people} value={person} onChange={(p) => setPerson(p?.id ?? null)} noneLabel="Nobody named" /></div>
      <p className={css.note}>The tab shows this name; each block still says who does it.</p>
    </DrawerSection>
  </Drawer>;
}
