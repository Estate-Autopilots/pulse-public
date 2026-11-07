"use client";
// FLOW-B: an older SOP, workflow or board opens here as it is (read only). Edit it as a process: the flow API makes a
// process from it (its steps, people and write-up come along) and the builder opens on that; the old one stays as it was.
import { useRouter } from "next/navigation";
import { useState } from "react";
import { History, Pencil } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { styles } from "../../ui";
import { flow, why } from "../flow-client";
import type { ProcessDetail } from "../flow-types";
import css from "./process.module.css";

const WORD = { sop: "SOP", workflow: "workflow", board: "board", flow: "process" } as const;

export function MakeProcess({ process }: { process: ProcessDetail }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function make() {
    setBusy(true);
    try {
      const r = await flow<ProcessDetail>(`processes/${encodeURIComponent(process.id)}`, "POST", {});
      notify({ id: "make-process", tone: "success", title: "Made a process from it", message: `The ${WORD[process.source]} stays as it was.`, timeout: 3500 });
      router.push(`/processes/${encodeURIComponent(r.id)}`);
    } catch (e) { notify({ id: "make-process", tone: "error", title: "Not made", message: why(e) }); setBusy(false); }
  }
  return <div className={css.legacy}>
    <History size={16} aria-hidden="true" />
    <p><b>An older {WORD[process.source]}, shown as it is.</b> To change its steps, edit it as a process: its steps, people and write-up come along, and the {WORD[process.source]} stays as it was.</p>
    <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy} onClick={() => void make()}><Pencil size={14} aria-hidden="true" />{busy ? "Making it…" : "Edit it as a process"}</button>
  </div>;
}
