"use client";
// CLIENT-PORTAL: an issued quotation, proforma or invoice goes into the client's own Pulse space, where they accept, ask
// for changes or decline (a quotation) and download it. Shown only when the client is on Pulse.
import { CheckCircle2, Send, Undo2 } from "lucide-react";
import { useEffect, useState } from "react";
import { notify } from "@pulse/ui-shell";
import css from "./documents.module.css";

type Share = { shared: boolean; sharedAt: string | null; seenAt: string | null; decision: string | null; decidedAt: string | null; decidedName: string | null; decisionNote: string | null; clientOnPulse: boolean } | null;
const day = (s: string | null) => s ? new Date(s).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }) : "";
const DECISION: Record<string, string> = { accepted: "Accepted", changes: "Asked for changes", declined: "Declined" };

export function PortalShare({ id, issued, canWrite }: { id: string; issued: boolean; canWrite: boolean }) {
  const [s, setS] = useState<Share>(null); const [busy, setBusy] = useState(false);
  useEffect(() => { void fetch(`/api/v0/erp/documents/${id}/share`, { cache: "no-store" }).then((r) => r.ok ? r.json() : null).then((d) => setS(d?.share ?? null)).catch(() => setS(null)); }, [id]);
  if (!s || !issued || (!s.clientOnPulse && !s.shared)) return null;
  const act = async (withdraw: boolean) => { setBusy(true);
    try { const r = await fetch(`/api/v0/erp/documents/${id}/share`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(withdraw ? { withdraw: true } : {}) });
      const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d?.error ?? "That did not work"); setS(d.share);
      notify({ id: "portal-share", tone: "success", title: withdraw ? "Taken back from their space" : "Shared in the client's Pulse", message: withdraw ? "" : "They see it on their home and can answer there." });
    } catch (e) { notify({ id: "portal-share", tone: "error", title: "Not shared", message: e instanceof Error ? e.message : "" }); } finally { setBusy(false); } };
  return <div className={css.note} style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
    {s.shared ? <>
      <CheckCircle2 size={15} aria-hidden="true" />
      <span>In the client&apos;s Pulse since {day(s.sharedAt)}{s.seenAt ? ` · opened ${day(s.seenAt)}` : " · not opened yet"}{s.decision ? ` · ${DECISION[s.decision] ?? s.decision}${s.decidedName ? ` by ${s.decidedName}` : ""} ${day(s.decidedAt)}` : ""}</span>
      {s.decisionNote ? <q style={{ flexBasis: "100%" }}>{s.decisionNote}</q> : null}
      {canWrite && !s.decision ? <button type="button" onClick={() => act(true)} disabled={busy} style={{ display: "inline-flex", gap: 4, alignItems: "center", border: 0, background: "none", color: "inherit", cursor: "pointer", textDecoration: "underline" }}><Undo2 size={13} aria-hidden="true" />Take back</button> : null}
    </> : canWrite ? <>
      <span>The client is on Pulse.</span>
      <button type="button" onClick={() => act(false)} disabled={busy} style={{ display: "inline-flex", gap: 6, alignItems: "center", minHeight: 34, padding: "0 12px", borderRadius: 10, border: 0, background: "var(--lx-teal)", color: "var(--lx-on-teal, #fff)", fontWeight: 620, cursor: "pointer" }}>
        <Send size={14} aria-hidden="true" />{busy ? "Sharing…" : "Share in their Pulse"}</button>
    </> : null}
  </div>;
}
