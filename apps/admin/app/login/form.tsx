"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import styles from "./login.module.css";

export function SignInForm({ product }: { product: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [challenge, setChallenge] = useState<string | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>;
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/auth/sign-in", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(challenge !== null ? { code: data.code, challenge } : { username: data.username, password: data.password }),
      });
      const body = (await r.json().catch(() => ({}))) as { ok?: boolean; twoStep?: boolean; challenge?: string; mustChange?: boolean; error?: string };
      if (!r.ok) throw new Error(body.error ?? "Those details did not work.");
      if (body.twoStep) { setChallenge(body.challenge ?? ""); return; }
      if (body.mustChange) throw new Error(`Choose your own password in ${product} first, then sign in here.`);
      router.replace("/");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Those details did not work.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className={styles.form} onSubmit={submit}>
      {challenge !== null ? (
        <label className={styles.field}>Authenticator or recovery code
          <input name="code" required autoComplete="one-time-code" autoCapitalize="none" maxLength={40} autoFocus />
        </label>
      ) : (
        <>
          <label className={styles.field}>Username or e-mail
            <input name="username" required autoComplete="username" autoCapitalize="none" maxLength={120} autoFocus />
          </label>
          <label className={styles.field}>Password
            <input name="password" type="password" required autoComplete="current-password" maxLength={200} />
          </label>
        </>
      )}
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      <button className={styles.primary} disabled={busy}>{busy ? "Signing in…" : challenge !== null ? "Verify and sign in" : "Sign in"}</button>
    </form>
  );
}
