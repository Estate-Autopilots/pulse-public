"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { post } from "../records";
import { styles } from "../ui";
import { SelectField } from "../kit/select-field";

/** Accept or dismiss a whole review group. Project pods without a proposed pod take the pod chosen here. */
export function ReviewGroupDecision({ kind, groupKey, count, canAccept, pods, needsPod }: { kind: string; groupKey: string; count: number; canAccept: boolean; pods: string[]; needsPod: boolean }) {
  const router = useRouter(); const [busy, setBusy] = useState(false), [note, setNote] = useState(""), [pod, setPod] = useState("");
  const act = async (action: string) => {
    setBusy(true); setNote("");
    try { const r = await post<{ count: number }>("review-data/decide-group", { kind, key: groupKey, action, ...(pod ? { pod } : {}) }); setNote(`${r.count.toLocaleString("en-IN")} ${action === "accept" ? "accepted" : "dismissed"}`); router.refresh(); }
    catch (e) { setNote(e instanceof Error ? e.message : "Could not save"); } finally { setBusy(false); }
  };
  return <span className={styles.inline}>
    {needsPod ? <SelectField aria-label="Pod for this group" value={pod} onChange={e => setPod(e.target.value)}><option value="">Choose a pod</option>{pods.map(p => <option key={p}>{p}</option>)}</SelectField> : null}
    <button type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={busy || !(canAccept || (needsPod && pod))} onClick={() => act("accept")}>
      {kind === "data_gap" ? "Mark all done" : "Accept all"} {count.toLocaleString("en-IN")}</button>
    <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} disabled={busy} onClick={() => act("dismiss")}>Dismiss all</button>
    {note ? <span role="status" className={styles.muted}>{note}</span> : null}
  </span>;
}
