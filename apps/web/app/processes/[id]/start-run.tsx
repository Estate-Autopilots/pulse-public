"use client";
// FLOW-B: Start a run, in a centred sheet: what to call it (the client or project) and the process's fields (the package,
// the segment…). Its first steps go to their people straight away; steps that need data wait for it, named.
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Play } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { DrawerFooter } from "../../kit";
import { Modal } from "../../records";
import { styles } from "../../ui";
import { flow, why } from "../flow-client";
import type { ProcessDetail } from "../flow-types";
import css from "./process.module.css";
import { SelectField } from "../../kit/select-field";

export function StartRun({ process }: { process: ProcessDetail }) {
  const router = useRouter();
  const word = process.terms?.run ?? "Run";
  const fields = (process.definition.fields ?? []).filter((f) => f.type !== "person");
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [name, setName] = useState(""), [values, setValues] = useState<Record<string, unknown>>({});
  // Who is on it: each role's people in the company, the only one chosen already; a role can be named later on the run.
  const roles = (process.definition.roles ?? []).filter((r) => (process.roleHolders?.[r.key] ?? []).length);
  const [people, setPeople] = useState<Record<string, string>>(() => Object.fromEntries(roles.flatMap((r) => { const list = process.roleHolders[r.key] ?? []; return list.length === 1 ? [[r.key, list[0].id]] : []; })));
  const missing = fields.filter((f) => f.required && (values[f.key] === undefined || values[f.key] === ""));
  // A demo (leadership): the process as it is now, made-up names for every role, nothing sent and no Work tasks.
  const live = process.status === "live" && process.canStart, [demo, setDemo] = useState(!live);
  async function start(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError("");
    try {
      const crew = demo ? Object.fromEntries((process.definition.roles ?? []).map((r) => [r.key, { name: `${r.label} (demo)` }])) : Object.fromEntries(Object.entries(people).filter(([, v]) => v));
      const r = await flow<{ id: string }>(`processes/${encodeURIComponent(process.id)}/runs`, "POST", { name: name.trim(), fields: values, people: crew, ...(demo ? { mode: "demo" } : {}) });
      notify({ id: "run", tone: "success", title: demo ? "Demo started: nobody is told" : `${word} started: its first steps are with their people`, timeout: 3500 });
      router.push(`/runs/${r.id}`);
    } catch (err) { setError(why(err)); setBusy(false); }
  }
  return <>
    <button type="button" className={`${styles.btn} ${live ? styles.btnPrimary : ""}`} onClick={() => setOpen(true)}><Play size={14} aria-hidden="true" />{live ? `Start a ${word.toLowerCase()}` : "Try it as a demo"}</button>
    {open ? <Modal title={demo ? "Try it as a demo" : `Start a ${word.toLowerCase()}`} sub={process.name} onClose={() => setOpen(false)}
      foot={<DrawerFooter status={error}><button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={() => setOpen(false)}>Cancel</button>
        <button form="start-run" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || !name.trim() || missing.length > 0}>{busy ? "Starting…" : "Start"}</button></DrawerFooter>}>
      <form id="start-run" className={css.sheet} onSubmit={(e) => void start(e)}>
        <label className={css.field}><span>Which client or project</span><input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} placeholder="e.g. Skyline Residency" autoFocus /></label>
        {fields.map((f) => <label key={f.key} className={css.field}><span>{f.label}{f.required ? "" : <em> optional</em>}</span>
          {f.type === "choice" ? <div className={css.choices} role="radiogroup" aria-label={f.label}>{f.options?.map((o) => <button key={o.value} type="button" role="radio" aria-checked={values[f.key] === o.value}
            onClick={() => setValues({ ...values, [f.key]: o.value })}>{o.label}</button>)}</div>
            : f.type === "boolean" ? <span className={css.yesNo}><input type="checkbox" checked={!!values[f.key]} onChange={(e) => setValues({ ...values, [f.key]: e.target.checked })} />Yes</span>
              : <input type={f.type === "number" ? "number" : f.type === "date" ? "date" : "text"} value={String(values[f.key] ?? "")} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />}
          {f.help ? <small>{f.help}</small> : null}</label>)}
        {live && process.canEdit ? <label className={css.yesNo}><input type="checkbox" checked={demo} onChange={(e) => setDemo(e.target.checked)} />A demo: made-up names, nobody is told</label>
          : !live ? <p className={css.hint}>It is not live yet, so this is a demo: the steps as they are now, made-up names for each role, no tasks and nothing sent.</p> : null}
        {roles.length && !demo ? <fieldset className={css.people}><legend>Who is on it <em>the rest can be named later</em></legend>
          {roles.map((r) => <label key={r.key}><span>{r.label}</span><SelectField value={people[r.key] ?? ""} onChange={(e) => setPeople({ ...people, [r.key]: e.target.value })}>
            <option value="">Name later</option>{(process.roleHolders[r.key] ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</SelectField></label>)}
        </fieldset> : null}
        <p className={css.hint}>Steps with what they need start now and land on their people&apos;s My steps; the rest wait for their data, and say what and whose.</p>
      </form>
    </Modal> : null}
  </>;
}
