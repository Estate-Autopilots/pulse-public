"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Copy, Plug, Printer, Unplug } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { post } from "../../records";
import { useConfirm } from "../../kit/dialogs";
import { Panel, styles } from "../../ui";
import css from "../../resume-drafts.module.css";

type Job = { id: string; documentId: string; title: string; copies: number; sides: string; pages: number; status: string; detail: string | null; by: string | null; viaAi: string | null; agentHost: string | null; createdAt: string; finishedAt: string | null };
type PrinterRow = { printer: string; model: string | null; state: string | null; warnings: string[]; ink: { name: string; percent: number | null }[]; pages: number | null; acceptsPdf: boolean | null; agentHost: string | null; lastSeen: string };
type Agent = { id: string; name: string; createdAt: string; by: string | null; lastSeenAt: string | null; lastHost: string | null; revokedAt: string | null };
export type PrintOverview = { canManage: boolean; jobs: Job[]; printers: PrinterRow[]; agents: Agent[]; today: number; limit: number };

const STATUS: Record<string, string> = { queued: "Waiting for the printer", claimed: "Picked up by the office computer", printing: "Printing", done: "Printed", failed: "Not printed", cancelled: "Cancelled" };
const when = (at: string | null) => (at ? new Date(at).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" }) : "");

/** OFFICE-PRINT: the queue and history (failed ones say why), the printers' paper and toner, and the agent tokens. */
export function PrintCentre({ data }: { data: PrintOverview }) {
  const router = useRouter();
  const [token, setToken] = useState<{ token: string; base: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const confirm = useConfirm();
  async function connect() {
    setBusy(true);
    try { setToken(await post<{ token: string; base: string; name: string }>("office-print/agents", { name: "Office print agent" })); router.refresh(); }
    catch (e) { notify({ id: "print-agent", tone: "error", title: "Not connected", message: e instanceof Error ? e.message : String(e) }); }
    finally { setBusy(false); }
  }
  async function revoke(a: Agent) {
    if (!(await confirm({ title: `Disconnect ${a.name}?`, body: "The office computer stops printing until a new one is connected.", confirmLabel: "Disconnect" }))) return;
    try { await post(`office-print/agents/${a.id}/revoke`); notify({ id: "print-agent", tone: "success", title: "Disconnected", timeout: 3000 }); router.refresh(); }
    catch (e) { notify({ id: "print-agent", tone: "error", title: "Not disconnected", message: e instanceof Error ? e.message : String(e) }); }
  }
  const live = data.agents.filter((a) => !a.revokedAt);
  return <>
    <Panel title="Printers" sub={data.printers.length ? "As the office computer last saw them" : "None seen yet"}>
      {data.printers.length ? <ul className={css.list} aria-label="Printers">{data.printers.map((p) => <li key={p.printer}><div className={css.row}>
        <Printer size={16} aria-hidden="true" />
        <span className={css.main}><b>{p.model ?? p.printer}</b><small>{[p.state ?? "", p.warnings.length ? p.warnings.join(", ") : "no warnings",
          p.ink.length ? `toner ${p.ink.map((i) => `${i.name} ${i.percent ?? "?"}%`).join(", ")}` : "", p.pages ? `${p.pages.toLocaleString("en-IN")} pages so far` : "",
          `seen ${when(p.lastSeen)}${p.agentHost ? ` by ${p.agentHost}` : ""}`].filter(Boolean).join(" · ")}</small></span>
        <span className={css.go}>{p.acceptsPdf === false ? "Needs a driver" : ""}</span></div></li>)}</ul>
        : <p style={{ padding: "4px 14px 12px", margin: 0 }}>Once the print agent runs on a computer on the office Wi-Fi, the printer shows here with its paper and toner.</p>}
    </Panel>
    <Panel title="Prints" sub={`${data.today} of ${data.limit} pages today`}>
      {data.jobs.length ? <ul className={css.list} aria-label="Prints">{data.jobs.map((j) => <li key={j.id}><Link href={`/erp/documents/${j.documentId}`} className={css.row}>
        <Printer size={16} aria-hidden="true" />
        <span className={css.main}><b>{j.title}</b><small>{[`${j.copies} ${j.copies === 1 ? "copy" : "copies"} · ${j.pages} ${j.pages === 1 ? "page" : "pages"}${j.sides !== "one-sided" ? " · both sides" : ""}`,
          `${j.by ?? ""}${j.viaAi ? ` via ${j.viaAi}` : ""}`, when(j.createdAt), j.status === "failed" && j.detail ? `why: ${j.detail}` : ""].filter(Boolean).join(" · ")}</small></span>
        <span className={css.go}>{STATUS[j.status] ?? j.status}</span></Link></li>)}</ul>
        : <p style={{ padding: "4px 14px 12px", margin: 0 }}>Nothing printed yet. Open a quotation, proforma or invoice and choose More → Print.</p>}
    </Panel>
    {data.canManage ? <Panel title="Office print agent" sub="The small program on a computer on the office Wi-Fi that prints for Vitals">
      {live.length ? <ul className={css.list} aria-label="Agents">{live.map((a) => <li key={a.id}><div className={css.row}>
        <Plug size={16} aria-hidden="true" />
        <span className={css.main}><b>{a.name}</b><small>{[`connected ${when(a.createdAt)}${a.by ? ` by ${a.by}` : ""}`, a.lastSeenAt ? `last call ${when(a.lastSeenAt)}${a.lastHost ? ` from ${a.lastHost}` : ""}` : "not called in yet"].join(" · ")}</small></span>
        <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} onClick={() => void revoke(a)}><Unplug size={13} aria-hidden="true" />Disconnect</button></div></li>)}</ul> : null}
      {token ? <div style={{ padding: "8px 14px 14px", display: "grid", gap: 8 }}>
        <p style={{ margin: 0 }}><b>Shown once.</b> Put this token in a file on the office computer (for example <code>~/.vitals-print-token</code>) and start the agent with:</p>
        <code style={{ overflowWrap: "anywhere" }}>VITALS_PRINT_API={token.base} VITALS_PRINT_TOKEN_FILE=~/.vitals-print-token python3 print_agent.py --printer auto --serve</code>
        <button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => { void navigator.clipboard.writeText(token.token).then(() => notify({ id: "print-token", tone: "success", title: "Token copied", timeout: 2500 })); }}>
          <Copy size={13} aria-hidden="true" />Copy the token</button>
      </div> : <div style={{ padding: "8px 14px 14px" }}><button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy} onClick={() => void connect()}><Plug size={15} aria-hidden="true" />{live.length ? "Connect another computer" : "Connect the office computer"}</button></div>}
    </Panel> : null}
  </>;
}
