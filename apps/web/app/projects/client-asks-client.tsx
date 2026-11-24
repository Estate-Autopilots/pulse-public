"use client";
// PM-BUILD-4: the lead's two taps on "We need from the client": copy the drafted request (they send it themselves, in
// the client's group or by e-mail) and mark the inputs as asked (each starts its wait). Nothing is sent by Vitals OS.
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Copy } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { post } from "../records";
import { styles } from "../ui";
import css from "./pm-project.module.css";

export function ClientAskActions({ projectId, draft, taskIds }: { projectId: string; draft: string; taskIds: string[] }) {
  const router = useRouter(); const [busy, setBusy] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(draft); notify({ id: "ask-copy", tone: "success", title: "Request copied", message: "Paste it in the client's group. Vitals OS sends nothing.", timeout: 3000 }); }
    catch { notify({ id: "ask-copy", tone: "error", title: "Could not copy", message: draft.slice(0, 300) }); }
  };
  const asked = async () => {
    setBusy(true);
    try { const r = await post<{ asked: number }>(`projects/${projectId}/client-asks`, { taskIds }); notify({ id: "ask-mark", tone: "success", title: `Marked as asked: ${r.asked}`, timeout: 2500 }); router.refresh(); }
    catch (e) { notify({ id: "ask-mark", tone: "error", title: "Not marked", message: e instanceof Error ? e.message : String(e) }); }
    finally { setBusy(false); }
  };
  return <div className={css.askBox}>
    <ol className={css.askSteps}><li>Copy the request and send it in the client&apos;s group.</li><li>Mark it as asked: the waiting time starts.</li></ol>
    <div className={css.askActions}>
      <button type="button" className={styles.btn} onClick={() => void copy()}><Copy size={14} aria-hidden="true" />Copy the request</button>
      <button type="button" className={styles.btn} onClick={() => void asked()} disabled={busy}>{busy ? "Saving…" : "Mark as asked"}</button>
    </div>
  </div>;
}
