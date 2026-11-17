"use client";
// BHARATA-CORE (7 Nov 2026): a quotation in a chat message shows what it is, right there: the client, the lines, the total
// and where it stands (draft, waiting for approval, approved with its number), with its PDF (the draft's preview until it
// is approved, then the filed copy). It is read from Billing with the viewer's own rights and refreshed while it is new,
// so the person watches it change as the AI employee works and as it is approved; the quotation open beside the chat
// reloads with it. When an AI employee's reply with a quotation arrives while the chat is open, the quotation opens beside
// the chat at once (the person asked for it; once per quotation per page). One card per quotation: later messages naming
// the same quotation keep their link only.
import { useEffect, useRef, useState } from "react";
import { FileDown, FileText } from "lucide-react";
import { openInPanel } from "./workspace/tabs";
import { reloadPanelPath } from "./workspace/panel";
import { inr } from "../erp/documents/chain";
import css from "./chats.module.css";

const DOC = /\/erp\/documents\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?![0-9a-f-])/i;
/** The billing document a message names (a link to /erp/documents/<id> on any of the company's addresses), or null. */
export const quoteDocId = (body: string | null | undefined): string | null => DOC.exec(String(body ?? ""))?.[1]?.toLowerCase() ?? null;

const pageAt = typeof window === "undefined" ? 0 : Date.now();
const opened = new Set<string>();
const firstMessage = new Map<string, string>();
/** How long a new quotation is watched (the AI employee works, a person approves), and how often. */
const WATCH_MS = 15 * 60000, EVERY_MS = 5000;
type Doc = {
  document: { docType: string; status: string; number: string | null; total: number; updatedAt?: string; buyer?: { name?: string } | null; approvalToName?: string | null };
  lines: { id: string; description: string; qty: number; total: number }[]; file?: { createdAt: string } | null;
};

export const quoteState = (d: Pick<Doc["document"], "status" | "approvalToName">) => d.status === "draft" ? (d.approvalToName ? `Waiting for ${d.approvalToName} to approve` : "Draft, not sent")
  : d.status === "issued" ? "Approved" : d.status === "sent" ? "Sent to the client" : d.status === "accepted" ? "Accepted by the client" : d.status === "declined" ? "Declined" : d.status;

export function QuoteCard({ id, messageId, byAgent, at }: { id: string; messageId: string; byAgent: boolean; at: string }) {
  if (!firstMessage.has(id)) firstMessage.set(id, messageId);
  const first = firstMessage.get(id) === messageId;
  const fresh = Date.parse(at) >= pageAt - 5000;
  const [d, setD] = useState<Doc | null>(null);
  const seen = useRef<string | null>(null);
  const path = `/erp/documents/${id}`;
  useEffect(() => {
    if (!first) return;
    let on = true, timer: ReturnType<typeof setTimeout> | undefined;
    const until = Date.now() + WATCH_MS;
    const load = () => {
      void fetch(`/api/v0/erp/documents/${id}`, { cache: "no-store" }).then((r) => (r.ok ? (r.json() as Promise<Doc>) : null)).then((x) => {
        if (!on || !x?.document) return;
        // What changed since the last look (a line, the total, the approval) shows in the open quotation too.
        const mark = `${x.document.updatedAt ?? ""}|${x.document.status}|${x.document.total}|${x.lines?.length ?? 0}`;
        if (seen.current !== null && seen.current !== mark) reloadPanelPath(path);
        seen.current = mark; setD(x);
      }).catch(() => {}).finally(() => { if (on && fresh && Date.now() < until) timer = setTimeout(load, EVERY_MS); });
    };
    load();
    return () => { on = false; if (timer) clearTimeout(timer); };
  }, [id, path, first, fresh]);
  useEffect(() => {
    if (!first || !byAgent || !fresh || opened.has(id)) return;
    opened.add(id);
    openInPanel({ href: path, title: "Quotation", auto: true, reason: "The quotation you asked for" });
  }, [id, path, first, byAgent, fresh]);
  if (!first || !d) return null;
  const doc = d.document, lines = d.lines ?? [], approved = doc.status !== "draft";
  return <>
    <a className={css.linkCard} href={path} data-quote-card="" data-status={doc.status}
      onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey) return; if (openInPanel({ href: path, title: doc.number ?? "Quotation" })) e.preventDefault(); }}>
      <b><FileText size={13} aria-hidden="true" /> {doc.docType === "quotation" ? "Quotation" : "Document"} {doc.number ?? "(draft)"} · {doc.buyer?.name ?? "No client yet"}</b>
      <span>{lines.slice(0, 5).map((l) => `${l.description}${l.qty !== 1 ? ` × ${l.qty}` : ""}: ${inr(l.total)}`).join(" · ")}{lines.length > 5 ? ` · and ${lines.length - 5} more` : ""}</span>
      <small>Total {inr(doc.total)} incl. GST · {quoteState(doc)}</small>
    </a>
    <a className={css.file} href={`/api/v0/erp/documents/${id}/pdf`} target="_blank" rel="noreferrer" data-quote-pdf="">
      <FileDown size={18} aria-hidden="true" /><span>{doc.number ?? "Quotation"} PDF<small>{approved && d.file ? "The approved copy" : "Draft preview"}</small></span>
    </a>
  </>;
}
