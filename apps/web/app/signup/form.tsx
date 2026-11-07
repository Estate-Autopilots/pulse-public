"use client";
import { ArrowLeft } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { PasswordField } from "../login/password-field";
import css from "../oauth/authorize/authorize.module.css";
import { plainError } from "../lib/plain-error.mjs";
import { ReportProblemLink } from "../bug-report/report-link";
import { SPACES, setupBody, suggestSpace, type SetupAnswers } from "./setup-catalogue";
import { UseStep, WhoStep, answersReady, setupSummary } from "./setup-steps";
import s from "./setup.module.css";

const suggest = (name: string) => name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, ".").replace(/^\.+|\.+$/g, "").slice(0, 30);
type Details = { name: string; handle: string; email: string };
type Step = "who" | "use" | "details" | "code";
const STEPS: Step[] = ["who", "use", "details", "code"];
type HandleState = "checking" | "available" | "taken" | "invalid" | null;
const HANDLE = /^[a-z0-9][a-z0-9._]{2,29}$/;

/** CONSOLIDATION (1535): whether a handle is free, asked a moment after typing stops. The server says only available,
 *  taken or invalid; anything else (offline, rationed, sign-up off) shows nothing and the sign-up itself decides. */
function useHandleCheck(handle: string, off: boolean): HandleState {
  // The server's answer, kept with the handle it is about; everything else is worked out while rendering.
  const [said, setSaid] = useState<{ handle: string; state: HandleState } | null>(null);
  const ask = !off && !!handle && HANDLE.test(handle);
  useEffect(() => {
    if (!ask) return;
    const ctl = new AbortController();
    const timer = setTimeout(() => {
      void fetch("/api/v0/auth/handle-check", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ handle }), signal: ctl.signal })
        .then((r) => r.ok ? r.json() as Promise<{ status?: unknown }> : null)
        .then((d) => setSaid({ handle, state: d?.status === "available" || d?.status === "taken" || d?.status === "invalid" ? d.status : null }))
        .catch(() => { if (!ctl.signal.aborted) setSaid({ handle, state: null }); });
    }, 400);
    return () => { clearTimeout(timer); ctl.abort(); };
  }, [handle, ask]);
  if (off || !handle) return null;
  if (!HANDLE.test(handle)) return "invalid";
  return said?.handle === handle ? said.state : "checking";
}

const handleHint = (state: HandleState, handle: string) =>
  state === "available" ? `@${handle} is free.` : state === "taken" ? `Someone already has @${handle}. Try another.`
    : state === "invalid" ? "3 to 30 lower-case letters, digits, dots or underscores." : state === "checking" ? "Checking…" : null;

async function send<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`/api/v0/auth/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => null);
  const said = typeof data?.error === "string" ? data.error : "Pulse couldn’t do that. Try again.";
  if (!r.ok) throw new Error(plainError(said));
  return data as T;
}

/** PULSE-ID, ACCOUNT-CODE (1465): a new personal Pulse account, without a password. SELF-SERVE (owner, 4 Nov 2026:
 *  "anyone can open Pulse, make an account and manage their life or work by their type"): first "Which describes
 *  you?" and "What will you use Pulse for?" (a personal space, or an organisation with its name and what it calls the
 *  people it serves), then name and e-mail, then the 6-digit code e-mailed to confirm the address; the account opens on
 *  its first space set up for its type (or back to the app it was connecting: Sign in with Pulse, ChatGPT or Claude). */
export function SignupForm({ next, forApp }: { next?: string; forApp?: string }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [open, setOpen] = useState<boolean | null>(null);
  const [withPassword, setWithPassword] = useState(false);
  const [details, setDetails] = useState<Details>({ name: "", handle: "", email: "" });
  const [answers, setAnswers] = useState<SetupAnswers>({ profiles: [], space: "personal", served: null, orgName: "" });
  const [touched, setTouched] = useState(false);
  const [step, setStep] = useState<Step>("who");
  const handleState = useHandleCheck(details.handle, step !== "details" || open !== true);
  const handleSaid = handleHint(handleState, details.handle);
  // Personal sign-up is on at Pulse's shared address; a company's own address says so unless it allows it.
  useEffect(() => {
    let live = true;
    void fetch("/api/v0/auth/branding", { cache: "no-store" }).then((r) => r.ok ? r.json() as Promise<{ signup?: unknown }> : null)
      .then((b) => { if (live) setOpen(b?.signup === true); }).catch(() => { if (live) setOpen(true); });
    return () => { live = false; };
  }, []);
  const set = (k: keyof Details, v: string) => setDetails((d) => ({ ...d, [k]: v }));
  const go = (to: Step) => { setProblem(null); setStep(to); window.scrollTo({ top: 0 }); };

  const askCode = async () => {
    setBusy(true); setProblem(null);
    try { const r = await send<{ message?: string }>("signup-code", { ...details, orgName: "" }); setSent(r.message ?? "A 6-digit code is on its way to that e-mail."); setStep("code"); }
    catch (err) { setProblem((err as Error).message); } finally { setBusy(false); }
  };
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (step === "who" || step === "use") {
      const why = answersReady(step, answers); if (why) { setProblem(why); return; }
      if (step === "who") {
        // The second question starts on the likeliest answer for the first (a professional: My practice).
        setAnswers((a) => { if (a.orgName) return a; const k = suggestSpace(a.profiles); return { ...a, space: k, served: a.served ?? SPACES.find((x) => x.key === k)?.served ?? null }; });
        go("use");
      }
      else go("details");
      return;
    }
    if (step === "details") { await askCode(); return; }
    const f = new FormData(e.currentTarget);
    const code = String(f.get("code") ?? "").replace(/\D/g, "");
    if (code.length !== 6) { setProblem("Type the 6 digits from the e-mail."); return; }
    setBusy(true); setProblem(null);
    try {
      const r = await send<{ home?: string }>("signup-confirm", { ...details, orgName: "", code, setup: setupBody(answers), ...(withPassword ? { password: String(f.get("password") ?? "") } : {}) });
      window.location.assign(next ?? r.home ?? "/");
    } catch (err) { setProblem((err as Error).message); setBusy(false); }
  };

  if (open === false) return <div className={css.screen}><div className={`${css.card} ${css.form}`}>
    <p className={css.kicker}>New to Pulse</p>
    <h1 className={css.title}>Sign-up isn’t open here</h1>
    <p className={css.sub} style={{ textAlign: "center" }}>This is a company’s own Pulse address. Ask the company for an invitation, or create your personal account at Pulse’s own address.</p>
    <p className={css.foot}>Already on Pulse? <a href="/login">Sign in</a></p>
  </div></div>;

  const at = STEPS.indexOf(step);
  const title = step === "who" ? "Create your Pulse account" : step === "use" ? "Set up your space" : step === "details" ? "Your details" : "Check your e-mail";
  const sub = step === "who" ? (forApp ? `One account, then back to ${forApp}. No password needed.` : "One account for your life and work, and every organisation you join. No password needed.")
    : step === "use" ? "Pulse sets up the right screens, words and first steps for it."
    : step === "details" ? "We e-mail you a 6-digit code to confirm your address." : `Type the 6-digit code we sent to ${details.email}.`;
  return <div className={css.screen}>
    <form className={`${css.card} ${css.form} ${s.wide}`} onSubmit={submit} aria-labelledby="signup-title" data-step={step}>
      <p className={css.kicker}>{forApp ? `New to Pulse · for ${forApp}` : "New to Pulse"}</p>
      <div className={s.progress} aria-label={`Step ${at + 1} of 4`} role="img">{STEPS.map((x, i) => <span key={x} data-on={i <= at ? "" : undefined} />)}</div>
      <h1 id="signup-title" className={css.title}>{title}</h1>
      <p className={css.sub} style={{ textAlign: "center" }}>{sub}</p>
      {step === "who" ? <WhoStep answers={answers} onChange={setAnswers} /> : null}
      {step === "use" ? <UseStep answers={answers} onChange={setAnswers} personName={details.name} /> : null}
      {step === "details" || step === "code" ? <>
        <label className={css.field}>Your name<input name="name" required minLength={2} maxLength={120} autoComplete="name" value={details.name} readOnly={step === "code"}
          onChange={(e) => { set("name", e.target.value); if (!touched) set("handle", suggest(e.target.value)); }} /></label>
        <label className={css.field}>E-mail<input name="email" type="email" required maxLength={254} autoComplete="email" value={details.email} readOnly={step === "code"}
          onChange={(e) => set("email", e.target.value)} /></label>
        <label className={css.field}>Your @handle<input name="handle" required pattern="@?[a-z0-9][a-z0-9._]{2,29}" maxLength={31} autoComplete="username" value={details.handle} readOnly={step === "code"}
          onChange={(e) => { setTouched(true); set("handle", e.target.value.toLowerCase().replace(/^@/, "")); }} /><span className={css.hint}>How people find you on Pulse. 3 to 30 lower-case letters, digits, dots or underscores.</span>
          {handleSaid ? <span className={css.hint} role="status" aria-live="polite" data-handle={handleState ?? undefined}>{handleSaid}</span> : null}</label>
        <p className={s.summary}>{setupSummary(answers)}</p>
      </> : null}
      {step === "code" ? <>
        <p className={css.status} data-tone="info" role="status">{sent}</p>
        <label className={css.field}>6-digit code<input name="code" required autoComplete="one-time-code" inputMode="numeric" pattern="[0-9 ]*" maxLength={7} placeholder="123456" autoFocus /></label>
        <label className={css.foot} style={{ textAlign: "left" }}><input type="checkbox" checked={withPassword} onChange={(e) => setWithPassword(e.target.checked)} /> Also set a password now (optional: you can always sign in with an e-mailed code, or set one later in your account)</label>
        {withPassword ? <PasswordField label="Password" name="password" required autoComplete="new-password" /> : null}
      </> : null}
      {problem ? <p className={css.status} data-tone="error" role="alert">{problem}</p> : null}
      <button className={css.primary} type="submit" disabled={busy || open === null || (step === "details" && handleState === "taken")}>{busy ? "Working…" : step === "code" ? (forApp ? `Create my account and continue to ${forApp}` : "Create my space") : step === "details" ? "E-mail me a code" : "Continue"}</button>
      {step === "code" ? <button type="button" className={css.secondary} disabled={busy} onClick={() => void askCode()}>Send a new code</button> : null}
      {at > 0 ? <button type="button" className={css.secondary} disabled={busy} onClick={() => go(STEPS[at - 1])}><ArrowLeft size={16} aria-hidden="true" />{step === "code" ? "Change my details" : "Back"}</button> : null}
      <p className={css.foot}>Already on Pulse? <a href={next ? `/login?${new URLSearchParams({ next })}` : "/login"}>Sign in</a></p>
      <ReportProblemLink title="Creating a Pulse account" className={css.foot} />
    </form>
  </div>;
}
