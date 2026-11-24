import { headers } from "next/headers";
import { hostHeader } from "../../../lib/host-mode.mjs";
import { SignClient, type Seen } from "./sign-client";
import css from "../../../contracts/sign.module.css";

export const dynamic = "force-dynamic";
const clock = () => Date.now();

// CONTRACTS-2 (owner, 8 Nov 2026): what a client sees through a signing link, signed out, on their phone. The link is
// the only key: Vitals OS keeps a hash of it, it expires, and it shows one agreement. The client reads it clause by
// clause, asks for a change on any clause, signs by typing their name or drawing, or says no.
const API = process.env.PULSE_API_URL ?? "http://127.0.0.1:8081";

async function read(token: string): Promise<Seen | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  try {
    const h = await headers();
    const r = await fetch(`${API}/api/v0/accept/sign/${token}`, { cache: "no-store", signal: AbortSignal.timeout(10000),
      headers: { ...hostHeader(h), "x-pulse-client-ip": h.get("cf-connecting-ip") ?? "unattributed-web", "user-agent": (h.get("user-agent") ?? "").slice(0, 300) } });
    return r.ok ? (await r.json()) as Seen : null;
  } catch { return null; }
}

export default async function SignPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const seen = await read(token);
  if (!seen) return <div className={css.page}><div className={css.banner}><strong>This link does not work</strong>
    <span>It may be old, or it was replaced by a newer one. Ask the person who sent it for a new link.</span></div></div>;
  if (seen.expired) return <div className={css.page}><div className={css.banner}><strong>This link has expired</strong>
    <span>{`Ask ${seen.from ?? "the sender"} for a new link. It takes them one tap.`}</span></div></div>;
  return <SignClient token={token} seen={seen} now={clock()} />;
}
