"use client";
import { useMemo, useState } from "react";
import { Play } from "lucide-react";
import { styles } from "../ui";
import { FlowCanvas } from "./flow";
import { StartRun } from "./run-parts";
import { ASSIGN_LABEL, KIND_LABEL, type WorkflowDetail } from "./types";
import css from "./sops.module.css";

/** A workflow for people who do not design it: the flow, who does each step, and Start a run when their role allows. */
export function WorkflowRead({ data }: { data: WorkflowDetail }) {
  const w = data.workflow; const [sel, setSel] = useState<string | null>(null), [starting, setStarting] = useState(false);
  const persons = useMemo(() => Object.fromEntries(data.persons.map((p) => [p.id, p])), [data.persons]);
  const step = w.definition.steps.find((s) => s.id === sel) ?? null;
  return <div className={css.area}>
    {w.purpose ? <p className={css.hint}>{w.purpose}</p> : null}
    {data.canStart ? <span><button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => setStarting(true)}><Play size={14} aria-hidden="true" />Start a run</button></span> : null}
    <div className={css.body}>
      <FlowCanvas steps={w.definition.steps} people={data.people} persons={persons} selected={sel} onSelect={setSel} height={560} label={`${w.name}: the flow`} />
      <aside className={css.side} aria-label={step ? step.title : "About this workflow"}><div className={css.panel}>
        {step ? <><div className={css.panelHead}><div><small>{KIND_LABEL[step.kind]}</small><h3>{step.title}</h3></div></div>
          <dl className={css.facts}><dt>Who</dt><dd>{step.assign.by === "role" ? step.assign.role : step.assign.by === "person" ? persons[step.assign.personId ?? ""]?.name ?? "A person" : ASSIGN_LABEL[step.assign.by]}</dd>
            {step.slaHours ? <><dt>SLA</dt><dd>{step.slaHours < 24 ? `${step.slaHours} h` : `${Math.round(step.slaHours / 2.4) / 10} d`}</dd></> : null}</dl>
          {step.detail ? <ul className={css.detail}>{step.detail.split("\n").map((l) => l.replace(/^•\s*/, "")).filter(Boolean).map((l, k) => <li key={k}>{l}</li>)}</ul> : null}</>
          : <><h3 style={{ margin: 0 }}>{w.triggerText}</h3><p className={css.hint}>Click a step to see who does it. Steps given to you appear in My tasks when the step before them is done.</p></>}
      </div></aside>
    </div>
    {starting ? <StartRun workflowId={w.id} name={w.name} onClose={() => setStarting(false)} /> : null}
  </div>;
}
