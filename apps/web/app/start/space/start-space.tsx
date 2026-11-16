"use client";
// SELF-SERVE (owner, 4 Nov 2026): Start another space, signed in. The sign-up's second question (and the first, kept
// from Settings → About you), then the new space opens where it starts, with its getting-started cards.
import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { arrive, post, type Moved } from "../../orgs/client";
import css from "../../oauth/authorize/authorize.module.css";
import { setupBody, type ProfileKey, type SetupAnswers } from "../../signup/setup-catalogue";
import { UseStep, answersReady, setupSummary } from "../../signup/setup-steps";
import { readStart } from "../../lib/growth.mjs";
import { reportStarted } from "../../growth/started";
import s from "../../signup/setup.module.css";

export function StartSpace({ you }: { you: string }) {
  const [answers, setAnswers] = useState<SetupAnswers>({ profiles: [], space: "practice", served: "clients", orgName: "" });
  const [busy, setBusy] = useState(false); const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    // GROWTH-LOOP: from "Start free for your business": a business of their own, its name filled in when known.
    const from = readStart(window.location.search);
    const fill = from ? setTimeout(() => setAnswers((x) => ({ ...x, space: "other", served: "clients", orgName: from.name || x.orgName, profiles: x.profiles.length ? x.profiles : ["owner"] })), 0) : undefined;
    void fetch("/api/v0/account/about", { cache: "no-store" }).then((r) => r.ok ? r.json() as Promise<{ profiles?: ProfileKey[] }> : null)
      .then((a) => { if (live && a?.profiles?.length) setAnswers((x) => ({ ...x, profiles: a.profiles! })); }).catch(() => undefined);
    return () => { live = false; if (fill) clearTimeout(fill); };
  }, []);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const why = answersReady("use", answers); if (why) { setProblem(why); return; }
    setBusy(true); setProblem(null);
    try {
      const moved = await post<Moved & { home?: string }>("account/start", { setup: { ...setupBody(answers), profiles: answers.profiles.length ? answers.profiles : ["other"] } });
      await reportStarted();
      arrive(moved, moved.home || "/");
    } catch (err) { setProblem((err as Error).message); setBusy(false); }
  };
  return <div className={css.screen}>
    <form className={`${css.card} ${css.form} ${s.wide}`} onSubmit={submit} aria-labelledby="space-title">
      <p className={css.kicker}>{you ? `${you} · new space` : "New space"}</p>
      <h1 id="space-title" className={css.title}>Start another space</h1>
      <p className={css.sub} style={{ textAlign: "center" }}>Each space has its own people, words and settings. Switch between them from the top of any page.</p>
      <UseStep answers={answers} onChange={setAnswers} personName={you} />
      <p className={s.summary}>{setupSummary(answers)}</p>
      {problem ? <p className={css.status} data-tone="error" role="alert">{problem}</p> : null}
      <button className={css.primary} type="submit" disabled={busy}>{busy ? "Setting it up…" : "Start this space"}</button>
      <Link className={css.secondary} href="/orgs">Back to my spaces</Link>
      <p className={css.foot}>Want working days, modules and invitations in one go? <Link href="/start">The full company set-up</Link></p>
    </form>
  </div>;
}
