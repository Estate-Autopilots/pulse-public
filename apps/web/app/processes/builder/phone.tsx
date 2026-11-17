// FLOW-B: a process on a phone: its stages and steps as a list you read top to bottom (who, when it is due, what it
// needs and makes, which packages it runs for). The canvas is for a computer; nothing is edited here.
import { Monitor } from "lucide-react";
import { moduleOf } from "../../lib/flow-canvas.mjs";
import type { FlowDef, FlowStep, ModuleManifest, Primitive, ProcessDetail } from "../flow-types";
import { known } from "./known";
import { KIND_SLOT, KIND_WORD, ModuleIcon } from "./kinds";
import css from "./phone.module.css";

export function PhoneSteps({ process, modules, primitives = [] }: { process: ProcessDetail; modules: ModuleManifest[]; primitives?: Primitive[] }) {
  const def = process.definition as FlowDef, byKey = known(modules, primitives);
  const steps = def.steps ?? [], stages = def.stages ?? [];
  const groups = [...stages.map((g) => ({ key: g.key, label: g.label, steps: steps.filter((s) => s.stage === g.key) })),
    { key: "", label: stages.length ? "No stage" : "Steps", steps: steps.filter((s) => !s.stage || !stages.some((g) => g.key === s.stage)) }].filter((g) => g.steps.length || g.key);
  const variant = def.fields?.find((f) => f.variant && f.type === "choice");
  const role = (s: FlowStep) => s.who?.by === "role" ? def.roles?.find((r) => r.key === s.who.role)?.label ?? s.who.role ?? "Nobody yet" : s.who?.by === "starter" ? "Whoever starts it" : s.who?.by === "project_owner" ? "Project owner" : s.who?.by === "pool" ? "The pool" : "Nobody yet";
  const due = (s: FlowStep) => !s.due ? null : typeof s.due.days === "number" ? `${s.due.from === "day1" || s.due.from === "start" ? "Day " : ""}${s.due.days}${s.due.from.startsWith("step:") ? " days after" : ""}`
    : `Day ${(variant?.options ?? []).map((o) => (s.due!.days as Record<string, number>)[o.value]).filter((x) => x !== undefined).join(" / ")}`;
  const only = (s: FlowStep) => { const c = (s.when ?? []).find((x) => x.field === variant?.key && x.op === "in"); return c?.values ? c.values.map((v) => variant?.options?.find((o) => o.value === v)?.label ?? v).join(", ") : null; };
  if (!steps.length) return <p className={css.empty}>No steps yet. Open this process on a computer to add them.</p>;
  return <div className={css.list}>
    {process.canEdit ? <p className={css.note}><Monitor size={14} aria-hidden="true" />Change the steps on a computer: the canvas needs the room.</p> : null}
    {groups.map((g, gi) => <section key={g.key || "none"} className={css.stage} aria-label={g.label}>
      <h3>{/^\d/.test(g.label) ? null : <span>{g.key ? gi + 1 : "·"}</span>}{g.label}<small>{g.steps.length}</small></h3>
      <ol>{g.steps.map((s) => {
        const m = moduleOf(s, byKey), o = only(s);
        return <li key={s.id}>
          <span className={css.icon} data-k={KIND_SLOT[m.makes[0]?.kind ?? "any"]}><ModuleIcon name={m.icon} size={15} /></span>
          <span className={css.text}><b>{s.title || m.name}</b><small>{[role(s), due(s)].filter(Boolean).join(" · ")}</small>
            {m.needs.length || m.makes.length ? <span className={css.ports}>{m.needs.map((p) => <i key={`n${p.key}`} data-k={KIND_SLOT[p.kind]}>{p.label}</i>)}{m.needs.length && m.makes.length ? <em>→</em> : null}
              {m.makes.map((p) => <i key={`m${p.key}`} data-k={KIND_SLOT[p.kind]} title={KIND_WORD[p.kind]}>{p.label}</i>)}</span> : null}
            {o ? <small className={css.only}>Only for {o}</small> : null}</span>
        </li>;
      })}</ol>
    </section>)}
  </div>;
}
