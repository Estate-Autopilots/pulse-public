"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { FilePlus2, UserPlus } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { post } from "../records";
import { styles } from "../ui";
import type { Person } from "./types";
import { SelectField } from "../kit/select-field";

const message = (e: unknown) => (e instanceof Error ? e.message : "Could not save");

/** A due milestone: open (or make) its invoice draft, or give the invoice to one person as a task. */
export function MilestoneActions({ milestoneId, documentId, assignees, dueOn }: { milestoneId: string; documentId: string | null; assignees: Person[]; dueOn?: string | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false), [assigning, setAssigning] = useState(false), [who, setWho] = useState("");
  async function make(assigneeId?: string) {
    setBusy(true);
    try {
      const r = await post<{ id: string; taskId: string | null }>(`erp/milestones/${milestoneId}/invoice`, assigneeId ? { assigneeId, dueOn } : {});
      if (assigneeId) { notify({ id: "erp-task", tone: "success", title: "Invoice task created", message: "The draft is attached; the task is done when the invoice is issued.", timeout: 4000 }); setAssigning(false); router.refresh(); }
      else router.push(`/erp/documents/${r.id}`);
    } catch (e) { notify({ id: "erp-task", tone: "error", title: "Not done", message: message(e) }); } finally { setBusy(false); }
  }
  if (assigning) return <span className={styles.inline}>
    <SelectField className={styles.input} value={who} onChange={(e) => setWho(e.target.value)} aria-label="Who generates this invoice" style={{ width: 170 }}>
      <option value="">Choose a person…</option>
      {assignees.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
    </SelectField>
    <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnPrimary}`} disabled={!who || busy} onClick={() => make(who)}>Assign</button>
    <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} onClick={() => setAssigning(false)}>Cancel</button>
  </span>;
  return <span className={styles.inline}>
    {assignees.length && !documentId ? <button type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={busy} onClick={() => setAssigning(true)}><UserPlus size={13} aria-hidden="true" />Assign</button> : null}
    <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnPrimary}`} disabled={busy} onClick={() => documentId ? router.push(`/erp/documents/${documentId}`) : make()}>
      <FilePlus2 size={13} aria-hidden="true" />{documentId ? "Open draft" : "Create invoice"}</button>
  </span>;
}
