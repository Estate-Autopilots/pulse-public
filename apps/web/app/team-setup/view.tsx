"use client";
import { ArrowRight, Check } from "lucide-react";
import { useState, type FormEvent } from "react";
import { post } from "../records";
import { GetInPicture } from "../login/how/view";
import css from "../login/how/how.module.css";

type Checked = { domain: string | null; suggestion: string | null };
type Step = "who" | "answer" | "done";

/** Team setup: code and name, then "Do you have a company Google account?", then the address or how to reach you. */
export function TeamSetup() {
  const [step, setStep] = useState<Step>("who");
  const [code, setCode] = useState(""); const [name, setName] = useState("");
  const [checked, setChecked] = useState<Checked | null>(null);
  const [has, setHas] = useState<boolean | null>(null);
  const [email, setEmail] = useState(""); const [personal, setPersonal] = useState(""); const [whatsapp, setWhatsapp] = useState("");
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const domain = checked?.domain;
  const company = domain ? `@${domain}` : "company";
  async function check(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError("");
    try { const r = await post<Checked>("auth/team-setup-check", { code, name }); setChecked(r); setStep("answer"); }
    catch (err) { setError(err instanceof Error ? err.message : "Could not check the code"); } finally { setBusy(false); }
  }
  async function send(e: FormEvent) {
    e.preventDefault(); if (has === null) return; setBusy(true); setError("");
    try {
      await post("auth/team-setup", { code, name, hasGoogle: has, ...(has ? { email } : { personalEmail: personal, whatsapp }) });
      setStep("done");
    } catch (err) { setError(err instanceof Error ? err.message : "Could not send"); } finally { setBusy(false); }
  }
  const first = name.trim().split(/\s+/)[0] ?? "";
  return <div className={css.wrap}><article className={css.card}>
    <p className={css.kicker}>Pulse · Team setup</p>
    <h1>Set up your Pulse login</h1>
    <p className={css.lede}>One rule: <b>your company Google account is your Pulse login.</b> Tell us who you are and the admin sets you up.</p>
    <GetInPicture />
    {step === "who" ? <form className={css.form} onSubmit={check}>
      <label className={css.field}>Team code<small>Your admin shared it in the team&apos;s WhatsApp group.</small>
        <input value={code} onChange={(e) => setCode(e.target.value)} required maxLength={24} autoComplete="off" autoCapitalize="characters" spellCheck={false} placeholder="ABCD-2345" /></label>
      <label className={css.field}>Your full name<input value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={120} autoComplete="name" placeholder="First and last name" /></label>
      {error ? <p className={css.note} data-tone="error" role="alert">{error}</p> : null}
      <button className={css.cta} disabled={busy}>{busy ? "Checking…" : <>Next<ArrowRight size={16} aria-hidden="true" /></>}</button>
    </form> : null}
    {step === "answer" ? <form className={css.form} onSubmit={send}>
      <h2>Do you have a {company} Google account?</h2>
      <p className={css.muted}>It is the account of your company e-mail{domain ? <> (name@{domain})</> : null}: you open Gmail with it.</p>
      <div className={css.choice} role="group" aria-label="Do you have a company Google account?">
        <button type="button" aria-pressed={has === true} onClick={() => { setHas(true); setError(""); if (!email && checked?.suggestion) setEmail(checked.suggestion); }}>Yes, I have one</button>
        <button type="button" aria-pressed={has === false} onClick={() => { setHas(false); setError(""); }}>No, not yet</button>
      </div>
      {has === true ? <>
        <label className={css.field}>Your company address<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required maxLength={254} autoComplete="email" autoCapitalize="none" spellCheck={false} placeholder={domain ? `name@${domain}` : "name@company.com"} /></label>
        {checked?.suggestion && email !== checked.suggestion ? <button type="button" className={css.suggest} onClick={() => setEmail(checked.suggestion!)}>Is it {checked.suggestion}? Use it</button> : null}
        <p className={css.muted}>The admin links it to your Pulse profile. Then you sign in with <b>Continue with Google</b>: no other password.</p>
      </> : null}
      {has === false ? <>
        <p className={css.note}>The admin creates your company Google account; you&apos;ll get it on WhatsApp. Google will make you change the password on first sign-in.</p>
        <label className={css.field}>Your personal e-mail<input type="email" value={personal} onChange={(e) => setPersonal(e.target.value)} required maxLength={254} autoComplete="email" autoCapitalize="none" spellCheck={false} placeholder="user-aa260886@gmail.com" /></label>
        <label className={css.field}>Your WhatsApp number<small>With the country code, for example +91 and your 10 digits.</small><input type="tel" value={whatsapp} onChange={(e) => setWhatsapp(e.target.value)} required maxLength={32} autoComplete="tel" inputMode="tel" placeholder="+91" /></label>
      </> : null}
      {error ? <p className={css.note} data-tone="error" role="alert">{error}</p> : null}
      {has !== null ? <button className={css.cta} disabled={busy}>{busy ? "Sending…" : <>Send to the admin<ArrowRight size={16} aria-hidden="true" /></>}</button> : null}
      <button type="button" className={css.quiet} onClick={() => { setStep("who"); setHas(null); setError(""); }}>Back</button>
    </form> : null}
    {step === "done" ? <div className={css.form} role="status">
      <p className={css.note} data-tone="success"><Check size={16} aria-hidden="true" />Thanks{first ? `, ${first}` : ""}. The admin has your details.</p>
      {has ? <p className={css.muted}>When the admin has linked <b>{email}</b>, open Pulse and press <b>Continue with Google</b> (or use the invitation the admin sends you).</p>
        : <p className={css.muted}>The admin makes your company Google account and sends you its address and first password on WhatsApp. Then open Pulse, press <b>Continue with Google</b> and set your own Google password when Google asks.</p>}
      <a className={css.quiet} href="/login/how">How you get into Pulse</a>
    </div> : null}
    <p className={css.muted}>Pulse sends nothing by itself from this page. Only the admin sees what you send.</p>
  </article></div>;
}
