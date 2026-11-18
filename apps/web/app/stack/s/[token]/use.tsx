"use client";
// PULSE-HQ: "Use this stack": copies a shared stack into this organisation's Stack Intelligence (its tools that are not
// there yet are added, by name), then opens it.
import { useRouter } from "next/navigation";
import { useState } from "react";
import { CopyPlus } from "lucide-react";
import hq from "../../../hq/hq.module.css";
import { stackPost } from "../../workbench";

export function UseStack({ token, name }: { token: string; name: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return <span className={hq.headActions}>
    <button type="button" className={hq.primary} disabled={busy} onClick={async () => {
      setBusy(true); setError(null);
      try { const r = await stackPost<{ id: string }>(`shared/${token}/use`, { name }); router.push(`/stack?stack=${r.id}`); }
      catch (e) { setError(e instanceof Error ? e.message : "That did not work."); setBusy(false); }
    }}><CopyPlus size={16} aria-hidden="true" />{busy ? "Adding…" : "Use this stack"}</button>
    {error ? <span role="alert" className={hq.faint}>{error}</span> : null}
  </span>;
}
