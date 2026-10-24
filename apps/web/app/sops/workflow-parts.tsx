"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Plus, Workflow } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { post, Modal } from "../records";
import { styles } from "../ui";
import css from "./sops.module.css";

const msg = (e: unknown) => e instanceof Error ? e.message : "That did not work. Try again.";

/** New workflow: from an active SOP (its steps and owners) or blank. */
export function NewWorkflow({ sops }: { sops: { id: string; title: string }[] }) {
  const router = useRouter(); const [open, setOpen] = useState(false), [sop, setSop] = useState(sops[0]?.id ?? ""), [busy, setBusy] = useState(false);
  async function make(from: "sop" | "blank") {
    setBusy(true);
    try {
      const r = from === "sop" ? await post<{ id: string }>("workflows/from-sop", { sopId: sop })
        : await post<{ id: string }>("workflows", { name: "New workflow", definition: { steps: [{ id: "s1", title: "First step", assign: { by: "starter" } }] }, trigger: { kind: "manual" } });
      router.push(`/sops/workflows/${r.id}`);
    } catch (e) { notify({ id: "wf", tone: "error", title: "Not made", message: msg(e) }); setBusy(false); }
  }
  return <>
    <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => setOpen(true)}><Plus size={14} aria-hidden="true" />New workflow</button>
    {open ? <Modal title="New workflow" sub="Every step becomes a task for the right person when the step before it is done." onClose={() => setOpen(false)} scroll>
      <div className={css.panel}>
        {sops.length ? <div className={css.box}>
          <p className={css.sub}>From an SOP</p>
          <label className={css.field}><span>SOP</span><select value={sop} onChange={(e) => setSop(e.target.value)}>{sops.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}</select></label>
          <p className={css.hint}>Its steps, roles, times and branches come along; each step goes to whoever holds its role.</p>
          <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || !sop} onClick={() => void make("sop")}><Workflow size={14} aria-hidden="true" />Make the workflow</button>
        </div> : <p className={css.hint}>There are no active SOPs yet: start blank, or make an SOP first.</p>}
        <button type="button" className={styles.btn} disabled={busy} onClick={() => void make("blank")}>Start blank</button>
      </div>
    </Modal> : null}
  </>;
}
