import { DOC_LABELS, formatDate, formatInr, type DocType } from "@pulse/invoice-doc";
import { headers } from "next/headers";
import { AcceptAnswer } from "./answer";
import { hostHeader } from "../../lib/host-mode.mjs";
import css from "../../erp/erp.module.css";

// ERP-INVOICE: what a client sees through an acceptance link, signed out. The link is the only key: Pulse stores a hash
// of it, it expires, and it shows one document. Pulse never sends it; the company shares it with the client.
type Seen = { docType: DocType; number: string; issueDate: string; validUntil: string | null; dueDate: string | null; total: number; seller: string; buyer: string;
  decision: string | null; decidedAt: string | null; signer: string | null; expiresAt: string; canDecide: boolean; closed?: boolean };
const API = process.env.PULSE_API_URL ?? "http://127.0.0.1:8081";

async function read(token: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  try {
    const host = hostHeader(await headers());
    const r = await fetch(`${API}/api/v0/accept/${token}`, { cache: "no-store", headers: host, signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    const seen = (await r.json()) as Seen;
    const pdf = await fetch(`${API}/api/v0/accept/${token}/pdf`, { cache: "no-store", headers: host, signal: AbortSignal.timeout(10000) });
    return { seen, pdf: pdf.ok ? Buffer.from(await pdf.arrayBuffer()).toString("base64") : null };
  } catch { return null; }
}

export default async function Accept({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const r = await read(token);
  if (!r) return <div className={css.accept}><div className={css.acceptHead}><h1>This link is not valid</h1><p>It may have expired or been replaced. Ask the person who sent it for a new one.</p></div></div>;
  const s = r.seen, label = DOC_LABELS[s.docType] ?? DOC_LABELS.quotation;
  const title = `${label.title.toLowerCase()} ${s.number}`;
  return <div className={css.accept}>
    <div className={css.acceptHead}>
      <h1>{label.title} {s.number}</h1>
      <p>From {s.seller} to {s.buyer} · {formatDate(s.issueDate)} · {formatInr(s.total)}{s.validUntil ? ` · valid until ${formatDate(s.validUntil)}` : ""}</p>
    </div>
    {s.closed ? <div className={css.acceptBox}><strong>This document was cancelled.</strong></div> : null}
    {s.decision ? <div className={css.acceptBox}><strong>{s.decision === "accepted" ? "Accepted" : "Declined"} by {s.signer} on {formatDate(s.decidedAt)}.</strong></div> : null}
    <AcceptAnswer token={token} pdf={r.pdf} canDecide={s.canDecide && !s.decision} title={title} />
  </div>;
}
