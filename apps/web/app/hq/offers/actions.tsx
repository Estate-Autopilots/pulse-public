"use client";
// PULSE-HQ: Offer Studio's buttons that write: a new offer (opens it in the studio) and a copy of one.
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Copy, Plus } from "lucide-react";
import { hqPost } from "../client";
import css from "../hq.module.css";

export function NewOffer({ label = "New offer" }: { label?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return <button type="button" className={css.primary} data-hq-new="" title="New offer (n)" disabled={busy} onClick={async () => {
    setBusy(true);
    try { const r = await hqPost<{ id: string }>("offers", { name: "Untitled offer", draft: true }); router.push(`/hq/offers/${r.id}`); }
    catch (e) { window.alert(e instanceof Error ? e.message : "Not created"); setBusy(false); }
  }}><Plus size={16} aria-hidden="true" />{label}</button>;
}

export function DuplicateOffer({ id }: { id: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return <button type="button" className={css.ghost} disabled={busy} onClick={async () => {
    setBusy(true);
    try { const r = await hqPost<{ id: string }>(`offers/${id}/duplicate`); router.push(`/hq/offers/${r.id}`); }
    catch (e) { window.alert(e instanceof Error ? e.message : "Not copied"); setBusy(false); }
  }}><Copy size={15} aria-hidden="true" />Duplicate</button>;
}
