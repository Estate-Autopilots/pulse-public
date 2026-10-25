"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Ban, Plus } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { post } from "../records";
import { styles } from "../ui";

const msg = (e: unknown) => e instanceof Error ? e.message : "That did not work. Try again.";

export function NewForm() {
  const router = useRouter(); const [busy, setBusy] = useState(false);
  return <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy} onClick={async () => {
    setBusy(true); try { const r = await post<{ id: string }>("forms", { name: "New form", fields: [{ label: "Photo of the work", type: "photo", required: true }] }); router.push(`/sops/forms/${r.id}`); }
    catch (e) { notify({ id: "form", tone: "error", title: "Not made", message: msg(e) }); setBusy(false); } }}><Plus size={14} aria-hidden="true" />New form</button>;
}

/** Add a template's forms (live at once) and, when it has one, its workflow (a draft to check and publish). */
export function InstallTemplate({ tkey, name, workflow }: { tkey: string; name: string; workflow: boolean }) {
  const router = useRouter(); const [busy, setBusy] = useState(false);
  return <button type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={busy} onClick={async () => {
    setBusy(true);
    try { const r = await post<{ formIds: string[]; workflowId: string | null }>(`forms/templates/${tkey}`, {});
      notify({ id: "tpl", tone: "success", title: `Added: ${name}`, message: workflow ? "Its workflow is a draft: check who does each step, then publish." : undefined, timeout: 5000 });
      router.push(r.workflowId ? `/sops/workflows/${r.workflowId}` : `/sops/forms/${r.formIds[0]}`); }
    catch (e) { notify({ id: "tpl", tone: "error", title: "Not added", message: msg(e) }); setBusy(false); } }}><Plus size={12} aria-hidden="true" />Add</button>;
}

export function VoidSubmission({ id }: { id: string }) {
  const router = useRouter(); const [open, setOpen] = useState(false), [reason, setReason] = useState(""), [busy, setBusy] = useState(false);
  if (!open) return <button type="button" className={styles.btn} onClick={() => setOpen(true)}><Ban size={14} aria-hidden="true" />Void</button>;
  return <span style={{ display: "flex", flexDirection: "column", gap: 6 }}><input aria-label="Why it is void" placeholder="Why it is void" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} style={{ padding: 8, borderRadius: 8, border: "1px solid var(--theme-border)" }} />
    <span style={{ display: "flex", gap: 6 }}><button type="button" className={`${styles.btn} ${styles.btnDanger}`} disabled={busy || !reason.trim()} onClick={async () => {
      setBusy(true); try { await post(`forms/submissions/${id}/void`, { reason }); router.refresh(); } catch (e) { notify({ id: "void", tone: "error", title: "Not voided", message: msg(e) }); } finally { setBusy(false); } }}>Void it</button>
      <button type="button" className={styles.btn} onClick={() => setOpen(false)}>Keep it</button></span></span>;
}
