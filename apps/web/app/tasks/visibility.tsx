"use client";
// PRIVACY (owner, 2 Nov 2026: "who sees what"): who sees a project (everyone, its members, leadership) and whether a task
// is leadership-only. The rules are row security in the database (1455_privacy_visibility.sql); these only set and say them.
import { useRouter } from "next/navigation";
import { useState, useSyncExternalStore, type ReactNode } from "react";
import { Eye, Lock } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { post } from "../records";
import { SelectField } from "../kit/select-field";
import { Toggle } from "./kit";
import css from "./tasks.module.css";

export type Visibility = "org" | "members" | "leadership";
export const VISIBILITY: { value: Visibility; label: string; hint: string }[] = [
  { value: "org", label: "Everyone", hint: "Everyone in the company (freelancers and clients only when they are on it)" },
  { value: "members", label: "Members only", hint: "The people on it, and admins" },
  { value: "leadership", label: "Leadership only", hint: "Leadership and admins, and the people on it" },
];
const msg = (e: unknown) => e instanceof Error ? e.message : String(e);

/** "Visible to: …", for a page's context line. */
export function VisibleTo({ text, restricted }: { text: string; restricted?: boolean }) {
  return <span className={css.visibleTo} data-restricted={restricted ? "" : undefined} title="Who can see this">
    {restricted ? <Lock size={12} aria-hidden="true" /> : <Eye size={12} aria-hidden="true" />}Visible to: {text}</span>;
}

/** The project's "Visible to" picker, for whoever manages it. Leadership-only is leadership's to set and lift. */
export function ProjectVisibility({ projectId, value, canLeadership }: { projectId: string; value: Visibility; canLeadership: boolean }) {
  const router = useRouter(); const [busy, setBusy] = useState(false);
  async function change(next: Visibility) {
    if (next === value) return;
    setBusy(true);
    try {
      await post(`work/projects/${projectId}`, { visibility: next });
      notify({ id: `visibility:${projectId}`, tone: "success", title: "Who sees it changed", message: VISIBILITY.find((v) => v.value === next)?.hint, timeout: 3600 });
      router.refresh();
    } catch (e) { notify({ id: `visibility:${projectId}`, tone: "error", title: "Not changed", message: msg(e) }); } finally { setBusy(false); }
  }
  const choices = VISIBILITY.filter((v) => canLeadership || v.value !== "leadership" || value === "leadership");
  return <label className={css.visibilityField}><span>Visible to</span>
    <SelectField size="sm" value={value} disabled={busy || (value === "leadership" && !canLeadership)} aria-label="Who can see this project"
      onChange={(e) => change(e.target.value as Visibility)}>
      {choices.map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}
    </SelectField>
    <small>{VISIBILITY.find((v) => v.value === value)?.hint}</small>
  </label>;
}

/** Leadership's switch on a task: only leadership, admins and the people on it see it. */
export function TaskLeadershipOnly({ taskId, on, compact }: { taskId: string; on: boolean; /** In the properties panel: the switch without its explainer. */ compact?: boolean }) {
  const router = useRouter(); const [busy, setBusy] = useState(false), [value, setValue] = useState(on);
  async function change(next: boolean) {
    setBusy(true); setValue(next);
    try { await post(`tasks/${taskId}`, { leadershipOnly: next }); router.refresh(); }
    catch (e) { setValue(!next); notify({ id: `lead-only:${taskId}`, tone: "error", title: "Not changed", message: msg(e) }); } finally { setBusy(false); }
  }
  return <Toggle label="Leadership only" checked={value} disabled={busy} onChange={change}>
    {compact ? null : <small className={css.visibilityHint}> · when on, only leadership, admins and the people on it see it</small>}</Toggle>;
}

const askListeners = new Set<() => void>();
const subscribeAsk = (f: () => void) => { askListeners.add(f); return () => { askListeners.delete(f); }; };

/** PM-BUILD-1 (owner, 17 Nov 2026: "things that are leadership-only should be treated that way (ask/mark)"): leadership
 *  is asked once, on a task whose words read as leadership business (lib/leadership-words.mjs) and that the team can
 *  see, whether to make it leadership-only. "Keep it open" is remembered for that task in this browser. Nothing changes
 *  without the tap. */
export function LeadershipAsk({ taskId, topic, children }: { taskId: string; topic: string; /** What shows once it was kept open (the visibility line). */ children?: ReactNode }) {
  const router = useRouter(); const key = `pulse-lead-ask:${taskId}`;
  // Read after hydration (the server never knows what this browser kept), and again when "Keep it open" writes it.
  const kept = useSyncExternalStore(subscribeAsk, () => { try { return localStorage.getItem(key) === "kept"; } catch { return false; } }, () => false);
  const [busy, setBusy] = useState(false);
  if (kept) return <>{children}</>;
  async function make() {
    setBusy(true);
    try { await post(`tasks/${taskId}`, { leadershipOnly: true }); notify({ id: `lead-only:${taskId}`, tone: "success", title: "Now leadership-only", message: "Only leadership, admins and the people on it see this task.", timeout: 4000 }); router.refresh(); }
    catch (e) { notify({ id: `lead-only:${taskId}`, tone: "error", title: "Not changed", message: msg(e) }); } finally { setBusy(false); }
  }
  function keep() { try { localStorage.setItem(key, "kept"); } catch { /* private mode */ } askListeners.forEach((f) => f()); }
  return <div className={css.leadAsk} role="note">
    <Lock size={16} aria-hidden="true" />
    <p><b>Make this leadership-only?</b><span>It is about {topic}. If yes, only leadership, admins and the people on it can see it.</span></p>
    <span className={css.leadAskActions}><button type="button" className={css.leadAskYes} onClick={make} disabled={busy}>Yes, leadership only</button>
      <button type="button" className={css.leadAskNo} onClick={keep} disabled={busy}>No, keep it open</button></span>
  </div>;
}
