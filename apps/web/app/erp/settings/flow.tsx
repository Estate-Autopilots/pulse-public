"use client";
// KAZUK-FLOW config (owner, 7 Nov 2026: "nothing is hard-coded"): the company's sales flow. A preset (EA: no approval,
// the salesperson prices; Willow Lane: a manager or the owner approves, the owner approves a changed price) or the
// company's own steps. Each step says whether it is on, who does it, and, when it stops someone, why and who unlocks it.
// Leadership or an admin changes it; the database enforces it (1671) and logs every change.
import { Route } from "lucide-react";
import { useState } from "react";
import { notify } from "@pulse/ui-shell";
import { styles } from "../../ui";
import s from "./settings.module.css";
import { Card, SectionHeader } from "../../components/calm";

export type FlowStep = { on?: boolean; roles?: string[]; locked?: boolean; lockedFor?: string[]; why?: string; unlock?: string[];
  block?: { step: string; why: string; unlock: string[]; unlockBy: string[] } | null };
export type SalesFlow = { preset: "ea" | "wl" | "custom" | null; updatedAt: string | null; steps: Record<string, FlowStep>; canSet: boolean; approvalMode?: "none" | "approver" };

const STEPS: [string, string][] = [["quote", "Quotation"], ["send", "Send"], ["approve", "Approval"], ["price", "Price away from the catalogue"], ["version", "New version"],
  ["accept", "Accepted"], ["lost", "Lost"], ["proforma", "Proforma"], ["invoice", "Tax invoice"], ["payment", "Payment received"], ["handover", "Handover to the project"]];
const ROLE: Record<string, string> = { leadership: "leadership", admin: "admins", finance: "Finance", sales: "salespeople", sales_head: "sales heads", manager: "managers" };
const roles = (r?: string[]) => (r?.length ? r.map((x) => ROLE[x] ?? x).join(", ") : "everyone in Billing");
const PRESETS = [{ key: "ea", title: "No approval: the salesperson prices", sub: "Quotations go out when the salesperson sends them; an invoice is made from the accepted quotation; cost for the owner only" },
  { key: "wl", title: "Approval: a manager or the owner approves", sub: "Quotations wait for approval; a changed price on an AI-drafted quotation waits for the owner; cost for everyone in Billing" }] as const;

export function SalesFlowSettings({ initial }: { initial: SalesFlow }) {
  const [flow, setFlow] = useState(initial), [busy, setBusy] = useState(false);
  async function save(body: Record<string, unknown>, what: string) {
    setBusy(true);
    try {
      const r = await fetch("/api/v0/erp/flow", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d?.error ?? "Not saved");
      const next = await fetch("/api/v0/erp/flow", { cache: "no-store" }).then((x) => x.json());
      setFlow(next); notify({ id: "erp-flow", tone: "success", title: what, timeout: 3000 });
    } catch (e) { notify({ id: "erp-flow", tone: "error", title: "Not saved", message: e instanceof Error ? e.message : "Not saved" }); } finally { setBusy(false); }
  }
  return <Card id="sales-flow" label="Sales flow" className={s.card}>
    <SectionHeader id="sales-flow-h" icon={<Route size={16} aria-hidden="true" />} title="Sales flow"
      hint={flow.preset === "ea" ? "No approval" : flow.preset === "wl" ? "Approval" : flow.preset === "custom" ? "Your own steps" : "As Pulse came"} />
    <div className={s.toggles} role="radiogroup" aria-label="Sales flow preset">
      {PRESETS.map((p) => <label key={p.key} className={s.toggle}>
        <input type="radio" name="erp-flow-preset" checked={flow.preset === p.key} disabled={busy || !flow.canSet} onChange={() => void save({ preset: p.key }, `Sales flow: ${p.title}`)} />
        <span className={s.toggleText}>{p.title}<small>{p.sub}</small></span></label>)}
    </div>
    <ul className={s.list} style={{ listStyle: "none", paddingLeft: 0 }} aria-label="Steps">
      {STEPS.map(([k, label]) => { const st = flow.steps[k] ?? {}; const on = st.on !== false; return <li key={k}>
        <label className={s.toggle}>
          <input type="checkbox" className={s.switch} checked={on} disabled={busy || !flow.canSet} aria-label={`${label}: ${on ? "on" : "off"}`}
            onChange={(e) => void save({ steps: { [k]: { on: e.target.checked } } }, `${label} ${e.target.checked ? "on" : "off"}`)} />
          <span className={s.toggleText}>{label}<small>{!on ? "Off: never stops anyone" : [`Done by ${roles(st.roles)}`, st.locked && st.why ? `${st.why}${st.lockedFor?.length ? ` (for ${roles(st.lockedFor)})` : ""}` : null,
            st.locked && st.unlock?.length ? `unlocked by ${roles(st.unlock)}` : null].filter(Boolean).join(" · ")}{st.block ? ` · For you: ${st.block.why}${st.block.unlockBy.length ? `; ask ${st.block.unlockBy.join(", ")}` : ""}` : ""}</small></span>
        </label></li>; })}
    </ul>
    <p className={s.quiet}>{flow.canSet ? "Leadership or an admin changes the flow; every change is kept in Billing's log." : "Leadership or an admin changes the flow."}</p>
  </Card>;
}
