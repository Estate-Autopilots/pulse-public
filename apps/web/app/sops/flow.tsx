"use client";
// SOP-WORKFLOW: the visual SOP. Swimlanes are the roles (or people) who own the steps, with the people who hold each
// role on the lane; columns follow the flow and phases band the top. A connection that changes lane is a handoff (drawn
// in the accent colour); "send back" loops over the top, dashed. Click a step to see or edit it; zoom (buttons, Ctrl +
// wheel), Fit, and drag the background to move. The same steps are a numbered list for screen readers and phones.
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ArrowRightLeft, CheckCheck, CircleCheck, Clock, Diamond, Flag, Maximize2, Minus, Plus, Timer, UserRound, Users } from "lucide-react";
import { hoursText, layoutFlow, SIZE } from "../lib/sop-flow.mjs";
import { Avatar } from "../ui";
import { timeText } from "./parts";
import type { Holder, SopStep } from "./types";
import css from "./sops.module.css";

const ICON = { decision: Diamond, approval: CheckCheck, wait: Timer, end: Flag, task: null } as const;
/** Roles outside the company: their lane says so instead of "nobody holds it yet". */
const OUTSIDE = /^(the )?(client|customer|vendor|supplier|partner|developer|model)s?$/i;


/** A run's state on a step: drawn on the step (done, doing and by whom, waiting, skipped, late). */
export type StepState = { status: "waiting" | "active" | "done" | "skipped" | "cancelled"; late?: boolean; person?: Holder | null; outcome?: string | null; text?: string | null };
const STATE_WORD = { waiting: "Waiting", active: "Doing", done: "Done", skipped: "Skipped", cancelled: "Stopped" } as const;

export function FlowCanvas({ steps, people = {}, persons = {}, selected, onSelect, height, label = "SOP flow", issues, states }: {
  steps: Pick<SopStep, "id" | "title" | "kind" | "role" | "personId" | "phase" | "next" | "minutes" | "slaHours" | "inputs" | "outputs">[]; people?: Record<string, Holder[]>; persons?: Record<string, Holder>;
  selected?: string | null; onSelect?: (id: string | null) => void; height?: number; label?: string;
  /** step id → a short warning drawn on the step (the builder's bottlenecks). */ issues?: Record<string, string>;
  /** step id → where a run stands on it. */ states?: Record<string, StepState>;
}) {
  const [by, setBy] = useState<"role" | "person">("role");
  const names = useMemo(() => Object.fromEntries(Object.values(persons).map((p) => [p.id, p.name])), [persons]);
  const L = useMemo(() => layoutFlow(steps, { by, names }), [steps, by, names]);
  const slot = useMemo(() => new Map(L.lanes.map((l, i) => [l.key, l.key === "none" ? 0 : (i % 6) + 1])), [L.lanes]);
  const into = useMemo(() => { const m = new Map<string, string>(); for (const e of L.edges) if (e.handoff && !e.back) m.set(e.to, L.lanes.find((l) => l.key === L.nodes.find((n) => n.id === e.from)?.lane)?.label ?? ""); return m; }, [L]);
  const frame = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1), [scroll, setScroll] = useState(0);
  const fitted = useCallback(() => { const el = frame.current; return el ? Math.max(0.35, Math.min(1, Math.min((el.clientWidth - 8) / L.width, (el.clientHeight - 8) / L.height))) : 1; }, [L.width, L.height]);
  // Open readable: fitted when that is large enough, else at 75% (Fit shows it all). Measured after layout.
  useEffect(() => { const id = requestAnimationFrame(() => { const z = fitted(); const narrow = (frame.current?.clientWidth ?? 1000) < 600; setZoom(z >= 0.6 ? z : narrow ? 0.6 : 0.75); }); return () => cancelAnimationFrame(id); }, [fitted]);
  useEffect(() => {
    const el = frame.current; if (!el) return;
    const wheel = (e: WheelEvent) => { if (!e.ctrlKey && !e.metaKey) return; e.preventDefault(); setZoom((z) => Math.max(0.35, Math.min(1.8, z * (e.deltaY < 0 ? 1.1 : 0.9)))); };
    el.addEventListener("wheel", wheel, { passive: false }); return () => el.removeEventListener("wheel", wheel);
  }, []);
  // Bring the chosen step into view (from the list, the side panel or a new step in the builder).
  useEffect(() => {
    const el = frame.current, n = selected ? L.nodes.find((x) => x.id === selected) : null; if (!el || !n) return;
    const left = n.x * zoom, top = n.y * zoom, w = n.w * zoom, h = n.h * zoom;
    if (left < el.scrollLeft + SIZE.rail * zoom || left + w > el.scrollLeft + el.clientWidth || top < el.scrollTop || top + h > el.scrollTop + el.clientHeight)
      el.scrollTo({ left: Math.max(0, left - el.clientWidth / 2 + w / 2), top: Math.max(0, top - el.clientHeight / 2 + h / 2), behavior: "smooth" });
  }, [selected]); // eslint-disable-line react-hooks/exhaustive-deps
  const drag = useRef<{ x: number; y: number; l: number; t: number } | null>(null);
  const down = (e: ReactPointerEvent<HTMLDivElement>) => { if (e.pointerType !== "mouse" || (e.target as HTMLElement).closest("button,a,input")) return; const el = frame.current!; drag.current = { x: e.clientX, y: e.clientY, l: el.scrollLeft, t: el.scrollTop }; el.setPointerCapture(e.pointerId); };
  const move = (e: ReactPointerEvent<HTMLDivElement>) => { const d = drag.current; if (!d) return; const el = frame.current!; el.scrollLeft = d.l - (e.clientX - d.x); el.scrollTop = d.t - (e.clientY - d.y); };
  const byId = useMemo(() => new Map(steps.map((s, i) => [s.id, { s, i }])), [steps]);
  const hasPeople = steps.some((s) => s.personId);
  if (!steps.length) return null;
  return <div className={css.flow} data-grow="" style={height ? { height } : undefined}>
    <div className={css.flowBar}>
      <span className={css.legend} aria-hidden="true"><i data-kind="handoff" />Handoff<i data-kind="back" />Sent back<Diamond size={12} />Decision<CheckCheck size={12} />Approval</span>
      {hasPeople ? <span className={css.toggle} role="group" aria-label="Lanes"><button type="button" aria-pressed={by === "role"} onClick={() => setBy("role")}><Users size={13} aria-hidden="true" />Roles</button>
        <button type="button" aria-pressed={by === "person"} onClick={() => setBy("person")}><UserRound size={13} aria-hidden="true" />People</button></span> : null}
      <span className={css.zoom} role="group" aria-label="Zoom">
        <button type="button" onClick={() => setZoom((z) => Math.max(0.35, z - 0.15))} aria-label="Zoom out"><Minus size={14} /></button><output aria-live="polite">{Math.round(zoom * 100)}%</output>
        <button type="button" onClick={() => setZoom((z) => Math.min(1.8, z + 0.15))} aria-label="Zoom in"><Plus size={14} /></button><button type="button" onClick={() => setZoom(fitted())} aria-label="Fit to the screen"><Maximize2 size={14} /></button></span>
    </div>
    <div className={css.flowWrap}>
      <div className={css.frame} ref={frame} onScroll={(e) => setScroll(e.currentTarget.scrollTop)} onPointerDown={down} onPointerMove={move} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}
        onClick={(e) => { if (e.target === e.currentTarget) onSelect?.(null); }} aria-label={label} role="region">
        <div className={css.canvas} style={{ width: L.width * zoom, height: L.height * zoom }}>
          <div className={css.inner} style={{ width: L.width, height: L.height, transform: `scale(${zoom})` }}>
            {L.lanes.map((l, i) => <div key={l.key} className={css.laneBand} data-odd={i % 2 ? "" : undefined} data-slot={slot.get(l.key)} style={{ top: l.y, height: l.h, width: L.width }} />)}
            {L.phases.map((p) => <div key={p.label} className={css.phase} style={{ left: p.x0 - 12, width: p.x1 - p.x0 + 24, height: L.height - 8 }}><span title={p.label}>{p.label}</span></div>)}
            <svg className={css.edges} width={L.width} height={L.height} aria-hidden="true">
              <defs>{["plain", "handoff", "back"].map((k) => <marker key={k} id={`sop-arrow-${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" data-arrow={k} /></marker>)}</defs>
              {L.edges.map((e, i) => <path key={i} d={e.d} data-kind={e.back ? "back" : e.handoff ? "handoff" : "plain"} markerEnd={`url(#sop-arrow-${e.back ? "back" : e.handoff ? "handoff" : "plain"})`} />)}
            </svg>
            {L.edges.filter((e) => e.label).map((e, i) => <span key={i} className={css.edgeLabel} data-kind={e.back ? "back" : undefined} style={{ left: e.lx, top: e.ly }}>{e.label}</span>)}
            {L.nodes.map((n) => { const { s, i } = byId.get(n.id)!; const Icon = ICON[s.kind]; const t = timeText(s); const from = into.get(s.id); const st = states?.[s.id];
              const who = st?.person ?? (s.personId ? persons[s.personId] : null);
              const stateText = st ? [STATE_WORD[st.status], st.outcome, st.status === "active" && st.person ? st.person.name.split(" ")[0] : null, st.late ? "late" : null, st.text].filter(Boolean).join(" · ") : null;
              return <button key={n.id} type="button" className={css.node} data-kind={s.kind} data-slot={slot.get(n.lane)} aria-pressed={selected === n.id} style={{ left: n.x, top: n.y, width: n.w, height: n.h }}
                onClick={() => onSelect?.(selected === n.id ? null : n.id)} data-issue={issues?.[s.id] ? "" : undefined} data-state={st?.status} data-late={st?.late ? "" : undefined}
                aria-label={`Step ${i + 1}: ${s.title || "Untitled"}${s.role ? `, ${s.role}` : ""}${who ? `, ${who.name}` : ""}${from ? `, handed over from ${from}` : ""}${stateText ? `, ${stateText}` : t ? `, ${t}` : ""}${issues?.[s.id] ? `. ${issues[s.id]}` : ""}`}>
                <span className={css.nodeTop}><b>{i + 1}</b>{st?.status === "done" ? <CircleCheck size={12} aria-hidden="true" className={css.doneIcon} /> : Icon ? <Icon size={12} aria-hidden="true" /> : null}{from ? <ArrowRightLeft size={11} aria-hidden="true" className={css.handoffIcon} /> : null}
                  {who ? <Avatar name={who.name} id={who.id} photoAt={who.photoAt} size={18} /> : null}</span>
                <span className={css.nodeTitle}>{s.title || "Untitled step"}</span>
                <span className={css.nodeMeta}>{issues?.[s.id] ? <em className={css.issue}>{issues[s.id]}</em> : stateText ? <em className={css.stateText}>{stateText}</em> : t ? <><Clock size={10} aria-hidden="true" />{t}</> : s.inputs.length || s.outputs.length ? `${s.inputs.length} in · ${s.outputs.length} out` : null}</span>
              </button>; })}
          </div>
        </div>
      </div>
      <div className={css.rail} aria-hidden="true" style={{ transform: `translateY(${-scroll}px) scale(${zoom})`, height: L.height, width: SIZE.rail }}>
        {L.lanes.map((l) => { const holders = l.key.startsWith("r:") ? people[l.label] ?? [] : []; const person = l.key.startsWith("p:") ? persons[l.key.slice(2)] : null;
          return <div key={l.key} className={css.lane} data-slot={slot.get(l.key)} style={{ top: l.y, height: l.h }}>
            <b title={l.label}>{l.label}</b>
            <small>{person ? "Person" : holders.length ? `${holders.length} ${holders.length === 1 ? "person" : "people"}` : l.key === "none" ? "Choose a role" : OUTSIDE.test(l.label) ? "Outside the team" : "Nobody holds it yet"} · {l.steps} step{l.steps === 1 ? "" : "s"}</small>
            {holders.length ? <span className={css.faces}>{holders.slice(0, 4).map((h) => <Avatar key={h.id} name={h.name} id={h.id} photoAt={h.photoAt} size={22} />)}{holders.length > 4 ? <em>+{holders.length - 4}</em> : null}</span>
              : person ? <span className={css.faces}><Avatar name={person.name} id={person.id} photoAt={person.photoAt} size={22} /></span> : null}
          </div>; })}
      </div>
    </div>
  </div>;
}
