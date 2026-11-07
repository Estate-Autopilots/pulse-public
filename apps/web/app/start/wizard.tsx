"use client";
import { ArrowLeft, ArrowRight, Briefcase, Check, Code2, LogIn, Megaphone, Sparkles, TrendingUp, Users } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { arrive, post, type Moved } from "../orgs/client";
import { NewPassword } from "../orgs/password-field";
import { CHOICES, DAYS, TEMPLATES, TIME_ZONES, handleOf, type ChoiceKey, type TemplateKey } from "./catalogue";
import css from "./start.module.css";
import { plainError } from "../lib/plain-error.mjs";
import { ReportProblemLink } from "../bug-report/report-link";

const ICON: Record<TemplateKey, ReactNode> = { sales: <TrendingUp size={22} aria-hidden="true" />, agency: <Briefcase size={22} aria-hidden="true" />,
  creator: <Megaphone size={22} aria-hidden="true" />, software: <Code2 size={22} aria-hidden="true" />, general: <Users size={22} aria-hidden="true" /> };
type Step = "you" | "company" | "work" | "modules" | "hours" | "verify";
type EmailState = { email: string | null; verified: boolean };

/** ONBOARD-SELF: "Start your company on Pulse". Signed out it begins with you (name, e-mail and a 6-digit code to it,
 *  a password); signed in, with the company. Then what you do, the modules, working days and hours, and the company
 *  starts: you are its owner, with starter projects; next comes inviting your team. */
export function StartWizard({ signedIn, you }: { signedIn: boolean; you: string }) {
  const [email, setEmail] = useState<EmailState | null>(signedIn ? null : { email: null, verified: false });
  const steps: Step[] = useMemo(() => signedIn ? ["company", "work", "modules", "hours", ...(email?.verified ? [] : ["verify" as Step])] : ["you", "company", "work", "modules", "hours"], [signedIn, email?.verified]);
  const [at, setAt] = useState(0);
  const step = steps[Math.min(at, steps.length - 1)];
  const [busy, setBusy] = useState(false); const [note, setNote] = useState<{ text: string; tone?: "error" | "ok" } | null>(null);
  // You (signed out).
  const [name, setName] = useState(""); const [addr, setAddr] = useState(""); const [code, setCode] = useState(""); const [sent, setSent] = useState(false);
  const [codeOk, setCodeOk] = useState(false); const [password, setPassword] = useState("");
  // The company.
  const [company, setCompany] = useState(""); const [handle, setHandle] = useState(""); const [touched, setTouched] = useState(false);
  const [templates, setTemplates] = useState<TemplateKey[]>([]); const [modules, setModules] = useState<ChoiceKey[] | null>(null);
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]); const [dayStart, setDayStart] = useState("09:30"); const [dayEnd, setDayEnd] = useState("18:30");
  const [tz, setTz] = useState("Asia/Kolkata");
  useEffect(() => { void Promise.resolve().then(() => { try { const z = Intl.DateTimeFormat().resolvedOptions().timeZone; if (z) setTz(z); } catch { /* keep the default */ } }); }, []);
  useEffect(() => {
    if (!signedIn) return;
    void fetch("/api/v0/account/verify-email", { cache: "no-store" }).then((r) => r.ok ? r.json() : null).then((d) => { setEmail(d ?? { email: null, verified: false }); if (d?.email) setAddr(d.email); }).catch(() => setEmail({ email: null, verified: false }));
  }, [signedIn]);
  const shownHandle = touched ? handle : handleOf(company);
  const picked = modules ?? [...new Set(templates.flatMap((t) => TEMPLATES.find((x) => x.key === t)?.modules ?? []))];
  const zones = TIME_ZONES.includes(tz) ? TIME_ZONES : [tz, ...TIME_ZONES];

  const go = (d: number) => { setNote(null); setAt((n) => Math.max(0, Math.min(steps.length - 1, n + d))); window.scrollTo({ top: 0 }); };
  const fail = (e: unknown) => setNote({ text: e instanceof Error && e.message ? plainError(e.message) : "That did not work. Try again.", tone: "error" });
  const run = async (f: () => Promise<void>) => { setBusy(true); setNote(null); try { await f(); } catch (e) { fail(e); } finally { setBusy(false); } };

  const sendCode = () => run(async () => {
    const r = signedIn ? await post<{ message: string; verified: boolean }>("account/verify-email", { email: addr })
      : await post<{ message: string }>("auth/signup", { step: "code", email: addr });
    if ("verified" in r && r.verified) { setEmail({ email: addr, verified: true }); return; }
    setSent(true); setNote({ text: r.message, tone: "ok" });
  });
  const checkCode = () => run(async () => {
    if (signedIn) { await post("account/verify-email/confirm", { code }); setEmail({ email: addr, verified: true }); setNote({ text: "Your e-mail is confirmed.", tone: "ok" }); }
    else { await post("auth/signup", { step: "check", email: addr, code }); setCodeOk(true); setNote({ text: "Your e-mail is confirmed.", tone: "ok" }); }
  });
  const answers = () => ({ name: company.trim(), handle: shownHandle, templates, modules: picked, workDays: days, dayStart, dayEnd, timeZone: tz });
  const create = () => run(async () => {
    const moved = signedIn ? await post<Moved>("account/start", answers())
      : await post<Moved>("auth/signup", { email: addr, code, name: name.trim(), password, company: answers() });
    arrive(moved, "/start/team");
  });

  const canNext = (() => {
    switch (step) {
      case "you": return name.trim().length >= 2 && codeOk && password.length >= 10;
      case "company": return company.trim().length >= 2 && /^[a-z0-9][a-z0-9._]{2,29}$/.test(shownHandle);
      case "work": return templates.length > 0;
      case "hours": return days.length > 0 && dayEnd > dayStart;
      default: return true;
    }
  })();
  const last = at >= steps.length - 1;
  const submit = (e: FormEvent) => { e.preventDefault(); if (!canNext || busy) return; if (last) void create(); else go(1); };

  if (signedIn && email === null) return <div className={css.wrap}><div className={css.card}><p className={css.muted} role="status">Getting ready…</p></div></div>;
  return <div className={css.wrap}><form className={css.card} onSubmit={submit} aria-labelledby="start-title">
    <p className={css.kicker}>Start your company on Pulse</p>
    <div className={css.progress} aria-hidden="true">{steps.map((s, i) => <span key={s} data-on={i <= at ? "" : undefined} />)}</div>
    <p className={css.stepNo}>Step {at + 1} of {steps.length}</p>

    {step === "you" ? <>
      <h1 id="start-title" className={css.title}>First, you</h1>
      <p className={css.lede}>One Pulse account works in every company you join. You’ll be the owner of the company you start.</p>
      <a className={`${css.btn}`} href="/login?next=/start"><LogIn size={17} aria-hidden="true" />I already have a Pulse account: sign in</a>
      <label className={css.field}>Your name<input className={css.input} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required minLength={2} maxLength={120} /></label>
      <label className={css.field}>Work e-mail<input className={css.input} type="email" value={addr} onChange={(e) => { setAddr(e.target.value); setSent(false); setCodeOk(false); }} autoComplete="email" inputMode="email" required maxLength={254} disabled={codeOk} /></label>
      {codeOk ? null : <button type="button" className={css.btn} onClick={() => void sendCode()} disabled={busy || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)}>{sent ? "Send a new code" : "Send me a 6-digit code"}</button>}
      {sent && !codeOk ? <div className={css.form}>
        <label className={css.field}>The code from the e-mail<input className={`${css.input} ${css.code}`} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" maxLength={6} /></label>
        <button type="button" className={`${css.btn} ${css.primary}`} onClick={() => void checkCode()} disabled={busy || code.length !== 6}>Confirm my e-mail</button>
      </div> : null}
      {codeOk ? <NewPassword value={password} onChange={setPassword} inputClass={css.input} fieldClass={css.field} /> : null}
    </> : null}

    {step === "company" ? <>
      <h1 id="start-title" className={css.title}>Your company</h1>
      <p className={css.lede}>Its name, and a short handle people use to find it on Pulse.</p>
      <label className={css.field}>Company name<input className={css.input} value={company} onChange={(e) => setCompany(e.target.value)} required minLength={2} maxLength={80} autoComplete="organization" placeholder={you ? `${you.split(" ")[0]}’s company` : "NeetiCRM"} autoFocus /></label>
      <label className={css.field}>Handle <small>3 to 30 lower-case letters, digits, dots or underscores</small>
        <span className={css.prefix}><span>@</span><input className={css.input} value={shownHandle} onChange={(e) => { setTouched(true); setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9._]/g, "")); }} minLength={3} maxLength={30} required autoCapitalize="none" spellCheck={false} /></span></label>
    </> : null}

    {step === "work" ? <>
      <h1 id="start-title" className={css.title}>What do you do?</h1>
      <p className={css.lede}>Pick one or more. Each starts a project with its first steps, and switches on what it needs.</p>
      <div className={css.choices} role="group" aria-labelledby="start-title">{TEMPLATES.map((t) => { const on = templates.includes(t.key); return (
        <button type="button" key={t.key} className={css.choice} aria-pressed={on} onClick={() => { setModules(null); setTemplates((x) => on ? x.filter((k) => k !== t.key) : [...x, t.key]); }}>
          {ICON[t.key]}<span><b>{t.name}</b><small>{t.note} Starts “{t.starter}”.</small></span><span className={css.tick}>{on ? <Check size={15} aria-hidden="true" /> : null}</span></button>); })}</div>
    </> : null}

    {step === "modules" ? <>
      <h1 id="start-title" className={css.title}>What to switch on</h1>
      <p className={css.lede}>Tasks and projects are always on. We picked these from what you do; change anything now or later in Settings.</p>
      <div className={css.choices}>{CHOICES.map((c) => { const on = picked.includes(c.key); return (
        <button type="button" role="switch" key={c.key} className={css.choice} aria-checked={on} onClick={() => setModules(on ? picked.filter((k) => k !== c.key) : [...picked, c.key])}>
          <Sparkles size={20} aria-hidden="true" /><span><b>{c.name}</b><small>{c.note}</small></span><span className={css.tick}>{on ? <Check size={15} aria-hidden="true" /> : null}</span></button>); })}</div>
    </> : null}

    {step === "hours" ? <>
      <h1 id="start-title" className={css.title}>When you work</h1>
      <p className={css.lede}>Due dates, reminders and “today” follow your company’s days and time zone.</p>
      <div className={css.field}>Working days<div className={css.days} role="group" aria-label="Working days">{DAYS.map(([label, d]) => (
        <button type="button" key={d} className={css.day} aria-pressed={days.includes(d)} onClick={() => setDays((x) => x.includes(d) ? x.filter((y) => y !== d) : [...x, d].sort())}>{label}</button>))}</div></div>
      <div className={css.two}>
        <label className={css.field}>Day starts<input className={css.input} type="time" value={dayStart} onChange={(e) => setDayStart(e.target.value)} required /></label>
        <label className={css.field}>Day ends<input className={css.input} type="time" value={dayEnd} onChange={(e) => setDayEnd(e.target.value)} required /></label>
      </div>
      <label className={css.field}>Time zone<select className={css.select} value={tz} onChange={(e) => setTz(e.target.value)}>{zones.map((z) => <option key={z} value={z}>{z.replace(/_/g, " ")}</option>)}</select></label>
    </> : null}

    {step === "verify" ? <>
      <h1 id="start-title" className={css.title}>Confirm your e-mail</h1>
      <p className={css.lede}>A new company needs an owner with a confirmed e-mail. We’ll send a 6-digit code.</p>
      <label className={css.field}>Your e-mail<input className={css.input} type="email" value={addr} onChange={(e) => { setAddr(e.target.value); setSent(false); }} inputMode="email" autoComplete="email" maxLength={254} /></label>
      <button type="button" className={css.btn} onClick={() => void sendCode()} disabled={busy || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)}>{sent ? "Send a new code" : "Send me a code"}</button>
      {sent ? <div className={css.form}>
        <label className={css.field}>The code from the e-mail<input className={`${css.input} ${css.code}`} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" maxLength={6} /></label>
        <button type="button" className={`${css.btn} ${css.primary}`} onClick={() => void checkCode()} disabled={busy || code.length !== 6}>Confirm my e-mail</button>
      </div> : null}
    </> : null}

    {note ? <p className={css.note} data-tone={note.tone} role={note.tone === "error" ? "alert" : "status"}>{note.text}</p> : null}
    <div className={css.actions}>
      {at > 0 ? <button type="button" className={`${css.btn} ${css.quiet}`} onClick={() => go(-1)} disabled={busy}><ArrowLeft size={17} aria-hidden="true" />Back</button> : <span />}
      {step === "verify" && !email?.verified ? null
        : <button type="submit" className={`${css.btn} ${css.primary} ${css.grow}`} disabled={!canNext || busy}>{busy && last ? "Starting your company…" : last ? <>Start {company.trim() || "my company"}<ArrowRight size={17} aria-hidden="true" /></> : <>Continue<ArrowRight size={17} aria-hidden="true" /></>}</button>}
    </div>
    <p className={css.muted}>Nothing is shared with other companies on Pulse. Your own web address (a custom domain) is set up with the Pulse team later.</p>
    {signedIn ? null : <ReportProblemLink title="Starting a company" className={css.muted} />}
  </form></div>;
}
