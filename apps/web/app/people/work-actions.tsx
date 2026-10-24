"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { post } from "../records";
import { styles } from "../ui";

/** Accept, dismiss or undo one evidence link. Every decision writes a receipt; undo restores the state before it. */
export function LinkDecision({ id, status, label }: { id: string; status: string; label?: string }) {
  const router = useRouter(); const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const act = async (action: string) => { setBusy(true); setError(""); try { await post("people/work/decide", { ids: [id], action }); router.refresh(); } catch (e) { setError(e instanceof Error ? e.message : "Could not save"); } finally { setBusy(false); } };
  const small = `${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`;
  return <span className={styles.inline}>
    {status === "suggested" ? <><button type="button" className={small} disabled={busy} onClick={() => act("accept")} aria-label={`Accept ${label ?? "suggestion"}`}>Accept</button>
      <button type="button" className={small} disabled={busy} onClick={() => act("dismiss")} aria-label={`Dismiss ${label ?? "suggestion"}`}>Dismiss</button></>
      : <button type="button" className={small} disabled={busy} onClick={() => act("undo")} aria-label={`Undo ${label ?? "decision"}`}>Undo</button>}
    {error ? <span role="alert" className={styles.muted}>{error}</span> : null}
  </span>;
}

/** Accept or dismiss every suggestion in one review group (for one person when given). */
export function GroupDecision({ group, personId, count, label = "Accept all" }: { group: string; personId?: string; count: number; label?: string }) {
  const router = useRouter(); const [busy, setBusy] = useState(false), [note, setNote] = useState("");
  const act = async (action: string) => {
    setBusy(true); setNote("");
    try { const r = await post<{ count: number; skipped?: number }>("people/work/group", { group, action, ...(personId ? { personId } : {}) }); setNote(`${r.count} ${action === "accept" ? "accepted" : "dismissed"}${r.skipped ? `, ${r.skipped} left for one-by-one review` : ""}`); router.refresh(); }
    catch (e) { setNote(e instanceof Error ? e.message : "Could not save"); } finally { setBusy(false); }
  };
  return <span className={styles.inline}>
    <button type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={busy} onClick={() => act("accept")}>{label} {count.toLocaleString("en-IN")}</button>
    <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} disabled={busy} onClick={() => act("dismiss")}>Dismiss all</button>
    {note ? <span role="status" className={styles.muted}>{note}</span> : null}
  </span>;
}
