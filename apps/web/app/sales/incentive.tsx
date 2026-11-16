"use client";

// KAZUK-V2 G13 (R44, R60): the Sales Head, leadership or Finance marks a paid deal's incentive released, or takes it
// back. A small secondary button on the deal row (the page's one primary action stays "New quotation"); the kit's
// confirm dialog asks first (no browser dialogs), a toast says what happened. POST /api/v0/sales-incentive/:id.
import { useRouter } from "next/navigation";
import { useState } from "react";
import { notify } from "@pulse/ui-shell";
import { confirmDialog } from "../kit/dialogs";
import { post } from "../records";
import { styles } from "../ui";

export function ReleaseIncentive({ id, released, name }: { id: string; released: boolean; name: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const act = async () => {
    const ok = await confirmDialog({ title: released ? "Mark the incentive pending again?" : "Mark the incentive released?",
      body: released ? `${name} goes back to Pending.` : `The salesperson sees "Released" on ${name}.`, confirmLabel: released ? "Mark pending" : "Mark released" });
    if (!ok) return;
    setBusy(true);
    try {
      await post(`sales-incentive/${id}`, { released: !released });
      notify({ id: "incentive", tone: "success", title: released ? "Incentive is pending again" : "Incentive released 🎉", timeout: 2500 });
      router.refresh();
    } catch (e) {
      notify({ id: "incentive", tone: "error", title: "Not saved", message: e instanceof Error ? e.message : "Could not save" });
    } finally { setBusy(false); }
  };
  return <button type="button" className={`${styles.btn} ${styles.btnGhost} ${styles.btnSmall}`} onClick={() => void act()} disabled={busy}>
    {released ? "Mark pending" : "Mark released"}</button>;
}
