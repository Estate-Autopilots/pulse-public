"use client";
// NAV-CONNECT (owner, 17 Nov 2026: "Sales X-Ray was to be connected and it isn't. When I connect from Estate Autopilots it
// opens salesxray.atlascrest.in, and there it opens Vitals Technology instead"). Connecting an app the way good
// app stores do it (Slack, Zapier, Notion, Google Workspace): one button opens a short sheet that names the company the
// app is being connected to (and lets someone in several companies switch first), says in plain words what the app may
// do, then Sales X-Ray's own sign-in and consent; back in Pulse, a clear result: connected (with what to do next), or
// "Is this the right company?" when Sales X-Ray gave another one. Pulse never quietly takes another organisation.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ArrowRight, Building2, CheckCircle2, CircleHelp, FileAudio, Link2, ListChecks, PencilLine, PhoneCall, PlugZap, ShieldCheck, Unlink, UserRound } from "lucide-react";
import { Drawer, DrawerFooter, DrawerSection } from "../../kit";
import type { ReactNode } from "react";
import { Celebrate } from "../../kit/celebrate";
import { styles } from "../../ui";
import css from "./sales-xray.module.css";

export type ConnectCompany = { name: string; handle: string | null };
/** The person's other companies (staff seats), each opened in this tab by its /at link before connecting there. */
export type OtherCompany = { id: string; name: string };

async function post<T>(path: string): Promise<T> {
  const r = await fetch(`/api/v0/sales-xray/${path}`, { method: "POST", cache: "no-store", headers: { "content-type": "application/json" }, body: "{}" });
  const body = await r.json().catch(() => null);
  if (!r.ok) throw new Error(typeof body?.error === "string" && body.error !== "Not Found" ? body.error : "Pulse couldn’t reach Sales X-Ray just now. Try again in a minute.");
  return body as T;
}
/** Starts Sales X-Ray's consent for this company: the API answers the address (with the company's name as a hint). */
const startConnect = async () => { const { url } = await post<{ url: string }>("connect"); window.location.assign(url); };

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";
function CompanyTile({ company, note }: { company: ConnectCompany; note?: string }) {
  return <div className={css.companyCard}>
    <span className={css.companyTile} aria-hidden="true">{initials(company.name)}</span>
    <span className={css.companyText}><b>{company.name}</b><small>{note ?? (company.handle ? `@${company.handle} in Pulse` : "In Pulse")}</small></span>
  </div>;
}

/** The company in Pulse and the organisation in Sales X-Ray side by side, joined by a link mark (connected) or a
 *  "does not match" mark (held). */
export function Bridge({ company, workspace, personal, match, role, tag }: { company: string; workspace: string | null; personal: boolean; match: boolean; role?: ReactNode; /** A small tag on the Pulse side ("Recommended"). */ tag?: string }) {
  const other = personal ? "Personal" : workspace ?? "?";
  return <div className={css.bridge} data-match={match ? "" : undefined} aria-label={`${company} in Pulse ${match ? "is connected to" : "does not match"} ${other} in Sales X-Ray`}>
    <span data-ours={tag ? "" : undefined}><Building2 size={15} aria-hidden="true" /><span className={css.bridgeName}>{company}{tag ? <em className={css.tag}>{tag}</em> : null}</span><small>In Pulse</small></span>
    <i aria-hidden="true">{match ? <Link2 size={15} /> : <Unlink size={15} />}<em>{match ? "Connected" : "Different"}</em></i>
    <span data-wrong={match ? undefined : ""}>{personal ? <UserRound size={15} aria-hidden="true" /> : <Building2 size={15} aria-hidden="true" />}{other}<small>In Sales X-Ray{role ? <> · {role}</> : null}</small></span>
  </div>;
}

const MAY = [
  { Icon: PhoneCall, text: "See your sales calls and their reports" },
  { Icon: ListChecks, text: "See your leads and their stage" },
  { Icon: PencilLine, text: "Add a client as a lead, and update its company or city" },
  { Icon: FileAudio, text: "Send a call recording, which you check before it is used" },
];

/** The Connect button and its sheet. `autoOpen`: the sheet opens by itself (back from switching company for it). */
export function ConnectSheet({ company, others = [], label = "Connect Sales X-Ray", ghost = false, autoOpen = false }: { company: ConnectCompany; others?: readonly OtherCompany[]; label?: string; ghost?: boolean; autoOpen?: boolean }) {
  const [open, setOpen] = useState(autoOpen), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!autoOpen) return;
    // The address said "connect" (back from opening another company for it); it says it once: a reload does not open
    // the sheet again.
    const u = new URL(window.location.href); u.searchParams.delete("connect"); window.history.replaceState(null, "", u.pathname + u.search);
  }, [autoOpen]);
  const go = () => { setBusy(true); setError(null); startConnect().catch((e: Error) => { setBusy(false); setError(e.message); }); };
  const next = encodeURIComponent("/apps/sales-xray?connect=1");
  return <>
    <button type="button" className={`${styles.btn} ${ghost ? styles.btnGhost : styles.btnPrimary}`} onClick={() => setOpen(true)} data-connect-open="">
      <PlugZap size={16} aria-hidden="true" />{label}</button>
    {open ? <Drawer title="Connect Sales X-Ray" icon={<PlugZap size={18} aria-hidden="true" />} size="sm" onClose={() => { if (!busy) setOpen(false); }}
      footer={<DrawerFooter status={error} primary={<button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={go} disabled={busy} data-connect-go="">
        {busy ? "Opening…" : "Continue"}{busy ? null : <ArrowRight size={16} aria-hidden="true" />}</button>}>
        <button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={() => setOpen(false)} disabled={busy}>Cancel</button></DrawerFooter>}>
      <DrawerSection>
        <h3 className={css.sheetLabel}>Connecting to this company</h3>
        <CompanyTile company={company} />
        <p className={css.trust}><ShieldCheck size={15} aria-hidden="true" />Sales X-Ray will ask which company: pick this one. Pulse never sees your password.</p>
        <h3 className={`${css.sheetLabel} ${css.wideOnly}`}>What happens next</h3>
        <ol className={`${css.steps} ${css.wideOnly}`}>
          <li><span aria-hidden="true">1</span><p>Sales X-Ray opens. Sign in.</p></li>
          <li><span aria-hidden="true">2</span><p>Pick <b>{company.name}</b> and press Allow.</p></li>
          <li><span aria-hidden="true">3</span><p>You come back here. Pulse checks it is the right company.</p></li>
        </ol>
        {others.length ? <div className={css.switchRow}>
          <small>Not this company? Open another one first:</small>
          <div className={css.switchList}>{others.map((o) => <Link key={o.id} className={css.switchChip} href={`/at/${o.id}?next=${next}`} prefetch={false}><Building2 size={14} aria-hidden="true" />{o.name}</Link>)}</div>
        </div> : null}
        <h3 className={css.sheetLabel}>Pulse will be able to</h3>
        <ul className={css.mayList}>{MAY.map(({ Icon, text }) => <li key={text}><Icon size={15} aria-hidden="true" />{text}</li>)}</ul>
      </DrawerSection>
    </Drawer> : null}
  </>;
}

/** "Is this the right company?": Sales X-Ray gave a workspace that is not named like this company (or a Personal
 *  one). Nothing reads through it until the person decides. Pick another = end it at Sales X-Ray and connect again. */
export function CheckPanel({ company, workspace, personal, onDone, centered = false }: { company: string; workspace: string | null; personal: boolean; onDone?: (connected: boolean) => void; centered?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<"another" | "keep" | null>(null), [error, setError] = useState<string | null>(null);
  const picked = personal ? "your Personal workspace" : workspace || "a company with no name";
  const pickedOwn = personal ? "your Personal workspace’s" : `${workspace || "that company"}${/s$/i.test(workspace ?? "") ? "’" : "’s"}`;
  const another = () => { setBusy("another"); setError(null); post("disconnect").then(startConnect).catch((e: Error) => { setBusy(null); setError(e.message); }); };
  // A decision: the floating assistant steps aside while it shows (it sat on the second choice on a phone).
  useEffect(() => {
    const floats = [...document.querySelectorAll<HTMLElement>("[data-island]")].map((el) => [el, el.style.visibility] as const);
    for (const [el] of floats) el.style.visibility = "hidden";
    return () => { for (const [el, was] of floats) el.style.visibility = was; };
  }, []);
  const keep = () => {
    setBusy("keep"); setError(null);
    post("confirm").then(() => { setBusy(null); if (onDone) onDone(true); else router.refresh(); }, (e: Error) => { setBusy(null); setError(e.message); });
  };
  return <section className={css.checkCard} aria-labelledby="sx-check" data-sx-check="" data-centered={centered ? "" : undefined}>
    <span className={css.checkMark} aria-hidden="true"><CircleHelp size={22} /></span>
    <div className={css.checkText}>
      <small className={css.eyebrow}>Back from Sales X-Ray</small>
      <h2 id="sx-check">Is this the right company?</h2>
      <p className={css.wideOnly}>On Sales X-Ray you picked <b>{picked}</b>. You started in <b>{company}</b>.</p>
      <p className={css.phoneOnly}>On Sales X-Ray you picked <b>{picked}</b>.</p>
      <p className={css.safe}>Nothing is connected yet.</p>
      <Bridge company={company} workspace={workspace} personal={personal} match={false} tag="Recommended" />
      <div className={css.checkActions}>
        <div className={css.choice}>
          <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={another} disabled={!!busy} data-check-another="">{busy === "another" ? "Opening Sales X-Ray…" : `Go back and pick ${company}`}</button>
          <small>Sales X-Ray opens again, so you can pick {company}.</small>
        </div>
        <div className={css.choice}>
          <button type="button" className={`${styles.btn} ${styles.btnSecondary}`} onClick={keep} disabled={!!busy} data-check-keep="">{busy === "keep" ? "Saving…" : `Use ${personal ? "Personal" : workspace ?? "it"}`}</button>
          <small>You will see {pickedOwn} calls and leads here.</small>
        </div>
      </div>
      {error ? <p className={css.error} role="alert">{error}</p> : null}
    </div>
  </section>;
}

/** A finished connection: which company it is for and which Sales X-Ray organisation, a small celebration, and the one
 *  next step. */
export function Connected({ company, workspace, personal }: { company: string; workspace: string | null; personal: boolean }) {
  return <section className={css.success} aria-labelledby="sx-done" data-sx-connected="">
    <Celebrate when id={`sales-xray-connected:${company}:${workspace ?? "personal"}`} />
    <span className={css.successMark} aria-hidden="true"><CheckCircle2 size={28} /></span>
    <h2 id="sx-done">Sales X-Ray is connected</h2>
    <Bridge company={company} workspace={workspace} personal={personal} match />
    <p>Your calls and leads now show in Pulse. Ask Pulse about them any time.</p>
    <Link className={`${styles.btn} ${styles.btnPrimary}`} href="/apps/sales-xray">See your calls<ArrowRight size={16} aria-hidden="true" /></Link>
    {personal ? null : <Link className={css.quietLink} href="/apps/sales-xray?tab=sync">Bring your leads into Pulse</Link>}
  </section>;
}
