"use client";
// MODULES-1024: Work's own way to add a task. The top bar's + New went (owner workbench), leaving N and Pip, so a phone
// or a mouse-only person had no visible way to add a task on Work ("Tap + to add one" pointed at nothing).
import { Plus } from "lucide-react";
import { openCreate } from "../create";
import { styles } from "../ui";

export function NewTask() {
  return <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => openCreate({ kind: "task" })} aria-keyshortcuts="n">
    <Plus size={15} aria-hidden="true" />New task
  </button>;
}
