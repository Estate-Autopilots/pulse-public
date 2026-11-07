"use client";
// TASKS-3: What's blocking us. A nudge is a comment on the blocking task that mentions its owner ("3 tasks wait on
// this"), so they are told through the usual paths and the conversation stays on the task.
import { useState } from "react";
import { BellRing, Check } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { post } from "../records";
import { styles } from "../ui";

const msg = (e: unknown) => e instanceof Error ? e.message : "That did not work. Try again.";

export function NudgeButton({ taskId, ownerId, ownerName, waiting, people }: { taskId: string; ownerId: string | null; ownerName: string; waiting: number; people: number }) {
  const [busy, setBusy] = useState(false), [done, setDone] = useState(false);
  if (!ownerId) return null;
  const first = ownerName.split(" ")[0];
  async function nudge() {
    setBusy(true);
    try {
      await post("work/comments", { taskId, body: `@${ownerName} ${waiting === 1 ? "A task waits" : `${waiting} tasks wait`} on this${people > 1 ? ` (${people} people)` : ""}. Can it move today, or is something in the way?`, mentions: [ownerId] });
      setDone(true); notify({ id: `nudge:${taskId}`, tone: "success", title: `Nudged ${first}`, message: "They are told; the note stays on the task.", timeout: 3000 });
    } catch (e) { notify({ id: `nudge:${taskId}`, tone: "error", title: "Not sent", message: msg(e) }); } finally { setBusy(false); }
  }
  return done ? <span className={styles.muted}><Check size={13} aria-hidden="true" /> Nudged</span>
    : <button type="button" className={styles.btn} disabled={busy} onClick={nudge} title={`Comment on the task and tell ${first}`}><BellRing size={13} aria-hidden="true" />Nudge {first}</button>;
}
