"use client";
// TASKS-4A: give someone a task from their page: + Create with them chosen (asked instead when outside your reach).
import { Plus } from "lucide-react";
import { openCreate } from "../../create";
import { styles } from "../../ui";

export function GiveTaskButton({ personId, first }: { personId: string; first: string }) {
  return <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => openCreate({ kind: "task", assigneeId: personId })}><Plus size={14} aria-hidden="true" />Give {first} a task</button>;
}
