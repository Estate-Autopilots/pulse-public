"use client";
// UI-DIALOGS: the app's own confirm, prompt and toast on /kit (made-up names; nothing is read or written), for review,
// screenshots and the browser walk.
import { useState } from "react";
import { Archive, FolderPlus, Link2, MessageSquareText, Trash2, CircleCheck, CircleAlert, Undo2 } from "lucide-react";
import { toast, useConfirm, usePrompt } from "./dialogs";
import css from "./gallery.module.css";

export function DialogsGallery() {
  const confirm = useConfirm(), ask = usePrompt();
  const [answer, setAnswer] = useState<string>("");
  const said = (what: string, value: boolean | string | null) => setAnswer(`${what}: ${value === null ? "cancelled" : JSON.stringify(value)}`);
  return <section className={css.card} aria-labelledby="k-dialogs"><h2 id="k-dialogs">Confirm, prompt and toast</h2>
    <div className={css.chips}>
      <button type="button" className={css.btn} onClick={async () => said("Archive", await confirm({ title: "Archive the folder “Site visits”?", body: "Its docs stay. You can find them under All docs.", confirmLabel: "Archive folder" }))}>
        <Archive size={14} aria-hidden="true" />Archive folder</button>
      <button type="button" className={css.btn} onClick={async () => said("Delete", await confirm({ title: "Delete “Q4 shoot plan” for good?", body: "This can't be undone. Everyone loses it, and it leaves every folder.", confirmLabel: "Delete for good", danger: true, typeToConfirm: "Q4 shoot plan" }))}>
        <Trash2 size={14} aria-hidden="true" />Delete for good</button>
      <button type="button" className={css.btn} onClick={async () => said("New folder", await ask({ title: "Name the new folder", label: "Folder name", placeholder: "For example: Site visits", confirmLabel: "Create folder", maxLength: 80 }))}>
        <FolderPlus size={14} aria-hidden="true" />New folder</button>
      <button type="button" className={css.btn} onClick={async () => said("Reason", await ask({ title: "Why are you taking this import back?", body: "Its messages are hidden from everyone. Nothing is deleted.", label: "Reason", helper: "We keep this note with the import.", confirmLabel: "Take back import", multiline: true, minLength: 3, maxLength: 300, danger: true }))}>
        <MessageSquareText size={14} aria-hidden="true" />Reason (several lines)</button>
      <button type="button" className={css.btn} onClick={async () => said("Link", await ask({ title: "Add a link", label: "Link", placeholder: "https://example.com", helper: "Paste the web address the words should open.", confirmLabel: "Add link", url: ["https:", "http:", "mailto:"] }))}>
        <Link2 size={14} aria-hidden="true" />Add link</button>
    </div>
    <div className={css.chips}>
      <button type="button" className={css.btn} onClick={() => toast.success("Folder made", { message: "“Site visits” is in My docs." })}><CircleCheck size={14} aria-hidden="true" />Toast: done</button>
      <button type="button" className={css.btn} onClick={() => toast.error(new Error("Not saved: you are offline"), { message: "Your words are kept here. Try again when you are back online." })}><CircleAlert size={14} aria-hidden="true" />Toast: problem</button>
      <button type="button" className={css.btn} onClick={() => toast.success("Folder archived", { action: { label: "Undo", run: () => toast.info("Folder is back") } })}><Undo2 size={14} aria-hidden="true" />Toast with Undo</button>
    </div>
    <p className={css.note} aria-live="polite" data-dialog-answer="">{answer || "Press a button. Esc or Cancel says no; Enter says yes."}</p>
  </section>;
}
