import { headers } from "next/headers";
import { hostHeader } from "../../lib/host-mode.mjs";
import { OfferAnswer } from "./answer";
import css from "../../erp/erp.module.css";

// COMP-A: a person's offer through its link, signed out. The link is the only key: Pulse keeps a hash of it, it lasts
// until the offer's date, and it shows one offer. A founder shares it; Pulse e-mails nobody.
type Seen = { name: string; role: string; startOn: string; validUntil: string; probationDays: number; company: string; status: string; decision: string | null; decidedAt: string | null;
  signer: string | null; canDecide: boolean };
const API = process.env.PULSE_API_URL ?? "http://127.0.0.1:8081";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = (d: string | null) => (d ? `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}` : "");

async function read(token: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  try {
    const host = hostHeader(await headers());
    const r = await fetch(`${API}/api/v0/offer/${token}`, { cache: "no-store", headers: host, signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    const seen = (await r.json()) as Seen;
    const pdf = await fetch(`${API}/api/v0/offer/${token}/pdf`, { cache: "no-store", headers: host, signal: AbortSignal.timeout(15000) });
    return { seen, pdf: pdf.ok ? Buffer.from(await pdf.arrayBuffer()).toString("base64") : null };
  } catch { return null; }
}

export default async function Offer({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const r = await read(token);
  if (!r) return <div className={css.accept}><div className={css.acceptHead}><h1>This link is not valid</h1><p>It may have expired, been withdrawn or already been answered. Ask the person who sent it.</p></div></div>;
  const s = r.seen;
  return <div className={css.accept}>
    <div className={css.acceptHead}>
      <h1>{s.company}: your offer</h1>
      <p>{s.name} · {s.role} · starting {day(s.startOn)}{s.probationDays ? ` · ${s.probationDays} days' probation` : ""} · open until {day(s.validUntil)}</p>
    </div>
    {s.decision ? <div className={css.acceptBox}><strong>{s.decision === "accepted" ? "Accepted" : "Declined"} by {s.signer} on {day(s.decidedAt?.slice(0, 10) ?? null)}.</strong></div> : null}
    {!s.decision && !s.canDecide ? <div className={css.acceptBox}><strong>This offer can no longer be answered.</strong></div> : null}
    <OfferAnswer token={token} pdf={r.pdf} canDecide={s.canDecide && !s.decision} company={s.company} />
  </div>;
}
