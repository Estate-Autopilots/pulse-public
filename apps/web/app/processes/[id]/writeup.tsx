// FLOW-B: a process's write-up (its SOP text), part by part, each with the steps it explains. The parts come from the
// SOP or the Drive documents the process was made from; a step links to the part that explains it.
import Link from "next/link";
import { BookOpen, ExternalLink } from "lucide-react";
import { Empty } from "../../ui";
import type { FlowDef, ProcessDetail } from "../flow-types";
import css from "./process.module.css";

export function Writeup({ process }: { process: ProcessDetail }) {
  const parts = process.writeup, def = process.definition as FlowDef;
  const sopId = process.legacy?.sopId;
  if (!parts.length) return <Empty icon={BookOpen} title="No write-up yet" compact
    text={process.canEdit ? "The write-up is the process in words: what each stage is for and how each step is done. Bring one in from Drive, or write one; then link each step to its part." : "Leadership has not written this process down yet."}
    action={process.canEdit ? { href: sopId ? `/sops/${sopId}/edit` : "/sops/drive", label: sopId ? "Write it" : "Import from Drive" } : undefined} />;
  return <div className={css.writeup}>
    <nav className={css.toc} aria-label="Parts of the write-up"><ol>{parts.map((w) => <li key={w.key} data-sub={w.parent ? "" : undefined}><a href={`#part-${w.key}`}>{w.title}</a></li>)}</ol>
      {process.canEdit && sopId ? <Link className={css.tocLink} href={`/sops/${sopId}/edit`}>Edit the write-up</Link> : null}</nav>
    <div className={css.parts}>{parts.map((w) => {
      const steps = (def.steps ?? []).filter((s) => s.sop?.section === w.key);
      return <section key={w.key} id={`part-${w.key}`} className={css.part} data-sub={w.parent ? "" : undefined}>
        <h3>{w.title}</h3>
        {steps.length ? <p className={css.used}>Explains {steps.map((s, i) => <span key={s.id}>{i ? ", " : ""}<Link href={`/processes/${process.id}?step=${encodeURIComponent(s.id)}`}>{s.title || s.id}</Link></span>)}</p> : null}
        <div className={css.body}>{w.body.split(/\n{2,}/).map((para, i) => <p key={i}>{para}</p>)}</div>
        {w.source ? <p className={css.source}>{w.source.url ? <a href={w.source.url} target="_blank" rel="noreferrer">{w.source.label}<ExternalLink size={12} aria-hidden="true" /></a> : w.source.label}</p> : null}
      </section>;
    })}</div>
  </div>;
}
