"use client";
// TASKS-3: who reports to whom. A top-down tree: a manager above their reports, people with no reports of their own
// stacked in a column so wide teams stay narrow, each card in its pod's colour. Zoom (buttons, Ctrl + wheel), Fit, and
// drag the background to move around. HR and admins change a line or a pod head from the side panel and confirm Pulse's
// proposals there in one click; everyone else reads the chart. The same tree is a nested list for screen readers.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Check, Crown, Maximize2, Minus, Plus, Search, Sparkles, UserRound, Users, X } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { PersonPicker, type Person as Pick } from "../../create";
import { post } from "../../records";
import { Avatar, styles } from "../../ui";
import css from "./org.module.css";
import { SelectField } from "../../kit/select-field";

export type OrgPerson = { id: string; name: string; role: string | null; pod: string | null; department: string | null; managerId: string | null; photoAt: string | null };
export type OrgProposal = { id: string; kind: "manager" | "pod_head"; personId: string; personName: string; managerId: string | null; managerName: string | null; pod: string | null; confidence: number; evidence: string[] };
export type OrgData = { people: OrgPerson[]; pods: { name: string; headId: string | null }[]; departments: string[]; proposals: OrgProposal[]; decided: { confirmed: number; dismissed: number } | null; canEdit: boolean; canSuggest: boolean; me: string | null };
const NW = 212, NH = 66, GX = 26, GY = 44, IND = 26, SG = 10, PAD = 28;
const msg = (e: unknown) => e instanceof Error ? e.message : "That did not work. Try again.";
const TOP = /\b(founder|co-?founder|ceo|chief executive)\b/i;
type Placed = { nodes: { id: string; x: number; y: number }[]; edges: { d: string; proposed: boolean }[] };
type Box = { w: number; h: number; draw: (x: number, y: number, out: Placed) => { cx: number; top: number } };

/** `proposed`: person → the manager Pulse proposes, drawn (dashed) where no line is set yet. */
function useLayout(people: OrgPerson[], proposed: Map<string, string>) {
  return useMemo(() => {
    const ids = new Set(people.map((p) => p.id)); const byId = new Map(people.map((p) => [p.id, p]));
    const boss = (p: OrgPerson) => p.managerId ?? proposed.get(p.id) ?? null;
    const guess = (id: string) => !byId.get(id)?.managerId && proposed.has(id);
    const kids = new Map<string, OrgPerson[]>();
    const loops = (id: string, m: string) => { let x: string | null = m; for (let i = 0; x && i < 40; i++) { if (x === id) return true; const q = byId.get(x); x = q ? boss(q) : null; } return false; };
    for (const p of people) { const m = boss(p); if (m && ids.has(m) && m !== p.id && !loops(p.id, m)) kids.set(m, [...(kids.get(m) ?? []), p]); }
    const size = (id: string): number => (kids.get(id) ?? []).reduce((n, k) => n + 1 + size(k.id), 0);
    for (const list of kids.values()) list.sort((a, b) => size(b.id) - size(a.id) || (a.pod ?? "").localeCompare(b.pod ?? "") || a.name.localeCompare(b.name));
    const leaf = (id: string) => !(kids.get(id)?.length);
    // People with no reports of their own, one under another; a rail on their left joins them. `rail` is the room it takes.
    const stack = (list: OrgPerson[], rail: number): Box => ({ w: NW + rail, h: list.length * NH + (list.length - 1) * SG, draw: (x, y, out) => {
      const rx = x + rail / 2, nx = x + rail;
      list.forEach((p, i) => { const ny = y + i * (NH + SG); out.nodes.push({ id: p.id, x: nx, y: ny }); out.edges.push({ d: `M${rx} ${ny + NH / 2}H${nx}`, proposed: guess(p.id) }); });
      out.edges.push({ d: `M${rx} ${y - 8}V${y + (list.length - 1) * (NH + SG) + NH / 2}`, proposed: list.every((p) => guess(p.id)) });
      return { cx: rx, top: y - 8 };
    } });
    const block = (p: OrgPerson): Box => {
      const all = kids.get(p.id) ?? []; if (!all.length) return { w: NW, h: NH, draw: (x, y, out) => { out.nodes.push({ id: p.id, x, y }); return { cx: x + NW / 2, top: y }; } };
      const branches = all.filter((k) => !leaf(k.id)), leaves = all.filter((k) => leaf(k.id));
      if (!branches.length) {
        const st = stack(leaves, IND * 2);
        return { w: Math.max(NW, st.w), h: NH + GY * 0.55 + st.h, draw: (x, y, out) => { out.nodes.push({ id: p.id, x, y }); const sy = y + NH + GY * 0.55; st.draw(x, sy, out);
          out.edges.push({ d: `M${x + IND} ${y + NH}V${sy - 8}`, proposed: leaves.every((k) => guess(k.id)) }); return { cx: x + NW / 2, top: y }; } };
      }
      const slots = [...branches.map(block), ...(leaves.length ? [stack(leaves, 28)] : [])];
      const rowW = slots.reduce((n, s) => n + s.w, 0) + GX * (slots.length - 1), w = Math.max(NW, rowW), h = NH + GY + Math.max(...slots.map((s) => s.h));
      return { w, h, draw: (x, y, out) => {
        const px = x + (w - NW) / 2; out.nodes.push({ id: p.id, x: px, y });
        let cx = x + (w - rowW) / 2; const mid = y + NH + GY / 2;
        slots.forEach((s, i) => { const at = s.draw(cx, y + NH + GY, out); const who = i < branches.length ? [branches[i]] : leaves;
          out.edges.push({ d: `M${px + NW / 2} ${y + NH}V${mid}H${at.cx}V${at.top}`, proposed: who.every((k) => guess(k.id)) }); cx += s.w + GX; });
        return { cx: px + NW / 2, top: y };
      } };
    };
    const roots = people.filter((p) => { const m = boss(p); return !m || !ids.has(m) || !kids.get(m)?.includes(p); });
    const placedRoots = roots.filter((p) => kids.get(p.id)?.length || TOP.test(p.role ?? "")).sort((a, b) => Number(TOP.test(b.role ?? "")) - Number(TOP.test(a.role ?? "")) || size(b.id) - size(a.id));
    const loose = roots.filter((p) => !placedRoots.includes(p)).sort((a, b) => (a.pod ?? "~").localeCompare(b.pod ?? "~") || a.name.localeCompare(b.name));
    const out: Placed = { nodes: [], edges: [] }; let x = PAD, height = 0;
    for (const r of placedRoots) { const b = block(r); b.draw(x, PAD, out); x += b.w + GX * 2; height = Math.max(height, b.h); }
    return { ...out, width: Math.max(x - GX * 2 + PAD, 400), height: height + PAD * 2, loose, kids, byId, guess };
  }, [people, proposed]);
}

export function OrgChart({ data }: { data: OrgData }) {
  const router = useRouter();
  const pods = useMemo(() => [...new Set([...data.pods.map((p) => p.name), ...data.people.map((p) => p.pod).filter((x): x is string => !!x)])], [data]);
  const slot = (pod: string | null) => pod ? (pods.indexOf(pod) % 6) + 1 : 0;
  const headOf = useMemo(() => new Map(data.pods.filter((p) => p.headId).map((p) => [p.headId!, p.name])), [data.pods]);
  // Pulse's proposals drawn as dashed lines (and "Head?" badges) until HR confirms them; on by default while they wait.
  const [preview, setPreview] = useState(data.proposals.length > 0);
  const proposed = useMemo(() => new Map(preview ? data.proposals.filter((x) => x.kind === "manager" && x.managerId).map((x) => [x.personId, x.managerId!]) : []), [data.proposals, preview]);
  const proposedHead = useMemo(() => new Map(preview ? data.proposals.filter((x) => x.kind === "pod_head").map((x) => [x.personId, x.pod!]) : []), [data.proposals, preview]);
  const L = useLayout(data.people, proposed);
  const frame = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1), [sel, setSel] = useState<string | null>(null), [focusPod, setFocusPod] = useState<string | null>(null), [dept, setDept] = useState(""), [q, setQ] = useState("");
  const fitted = useCallback(() => { const el = frame.current; return el ? Math.max(0.3, Math.min(1.1, Math.min((el.clientWidth - 8) / L.width, (el.clientHeight - 8) / L.height))) : 1; }, [L.width, L.height]);
  const fit = useCallback(() => setZoom(fitted()), [fitted]);
  // Open readable: fitted when that is large enough, else at 75% with the top of the tree in view (Fit shows it all).
  useEffect(() => {
    // The first zoom needs the measured frame, so it is set once here, after layout.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    const z = fitted(); const start = z >= 0.7 ? z : 0.75; setZoom(start);
    const el = frame.current; const top = L.nodes.find((n) => !L.byId.get(n.id)?.managerId && L.kids.get(n.id)?.length);
    if (el && top && z < 0.7) requestAnimationFrame(() => el.scrollTo({ left: Math.max(0, top.x * start - el.clientWidth / 2 + (NW * start) / 2), top: 0 }));
  }, [fitted]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const el = frame.current; if (!el) return;
    const wheel = (e: WheelEvent) => { if (!e.ctrlKey && !e.metaKey) return; e.preventDefault(); setZoom((z) => Math.max(0.3, Math.min(2, z * (e.deltaY < 0 ? 1.1 : 0.9)))); };
    el.addEventListener("wheel", wheel, { passive: false }); return () => el.removeEventListener("wheel", wheel);
  }, []);
  // Drag the background to move around the chart.
  const drag = useRef<{ x: number; y: number; l: number; t: number } | null>(null);
  const down = (e: ReactPointerEvent<HTMLDivElement>) => { if (e.pointerType !== "mouse" || (e.target as HTMLElement).closest("button,a,input")) return; const el = frame.current!; drag.current = { x: e.clientX, y: e.clientY, l: el.scrollLeft, t: el.scrollTop }; el.setPointerCapture(e.pointerId); };
  const move = (e: ReactPointerEvent<HTMLDivElement>) => { const d = drag.current; if (!d) return; const el = frame.current!; el.scrollLeft = d.l - (e.clientX - d.x); el.scrollTop = d.t - (e.clientY - d.y); };
  const found = q.trim().length >= 2 ? data.people.filter((p) => `${p.name} ${p.role ?? ""}`.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 6) : [];
  const show = (id: string) => { setSel(id); const n = L.nodes.find((x) => x.id === id); const el = frame.current; if (n && el) el.scrollTo({ left: n.x * zoom - el.clientWidth / 2 + (NW * zoom) / 2, top: n.y * zoom - el.clientHeight / 3, behavior: "smooth" }); };
  const dim = (p: OrgPerson) => (focusPod && p.pod !== focusPod) || (dept && p.department !== dept);
  const person = sel ? L.byId.get(sel) ?? null : null;
  return <div className={css.org} data-grow="">
    <div className={css.bar}>
      <span className={css.search}><Search size={14} aria-hidden="true" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find someone" aria-label="Find someone" />
        {found.length ? <ul className={css.found} role="listbox" aria-label="People">{found.map((p) => <li key={p.id} role="option" aria-selected={false} onMouseDown={(e) => { e.preventDefault(); setQ(""); show(p.id); }}><Avatar name={p.name} id={p.id} photoAt={p.photoAt} size={22} />{p.name}<small>{p.role}</small></li>)}</ul> : null}</span>
      <span className={css.pods} role="group" aria-label="Pods">{pods.map((p) => <button key={p} type="button" data-slot={slot(p)} aria-pressed={focusPod === p} onClick={() => setFocusPod(focusPod === p ? null : p)}><i aria-hidden="true" />{p}</button>)}</span>
      {data.proposals.length ? <label className={css.toggle}><input type="checkbox" checked={preview} onChange={(e) => setPreview(e.target.checked)} /><span>Show proposed lines<i aria-hidden="true" /></span></label> : null}
      {data.departments.length ? <SelectField className={css.select} value={dept} onChange={(e) => setDept(e.target.value)} aria-label="Department"><option value="">Every department</option>{data.departments.map((d) => <option key={d}>{d}</option>)}</SelectField> : null}
      <span className={css.zoom} role="group" aria-label="Zoom">
        <button type="button" onClick={() => setZoom((z) => Math.max(0.3, z - 0.15))} aria-label="Zoom out"><Minus size={14} /></button><output aria-live="polite">{Math.round(zoom * 100)}%</output>
        <button type="button" onClick={() => setZoom((z) => Math.min(2, z + 0.15))} aria-label="Zoom in"><Plus size={14} /></button><button type="button" onClick={fit} aria-label="Fit to the screen"><Maximize2 size={14} /></button></span>
    </div>
    <div className={css.body}>
      <div className={css.frame} ref={frame} onPointerDown={down} onPointerMove={move} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
        <div className={css.canvas} style={{ width: L.width * zoom, height: L.height * zoom }}>
          <div className={css.inner} style={{ width: L.width, height: L.height, transform: `scale(${zoom})` }}>
            <svg className={css.edges} width={L.width} height={L.height} aria-hidden="true">{L.edges.map((e, i) => <path key={i} d={e.d} data-proposed={e.proposed ? "" : undefined} />)}</svg>
            {L.nodes.map((n) => { const p = L.byId.get(n.id)!; const reports = L.kids.get(p.id)?.length ?? 0; const heads = headOf.get(p.id); const maybeHead = !heads ? proposedHead.get(p.id) : undefined;
              return <button key={p.id} type="button" className={css.node} style={{ left: n.x, top: n.y, width: NW, height: NH }} data-slot={slot(p.pod)} data-dim={dim(p) ? "" : undefined} data-proposed={L.guess(p.id) ? "" : undefined}
                aria-pressed={sel === p.id} onClick={() => setSel(sel === p.id ? null : p.id)} aria-label={`${p.name}, ${p.role ?? "no role"}${p.pod ? `, ${p.pod}` : ""}${heads ? `, heads ${heads}` : ""}${reports ? `, ${reports} report${reports === 1 ? "" : "s"}` : ""}`}>
                <Avatar name={p.name} id={p.id} photoAt={p.photoAt} size={34} />
                <span className={css.nodeMain}><b>{p.name}</b><small>{p.role ?? "No role yet"}</small>
                  <span className={css.tags}>{p.pod ? <em data-slot={slot(p.pod)}>{p.pod}</em> : null}{heads ? <em data-kind="head"><Crown size={10} aria-hidden="true" />Head</em> : maybeHead ? <em data-kind="head" data-proposed=""><Crown size={10} aria-hidden="true" />Head?</em> : null}{reports ? <em><Users size={10} aria-hidden="true" />{reports}</em> : null}</span></span>
              </button>; })}
          </div>
        </div>
      </div>
      <aside className={css.side} aria-label={person ? person.name : "Reporting lines"}>
        {person ? <PersonPanel p={person} data={data} reports={L.kids.get(person.id) ?? []} manager={person.managerId ? L.byId.get(person.managerId) ?? null : null} heads={headOf.get(person.id) ?? null} onClose={() => setSel(null)} onShow={show} onSaved={() => router.refresh()} />
          : <Overview data={data} loose={L.loose} onShow={show} onSaved={() => router.refresh()} />}
      </aside>
    </div>
    <details className={css.list}><summary>The same as a list</summary><Tree ids={L.nodes.map((n) => n.id).filter((id) => { const p = L.byId.get(id)!; return !p.managerId || !L.byId.has(p.managerId); })} kids={L.kids} byId={L.byId} />
      {L.loose.length ? <p>Not placed yet: {L.loose.map((p) => p.name).join(", ")}</p> : null}</details>
  </div>;
}

function Tree({ ids, kids, byId }: { ids: string[]; kids: Map<string, OrgPerson[]>; byId: Map<string, OrgPerson> }) {
  return <ul>{ids.map((id) => { const p = byId.get(id)!; const k = kids.get(id) ?? []; return <li key={id}>{p.name}{p.role ? ` (${p.role})` : ""}{k.length ? <Tree ids={k.map((x) => x.id)} kids={kids} byId={byId} /> : null}</li>; })}</ul>;
}

function PersonPanel({ p, data, reports, manager, heads, onClose, onShow, onSaved }: { p: OrgPerson; data: OrgData; reports: OrgPerson[]; manager: OrgPerson | null; heads: string | null; onClose: () => void; onShow: (id: string) => void; onSaved: () => void }) {
  const [busy, setBusy] = useState(false), [picking, setPicking] = useState(false);
  const pick: Pick[] = data.people.filter((x) => x.id !== p.id).map((x) => ({ id: x.id, name: x.name, pod: x.pod, role: x.role, photoAt: x.photoAt }));
  async function run(path: string, body: Record<string, unknown>, ok: string) {
    setBusy(true); try { await post(path, body); notify({ id: "org", tone: "success", title: ok, timeout: 3000 }); setPicking(false); onSaved(); }
    catch (e) { notify({ id: "org", tone: "error", title: "Not changed", message: msg(e) }); } finally { setBusy(false); }
  }
  const proposal = data.proposals.find((x) => x.personId === p.id && x.kind === "manager");
  return <div className={css.panel}>
    <div className={css.panelHead}><Avatar name={p.name} id={p.id} photoAt={p.photoAt} size={44} /><span><b>{p.name}</b><small>{[p.role, p.pod, p.department].filter(Boolean).join(" · ")}</small></span>
      <button type="button" className={css.iconBtn} onClick={onClose} aria-label="Close"><X size={15} aria-hidden="true" /></button></div>
    <dl className={css.facts}>
      <dt>Reports to</dt><dd>{manager ? <button type="button" className={css.linkBtn} onClick={() => onShow(manager.id)}>{manager.name}</button> : <span className={styles.muted}>Nobody{TOP.test(p.role ?? "") ? " (top of the company)" : " yet"}</span>}</dd>
      <dt>Reports</dt><dd>{reports.length ? reports.map((r, i) => <span key={r.id}>{i ? ", " : ""}<button type="button" className={css.linkBtn} onClick={() => onShow(r.id)}>{r.name.split(" ")[0]}</button></span>) : <span className={styles.muted}>None</span>}</dd>
      {heads ? <><dt>Heads</dt><dd>{heads}</dd></> : null}
    </dl>
    {proposal ? <p className={css.hint}><Sparkles size={13} aria-hidden="true" />Pulse proposes {proposal.managerName} ({Math.round(proposal.confidence * 100)}%): {proposal.evidence[0]}</p> : null}
    {data.canEdit ? <div className={css.actions}>
      {picking ? <PersonPicker people={pick} value={null} onChange={(x) => x && void run("org/line", { personId: p.id, managerId: x.id }, `${p.name.split(" ")[0]} reports to ${x.name}`)} me={data.me ?? ""} label="Reports to" autoFocus />
        : <button type="button" className={styles.btn} disabled={busy} onClick={() => setPicking(true)}><UserRound size={13} aria-hidden="true" />{manager ? "Change who they report to" : "Set who they report to"}</button>}
      {manager ? <button type="button" className={styles.btn} disabled={busy} onClick={() => void run("org/line", { personId: p.id, managerId: null }, "Line removed")}>Reports to nobody</button> : null}
      {p.pod && !heads ? <button type="button" className={styles.btn} disabled={busy} onClick={() => void run("org/pod-head", { pod: p.pod, personId: p.id }, `${p.name.split(" ")[0]} heads ${p.pod}`)}><Crown size={13} aria-hidden="true" />Make head of {p.pod}</button> : null}
    </div> : null}
    <p className={css.links}><Link href={`/tasks/people/${p.id}`}>Their work</Link> · <Link href={`/tasks/outcomes?person=${p.id}`}>Outcomes</Link> · <Link href={`/people/${p.id}`}>Profile</Link></p>
  </div>;
}

function Overview({ data, loose, onShow, onSaved }: { data: OrgData; loose: OrgPerson[]; onShow: (id: string) => void; onSaved: () => void }) {
  const [busy, setBusy] = useState(false);
  async function run(path: string, body: Record<string, unknown>, ok: (r: Record<string, unknown>) => string) {
    setBusy(true); try { const r = await post<Record<string, unknown>>(path, body); notify({ id: "org", tone: "success", title: ok(r), timeout: 3500 }); onSaved(); }
    catch (e) { notify({ id: "org", tone: "error", title: "Not done", message: msg(e) }); } finally { setBusy(false); }
  }
  const strong = data.proposals.filter((x) => x.confidence >= 0.6).length;
  return <div className={css.panel}>
    {data.canSuggest ? <section className={css.proposals} aria-label="Proposed lines">
      <div className={css.sectionHead}><h2><Sparkles size={15} aria-hidden="true" />Proposed lines</h2>
        <button type="button" className={styles.btn} disabled={busy} onClick={() => void run("org/suggest", {}, (r) => `${r.proposed} proposals from the roster, pods, groups and work`)}>Look again</button></div>
      {data.proposals.length ? <>
        <p className={css.hint}>From the roster, pods and roles, Workspace groups, PEOPLE-LIVE (who is the client’s PGS or PM, who works on whose clients) and who gives whom tasks. Nothing changes until HR confirms.</p>
        {data.canEdit && strong ? <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy} onClick={() => void run("org/proposals/confirm-all", { min: 0.6 }, (r) => `${r.confirmed} confirmed`)}><Check size={13} aria-hidden="true" />Confirm the {strong} at 60% or more</button> : null}
        <ul className={css.propList}>{data.proposals.map((x) => <li key={x.id} data-kind={x.kind}>
          <span className={css.propTop}><button type="button" className={css.linkBtn} onClick={() => onShow(x.personId)}><b>{x.personName}</b></button>{x.kind === "pod_head" ? <> heads <b>{x.pod}</b></> : <> → <button type="button" className={css.linkBtn} onClick={() => onShow(x.managerId!)}>{x.managerName}</button></>}
            <em data-strong={x.confidence >= 0.6 ? "" : undefined}>{Math.round(x.confidence * 100)}%</em></span>
          <small>{x.evidence.join(" · ")}</small>
          {data.canEdit ? <span className={css.propActions}><button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy} onClick={() => void run(`org/proposals/${x.id}/confirm`, {}, () => "Confirmed")}><Check size={13} aria-hidden="true" />Confirm</button>
            <button type="button" className={styles.btn} disabled={busy} onClick={() => void run(`org/proposals/${x.id}/dismiss`, {}, () => "Dismissed")}>Not right</button></span> : null}
        </li>)}</ul></>
        : <p className={css.hint}>{data.decided?.confirmed || data.decided?.dismissed ? `Nothing waiting: ${data.decided.confirmed} confirmed, ${data.decided.dismissed} not right.` : "Press Look again: Pulse reads the roster, pods, groups and work to propose who reports to whom."}</p>}
    </section> : <p className={css.hint}>HR and admins set reporting lines. Pick anyone to see who they report to and who reports to them.</p>}
    {loose.length ? <section aria-label="Not placed yet"><div className={css.sectionHead}><h2>Not placed yet</h2><small>{loose.length}</small></div>
      <ul className={css.loose}>{loose.map((p) => <li key={p.id}><button type="button" className={css.linkBtn} onClick={() => onShow(p.id)}><Avatar name={p.name} id={p.id} photoAt={p.photoAt} size={22} />{p.name}</button><small>{[p.role, p.pod].filter(Boolean).join(" · ")}</small></li>)}</ul></section> : null}
  </div>;
}
