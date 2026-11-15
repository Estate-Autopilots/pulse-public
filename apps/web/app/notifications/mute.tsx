"use client";
// ATT: what may ping you (a toast, a phone or browser push, a desktop notice), kind by kind. Muted kinds still arrive
// in the bell, quietly; urgent ones (pay, bank changes) always reach you. Saved at once (companion notification settings).
import { useEffect, useState } from "react";
import { styles } from "../ui";
import { Switch } from "../kit";
import css from "./notifications.module.css";

/** UX-SIMPLE (28 Oct 2026): fourteen switches in a column became three groups, each with one switch for all of it and
 *  its kinds one click away. */
const GROUPS: { key: string; label: string; hint: string; kinds: string[] }[] = [
  { key: "work", label: "Work and chats", hint: "Tasks, reviews, mentions, direct messages, decisions and process steps", kinds: ["approvals", "mentions", "chats", "tasks_assigned", "tasks_waiting", "tasks_due", "reviews", "processes"] },
  { key: "attendance", label: "Attendance", hint: "Check-in questions, reminders and HR's daily digest", kinds: ["attendance_questions", "attendance_reminders", "attendance_digest"] },
  { key: "you", label: "You and the company", hint: "Your own requests, holidays and policies", kinds: ["my_requests", "company_updates"] },
];
const KINDS: [string, string, string][] = [
  ["approvals", "Requests waiting for your decision", "Once a day as a digest, plus new ones"],
  ["mentions", "Mentions and replies", ""],
  ["chats", "Direct messages", "Group messages wait in the bell"],
  ["tasks_assigned", "Tasks for you", ""],
  ["tasks_waiting", "Someone waiting on your task", ""],
  ["tasks_due", "Tasks due soon", ""],
  ["reviews", "Reviews to do", ""],
  ["attendance_questions", "Pulse’s attendance questions", "“Check in?” on arrival, and the one question when the signals disagree"],
  ["attendance_reminders", "Check-in and break reminders", "Once a day at most"],
  ["attendance_digest", "Daily attendance digest", "HR only"],
  ["my_requests", "Your own requests", "Approved, rejected, moved on"],
  ["processes", "Process steps and alerts", ""],
  ["company_updates", "Holidays and policies", "Briefs and company news wait in the bell"],
];

export function MuteKinds() {
  // The whole settings object goes back with each change (the route replaces quiet hours and Do not disturb with what
  // it is sent), so a mute never resets anything else.
  const [settings, setSettings] = useState<Record<string, unknown> | null>(null), [saved, setSaved] = useState(""), [error, setError] = useState("");
  const mute = settings ? (settings.mute ?? {}) as Record<string, boolean> : null;
  useEffect(() => {
    let live = true;
    fetch("/api/v0/companion/notification-settings", { cache: "no-store" }).then(async (r) => { const d = await r.json(); if (live && r.ok) setSettings(d.settings ?? {}); }).catch(() => {});
    return () => { live = false; };
  }, []);
  async function toggle(kind: string | string[], on: boolean) {
    if (!settings) return;
    const kinds = Array.isArray(kind) ? kind : [kind];
    const before = settings, next = { ...settings, mute: { ...(mute ?? {}), ...Object.fromEntries(kinds.map((k) => [k, !on])) } };
    setSettings(next); setSaved(""); setError("");
    try {
      const r = await fetch("/api/v0/companion/notification-settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(next) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Not saved");
      setSaved(on ? "Pings back on for that kind." : "Muted: it waits in the bell.");
    } catch (e) { setError((e as Error).message); setSettings(before); }
  }
  if (!mute) return null;
  return (
    <fieldset className={css.mute}>
      <legend>What may ping you</legend>
      <p className={styles.muted}>A ping is a toast, a phone or browser push, or a desktop notice. Off: it still arrives in the bell, quietly. Pay and bank changes always reach you; for-your-information news never pings.</p>
      {/* UI-POLISH-3: kit Switches, one row per kind; each saves at once. */}
      {GROUPS.map((g) => {
        const kinds = KINDS.filter(([k]) => g.kinds.includes(k)), on = kinds.filter(([k]) => !mute[k]).length;
        return <section key={g.key} className={css.muteGroup} aria-label={g.label}>
          <Switch label={g.label} hint={on === kinds.length ? g.hint : on ? `${on} of ${kinds.length} on` : "All muted: they wait in the bell"} checked={on > 0} onChange={(v) => void toggle(kinds.map(([k]) => k), v)} />
          <details><summary>Choose kinds</summary>
            <ul>{kinds.map(([kind, label, hint]) => <li key={kind}><Switch label={label} hint={hint || undefined} checked={!mute[kind]} onChange={(v) => void toggle(kind, v)} /></li>)}</ul>
          </details>
        </section>;
      })}
      {saved ? <p role="status" className={styles.muted}>{saved}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </fieldset>
  );
}
