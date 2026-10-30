"use client";
import { useState, type FormEvent } from "react";
import { PasswordField } from "../login/password-field";
import css from "../oauth/authorize/authorize.module.css";

const suggest = (name: string) => name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, ".").replace(/^\.+|\.+$/g, "").slice(0, 30);

/** PULSE-ID: a new Pulse account and the organisation it starts (its admin), then back to where it came from. */
export function SignupForm({ next }: { next: string }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [name, setName] = useState(""), [handle, setHandle] = useState(""), [touched, setTouched] = useState(false);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault(); setBusy(true); setProblem(null);
    const f = new FormData(e.currentTarget);
    const body = { name: String(f.get("name") ?? ""), handle: String(f.get("handle") ?? "").replace(/^@/, ""), email: String(f.get("email") ?? ""),
      password: String(f.get("password") ?? ""), orgName: String(f.get("orgName") ?? "") };
    try {
      const r = await fetch("/api/v0/auth/signup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const data = await r.json().catch(() => null);
      if (!r.ok) throw new Error(typeof data?.error === "string" ? data.error : "Pulse couldn’t create your account. Try again.");
      window.location.assign(next);
    } catch (err) { setProblem((err as Error).message); setBusy(false); }
  };
  return <div className={css.screen}>
    <form className={`${css.card} ${css.form}`} onSubmit={submit} aria-labelledby="signup-title">
      <p className={css.kicker}>New to Pulse</p>
      <h1 id="signup-title" className={css.title}>Create your Pulse account</h1>
      <p className={css.sub} style={{ textAlign: "center" }}>One account for every organisation you work with. You’ll go straight back to where you were.</p>
      <label className={css.field}>Your name<input name="name" required minLength={2} maxLength={120} autoComplete="name" value={name}
        onChange={(e) => { setName(e.target.value); if (!touched) setHandle(suggest(e.target.value)); }} /></label>
      <label className={css.field}>Your @handle<input name="handle" required pattern="@?[a-z0-9][a-z0-9._]{2,29}" maxLength={31} autoComplete="username" value={handle}
        onChange={(e) => { setTouched(true); setHandle(e.target.value.toLowerCase()); }} /><span className={css.hint}>3 to 30 lower-case letters, digits, dots or underscores</span></label>
      <label className={css.field}>E-mail<input name="email" type="email" required maxLength={254} autoComplete="email" /></label>
      <PasswordField label="Password" name="password" required autoComplete="new-password" />
      <label className={css.field}>Your organisation<input name="orgName" required minLength={2} maxLength={80} autoComplete="organization" placeholder="Your company or studio" />
        <span className={css.hint}>You’ll be its admin. Have an invitation instead? Open its link to join that organisation.</span></label>
      {problem ? <p className={css.status} data-tone="error" role="alert">{problem}</p> : null}
      <button className={css.primary} type="submit" disabled={busy}>{busy ? "Creating…" : "Create account and continue"}</button>
      <p className={css.foot}>Already on Pulse? <a href={`/login?${new URLSearchParams({ next })}`}>Sign in</a></p>
    </form>
  </div>;
}
