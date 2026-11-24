"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ArrowRight } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { post } from "../../records";
import { styles } from "../../ui";

/** One tap: the step goes to the person with room (the task's own save, with its rules and its notices). */
export function ReassignButton({ taskId, toId, toName, fromName }: { taskId: string; toId: string; toName: string; fromName: string }) {
  const router = useRouter(); const [busy, setBusy] = useState(false);
  return <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy} onClick={async () => {
    setBusy(true);
    try { await post(`tasks/${taskId}`, { assigneeId: toId }); notify({ id: "reassign", tone: "success", title: `Moved to ${toName}`, message: `${fromName} and ${toName} are told.` }); router.refresh(); }
    catch (e) { notify({ id: "reassign", tone: "error", title: "Not moved", message: e instanceof Error ? e.message : String(e) }); }
    finally { setBusy(false); }
  }}>Reassign<ArrowRight size={15} aria-hidden="true" /></button>;
}
