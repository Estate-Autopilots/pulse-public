"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Archive, ArrowRightLeft, CheckCircle2, ExternalLink, HardDrive, Info, ListOrdered, Network, RotateCcw, TriangleAlert, Users, Workflow, X } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { flowEdges, hoursText } from "../lib/sop-flow.mjs";
import { day } from "../lib/format";
import { post } from "../records";
import { Avatar, styles } from "../ui";
import { FlowCanvas } from "./flow";
import { Confidence, plural, SourceChip, StatusBadge, timeText } from "./parts";
import { KIND_LABEL, type Holder, type SopDetail, type SopDoc, type SopStep } from "./types";
import css from "./sops.module.css";

const msg = (e: unknown) => e instanceof Error ? e.message : "That did not work. Try again.";

/** Who is in each lane: the people who hold a role, or the person named on a step. */
export function useLaneSlots(doc: SopDoc) {
  return useMemo(() => { const keys: string[] = []; for (const s of doc.steps) { const k = s.role ? `r:${s.role.toLowerCase()}` : s.personId ? `p:${s.personId}` : "none"; if (!keys.includes(k)) keys.push(k); }
    return (s: Pick<SopStep, "role" | "personId">) => { const k = s.role ? `r:${s.role.toLowerCase()}` : s.personId ? `p:${s.personId}` : "none"; return k === "none" ? 0 : (keys.indexOf(k) % 6) + 1; }; }, [doc]);
}

export function SopView({ data, initial = "flow" }: { data: SopDetail; initial?: "flow" | "steps" }) {
  const s = data.sop, doc = s.doc;
  const [view, setView] = useState<"flow" | "steps" | "history">(initial), [sel, setSel] = useState<string | null>(null);
  const persons = useMemo(() => Object.fromEntries(data.persons.map((p) => [p.id, p])), [data.persons]);
  const step = sel ? doc.steps.find((x) => x.id === sel) ?? null : null;
  return <div className={css.area} data-fill="">
    <nav className={css.sections} aria-label="Views">
      {([["flow", "Flow", Network], ["steps", "Steps", ListOrdered], ["history", "History", RotateCcw]] as const).map(([k, label, Icon]) =>
        <button key={k} type="button" className={css.section} aria-current={view === k ? "page" : undefined} onClick={() => setView(k)}><Icon size={14} aria-hidden="true" />{label}</button>)}
    </nav>
    {view === "flow" ? <div className={css.body} data-fill="">
      <FlowCanvas steps={doc.steps} people={data.people} persons={persons} selected={sel} onSelect={setSel} label={`${s.title}: the flow`} />
      <aside className={css.side} aria-label={step ? step.title : "About this SOP"}>
        {step ? <StepPanel step={step} doc={doc} people={data.people} persons={persons} onClose={() => setSel(null)} onShow={setSel} /> : <Overview data={data} />}
      </aside>
    </div> : view === "steps" ? <StepsDoc doc={doc} people={data.people} persons={persons} /> : <History data={data} />}
  </div>;
}

function Overview({ data }: { data: SopDetail }) {
  const s = data.sop, doc = s.doc; const router = useRouter(); const [busy, setBusy] = useState(false);
  async function status(next: "active" | "archived" | "draft") {
    setBusy(true); try { await post(`sops/${s.id}/status`, { status: next }); notify({ id: "sop", tone: "success", title: next === "active" ? "The SOP is active" : next === "archived" ? "Archived" : "Back to draft", timeout: 3000 }); router.refresh(); }
    catch (e) { notify({ id: "sop", tone: "error", title: "Not changed", message: msg(e) }); } finally { setBusy(false); }
  }
  // An active SOP becomes a workflow: its steps run on Work, each with whoever holds its role.
  async function makeWorkflow() {
    setBusy(true); try { const r = await post<{ id: string }>("workflows/from-sop", { sopId: s.id }); router.push(`/sops/workflows/${r.id}`); }
    catch (e) { notify({ id: "sop", tone: "error", title: "Not made", message: msg(e) }); setBusy(false); }
  }
  const lanes = doc.roles.length ? doc.roles : [];
  return <div className={`${css.panel} ${css.overview}`}>
    <div className={css.panelHead}><div><h3>About this SOP</h3><small>{[s.ownerRole ? `Owned by the ${s.ownerRole}` : null, s.clientName ? `for ${s.clientName}` : null].filter(Boolean).join(" ") || "Click a step to see who does it and how"}</small></div><StatusBadge status={s.status} /></div>
    {s.purpose ? <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.5 }}>{s.purpose}</p> : null}
    <dl className={css.facts}>
      <dt>Steps</dt><dd>{plural(doc.steps.length, "step")}{doc.phases.length ? ` in ${plural(doc.phases.length, "phase")}` : ""}</dd>
      <dt>Handoffs</dt><dd>{data.summary.handoffs ? plural(data.summary.handoffs, "handoff") : "None: one role does it all"}</dd>
      {data.summary.slaHours || data.summary.minutes ? <><dt>Time</dt><dd>{[data.summary.minutes ? `~${hoursText(data.summary.minutes / 60)} of work` : null, data.summary.slaHours ? `${hoursText(data.summary.slaHours)} end to end (SLAs)` : null].filter(Boolean).join(" · ")}</dd></> : null}
      {s.ownerName ? <><dt>Owner</dt><dd>{s.ownerName}</dd></> : null}
      <dt>Source</dt><dd><SourceChip source={s.source} />{s.source === "pulse" ? "Written in Pulse" : null}{data.canEdit && s.confidence != null ? <Confidence value={s.confidence} /> : null}</dd>
      <dt>Updated</dt><dd>{day(s.updatedAt)}{s.updatedBy ? ` by ${s.updatedBy}` : ""}</dd>
    </dl>
    {lanes.length ? <section aria-label="Who does it"><p className={css.sub}>Who does it</p>
      <ul className={css.people}>{lanes.map((r) => { const h = data.people[r] ?? []; const n = doc.steps.filter((x) => x.role === r).length;
        return <li key={r}><span><Users size={13} aria-hidden="true" /><b>{r}</b><small>{n ? plural(n, "step") : "involved"}</small></span>
          <span className={css.faces} title={h.map((x) => x.name).join(", ") || "Nobody holds this role yet"}>{h.slice(0, 4).map((x) => <Avatar key={x.id} name={x.name} id={x.id} photoAt={x.photoAt} size={22} />)}{h.length > 4 ? <em>+{h.length - 4}</em> : h.length ? null : <small>Nobody yet</small>}</span></li>; })}</ul></section> : null}
    {doc.outputs.length ? <section aria-label="What it delivers"><p className={css.sub}>What it delivers</p><div className={css.chips}>{doc.outputs.map((o) => <span key={o} className={css.chip}>{o}</span>)}</div></section> : null}
    {doc.watch.length ? <div className={css.watch}><b><TriangleAlert size={13} aria-hidden="true" /> Watch out for</b><ul>{doc.watch.slice(0, 8).map((w) => <li key={w}>{w}</li>)}</ul></div> : null}
    {data.canEdit && s.sourceName ? <p className={css.hint}><HardDrive size={13} aria-hidden="true" /><span>From “{s.sourceName}”{s.sourceChanged ? ": the Drive copy changed since it was brought in. Open it to compare." : "."} {s.sourceLink ? <a className={css.linkBtn} href={s.sourceLink} target="_blank" rel="noreferrer">Open in Drive<ExternalLink size={12} aria-hidden="true" /></a> : null}</span></p> : null}
    {data.canEdit ? <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      {s.status === "draft" ? <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy} onClick={() => void status("active")}><CheckCircle2 size={14} aria-hidden="true" />Make it active</button> : null}
      {s.status === "active" ? <button type="button" className={styles.btn} disabled={busy} onClick={() => void status("archived")}><Archive size={14} aria-hidden="true" />Archive</button> : null}
      {s.status === "archived" ? <button type="button" className={styles.btn} disabled={busy} onClick={() => void status("draft")}><RotateCcw size={14} aria-hidden="true" />Restore as a draft</button> : null}
      {s.status !== "archived" ? <Link className={styles.btn} href={`/sops/${s.id}/edit`}>Edit steps</Link> : null}
      {s.status === "active" ? <button type="button" className={styles.btn} disabled={busy} onClick={() => void makeWorkflow()}><Workflow size={14} aria-hidden="true" />Make it a workflow</button> : null}
    </div> : <p className={css.hint}><Info size={13} aria-hidden="true" />Leadership keeps this SOP up to date. Click a step to see who does it, what it needs and what it hands over.</p>}
  </div>;
}

/** One step: who does it (and who holds that role), what to do, what it needs and hands over, time, and where it goes. */
export function StepPanel({ step, doc, people, persons, onClose, onShow }: { step: SopStep; doc: SopDoc; people: Record<string, Holder[]>; persons: Record<string, Holder>; onClose: () => void; onShow: (id: string) => void }) {
  const i = doc.steps.findIndex((x) => x.id === step.id); const E = flowEdges(doc.steps);
  const title = (id: string) => { const k = doc.steps.findIndex((x) => x.id === id); return k >= 0 ? `${k + 1}. ${doc.steps[k].title}` : id; };
  const before = E.filter((e) => e.to === step.id), after = E.filter((e) => e.from === step.id);
  const owner = (id: string) => { const x = doc.steps.find((s) => s.id === id); return x?.personId ? persons[x.personId]?.name ?? null : x?.role ?? null; };
  const mine = step.personId ? persons[step.personId]?.name ?? null : step.role;
  const holders = step.role ? people[step.role] ?? [] : []; const who = step.personId ? persons[step.personId] : null; const t = timeText(step);
  return <div className={css.panel}>
    <div className={css.panelHead}><div><small>Step {i + 1} of {doc.steps.length}{step.phase ? ` · ${step.phase}` : ""}</small><h3>{step.title}</h3></div>
      <button type="button" className={css.iconBtn} onClick={onClose} aria-label="Close"><X size={15} aria-hidden="true" /></button></div>
    <dl className={css.facts}>
      <dt>Who</dt><dd>{who ? <><Avatar name={who.name} id={who.id} photoAt={who.photoAt} size={20} />{who.name}{step.role ? <small>({step.role})</small> : null}</> : step.role ? <>{step.role}<span className={css.faces}>{holders.slice(0, 4).map((h) => <Avatar key={h.id} name={h.name} id={h.id} photoAt={h.photoAt} size={20} />)}</span>{holders.length ? <small>{holders.map((h) => h.name.split(" ")[0]).slice(0, 3).join(", ")}{holders.length > 3 ? ` +${holders.length - 3}` : ""}</small> : <small>nobody holds it yet</small>}</> : <span>Not set</span>}</dd>
      {step.involves.length ? <><dt>With</dt><dd>{step.involves.join(", ")}</dd></> : null}
      <dt>Kind</dt><dd>{KIND_LABEL[step.kind]}</dd>
      {t ? <><dt>Time</dt><dd>{t}</dd></> : null}
    </dl>
    {step.detail ? <ul className={css.detail}>{step.detail.split("\n").map((l) => l.replace(/^•\s*/, "")).filter(Boolean).map((l, k) => <li key={k}>{l}</li>)}</ul> : null}
    {step.inputs.length ? <section><p className={css.sub}>Needs</p><div className={css.chips}>{step.inputs.map((x) => <span key={x} className={css.chip}>{x}</span>)}</div></section> : null}
    {step.outputs.length ? <section><p className={css.sub}>Hands over</p><div className={css.chips}>{step.outputs.map((x) => <span key={x} className={css.chip}>{x}</span>)}</div></section> : null}
    {step.kpis.length ? <section><p className={css.sub}>Done well when</p><ul className={css.detail}>{step.kpis.map((x) => <li key={x}>{x}</li>)}</ul></section> : null}
    {step.links.length ? <section><p className={css.sub}>Templates and links</p>{step.links.map((l) => <a key={l.url} className={css.linkBtn} href={l.url} target={l.url.startsWith("/") ? undefined : "_blank"} rel="noreferrer">{l.label}<ExternalLink size={12} aria-hidden="true" /></a>)}</section> : null}
    <section><p className={css.sub}>Comes after</p>{before.length ? <ul className={css.flowLinks}>{before.map((e) => { const o = owner(e.from);
      return <li key={e.from + (e.label ?? "")}><button type="button" onClick={() => onShow(e.from)}><b>{title(e.from)}</b>{e.label ? <small>{e.label}</small> : o && o !== mine ? <small><ArrowRightLeft size={11} aria-hidden="true" />handed over by {o}</small> : null}</button></li>; })}</ul>
      : <p className={css.hint}>It starts here.</p>}</section>
    <section><p className={css.sub}>Then</p>{after.length ? <ul className={css.flowLinks}>{after.map((e) => { const o = owner(e.to);
      return <li key={e.to + (e.label ?? "")}><button type="button" onClick={() => onShow(e.to)}><b>{e.label ? `${e.label}: ` : ""}{title(e.to)}</b>{o && o !== mine ? <small><ArrowRightLeft size={11} aria-hidden="true" />hands over to {o}</small> : null}</button></li>; })}</ul>
      : <p className={css.hint}>It ends here.</p>}</section>
  </div>;
}

/** The SOP as a readable document: phases, numbered steps, who, what, handoffs. Also the phone's easiest view. */
export function StepsDoc({ doc, people, persons }: { doc: SopDoc; people: Record<string, Holder[]>; persons: Record<string, Holder> }) {
  const slotOf = useLaneSlots(doc); const E = flowEdges(doc.steps);
  const groups: { phase: string | null; steps: { s: SopStep; i: number }[] }[] = [];
  doc.steps.forEach((s, i) => { const g = groups.at(-1); if (g && g.phase === s.phase) g.steps.push({ s, i }); else groups.push({ phase: s.phase, steps: [{ s, i }] }); });
  const owner = (s: SopStep) => s.personId ? persons[s.personId]?.name ?? s.role : s.role;
  return <div className={css.doc}>
    {groups.map((g, gi) => <section key={gi} className={css.docPhase} aria-label={g.phase ?? "Steps"}>{g.phase ? <h3>{g.phase}</h3> : null}
      <ol className={css.steps}>{g.steps.map(({ s, i }) => { const from = E.filter((e) => e.to === s.id && !e.label).map((e) => doc.steps.find((x) => x.id === e.from)!).filter((p) => p && owner(p) !== owner(s))[0]; const t = timeText(s); const holders = s.role ? people[s.role] ?? [] : [];
        return <li key={s.id} data-slot={slotOf(s)}><span className={css.stepNo}>{i + 1}</span><div className={css.stepBody}>
          <h4>{s.title}{s.kind !== "task" ? <span className={css.chip}>{KIND_LABEL[s.kind]}</span> : null}</h4>
          <span className={css.chips}>{owner(s) ? <span className={css.chip} data-slot={slotOf(s)}>{owner(s)}</span> : null}{holders.length && !s.personId ? <span className={css.chip}>{holders.slice(0, 3).map((h) => h.name.split(" ")[0]).join(", ")}{holders.length > 3 ? ` +${holders.length - 3}` : ""}</span> : null}
            {t ? <span className={css.chip}>{t}</span> : null}{from ? <span className={css.handoff}><ArrowRightLeft size={12} aria-hidden="true" />Handed over from {owner(from)}</span> : null}</span>
          {s.detail ? <ul className={css.detail}>{s.detail.split("\n").map((l) => l.replace(/^•\s*/, "")).filter(Boolean).map((l, k) => <li key={k}>{l}</li>)}</ul> : null}
          {s.inputs.length || s.outputs.length ? <span className={css.chips}>{s.inputs.map((x) => <span key={"i" + x} className={css.chip}>Needs: {x}</span>)}{s.outputs.map((x) => <span key={"o" + x} className={css.chip}>Hands over: {x}</span>)}</span> : null}
          {s.kpis.length ? <p className={css.hint}>Done well when: {s.kpis.join(" · ")}</p> : null}
          {s.next?.length ? <p className={css.hint}>Then: {s.next.map((n) => `${n.label ? `${n.label} → ` : ""}${doc.steps.findIndex((x) => x.id === n.to) + 1}`).join(" · ")}</p> : null}
        </div></li>; })}</ol></section>)}
    {doc.watch.length ? <div className={css.watch}><b><TriangleAlert size={13} aria-hidden="true" /> Watch out for</b><ul>{doc.watch.map((w) => <li key={w}>{w}</li>)}</ul></div> : null}
  </div>;
}

function History({ data }: { data: SopDetail }) {
  return <div className={css.box} style={{ maxWidth: 720 }}>
    <p className={css.sub}>Versions</p>
    <ul className={css.versions}>{data.versions.map((v) => <li key={v.version}><span><b>Version {v.version}</b>{v.note ? ` · ${v.note}` : ""}</span><small>{day(v.savedAt)}{v.savedBy ? ` · ${v.savedBy}` : ""}</small></li>)}</ul>
    <p className={css.hint}><Info size={13} aria-hidden="true" />Every save that changes the steps keeps a version.</p>
  </div>;
}
