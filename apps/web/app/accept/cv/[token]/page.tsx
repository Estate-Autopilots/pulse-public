import { headers } from "next/headers";
import { hostHeader } from "../../../lib/host-mode.mjs";
import { ResumeDoc, type ResumeData } from "../../../orgs/resume/doc";
import css from "../../../orgs/resume/resume.module.css";

// PROFILE-UNIFY (1683): a person's resume, signed out, through the link they made (Pulse keeps only its hash; turning
// it off or making a new one ends this one). Only the sections they saved; never pay, contracts or a company's records.
const API = process.env.PULSE_API_URL ?? "http://127.0.0.1:8081";

async function read(token: string): Promise<ResumeData | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  try {
    const r = await fetch(`${API}/api/v0/share/resume/${token}`, { cache: "no-store", headers: hostHeader(await headers()), signal: AbortSignal.timeout(10000) });
    return r.ok ? (await r.json()) as ResumeData : null;
  } catch { return null; }
}

export default async function PublicResume({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const r = await read(token);
  return <main className={css.public}>{r ? <ResumeDoc r={r} /> : <div className={css.doc}><h1>This link is not valid</h1><p>It may have been turned off or replaced. Ask the person for their current link.</p></div>}</main>;
}
