"use client";
// PEOPLE-CONTACTS part 5: the interactive pieces of a contact's profile: writing and removing notes, linking what
// Pulse found (admins), and the viewer's own mail with the contact (read from their own mailbox, in the browser).
import { ExternalLink, Link2, Mail, Send, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { notify } from "@pulse/ui-shell";
import { ago } from "../../lib/format";
import { post } from "../../records";
import { styles } from "../../ui";
import css from "./contact.module.css";

const message = (e: unknown) => e instanceof Error ? e.message : "Not saved";

/** Write a note: dated, signed, visible to the team (not HR-only accounts). */
export function NoteComposer({ contactId, name, compact }: { contactId: string; name: string; compact?: boolean }) {
  const router = useRouter(); const [busy, setBusy] = useState(false); const [text, setText] = useState("");
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); if (!text.trim()) return; setBusy(true);
    try { await post(`contacts/${contactId}/notes`, { body: text }); setText(""); notify({ id: "note", tone: "success", title: "Note added", timeout: 2000 }); router.refresh(); }
    catch (x) { notify({ id: "note", tone: "error", title: "Not saved", message: message(x) }); } finally { setBusy(false); }
  }
  return <form className={css.composer} data-compact={compact ? "" : undefined} onSubmit={submit}>
    <textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} rows={compact ? 2 : 3} placeholder={`A note about ${name.split(/\s+/)[0]}: a call, a decision, a preference…`} aria-label="New note"
      onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit(); }} />
    <button className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || !text.trim()}><Send size={13} aria-hidden="true" />{busy ? "Saving…" : "Add note"}</button>
  </form>;
}

export function RemoveNote({ id }: { id: string }) {
  const router = useRouter(); const [busy, setBusy] = useState(false);
  return <button type="button" className={css.iconBtn} disabled={busy} aria-label="Remove note" title="Remove note" onClick={async () => {
    setBusy(true); try { await post(`contacts/notes/${id}/remove`); router.refresh(); } catch (e) { notify({ id: "note", tone: "error", title: "Not removed", message: message(e) }); } finally { setBusy(false); }
  }}><Trash2 size={13} aria-hidden="true" /></button>;
}

/** Link what Pulse found (a project whose files name them, a client with their e-mail domain). Admins only. */
export function LinkSuggestion({ contactId, kind, targetId, name }: { contactId: string; kind: "project" | "client"; targetId: string; name: string }) {
  const router = useRouter(); const [busy, setBusy] = useState(false);
  return <button type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={busy} onClick={async () => {
    setBusy(true); try { await post(`contacts/${contactId}/links`, { kind, targetId }); notify({ id: "link", tone: "success", title: `Linked to ${name}`, timeout: 2500 }); router.refresh(); }
    catch (e) { notify({ id: "link", tone: "error", title: "Not linked", message: message(e) }); setBusy(false); }
  }}><Link2 size={12} aria-hidden="true" />Link</button>;
}

type MailRow = { id: string; threadId: string; fromName: string; fromEmail: string; subject: string; at: string | null; snippet: string };
/** Mail with the contact from the viewer's own mailbox (Gmail search: their address, else their full name). */
export function MailWith({ email, name }: { email: string | null; name: string }) {
  const [rows, setRows] = useState<MailRow[] | null>(null), [error, setError] = useState("");
  const q = email ? `from:${email} OR to:${email}` : `"${name}"`;
  useEffect(() => {
    let live = true;
    fetch(`/api/v0/inbox?q=${encodeURIComponent(q)}`, { cache: "no-store" }).then(async (r) => { const d = await r.json(); if (!r.ok) throw new Error(d.error ?? "Mail is not available"); if (live) setRows((d.rows ?? []).slice(0, 12)); })
      .catch((e) => { if (live) setError(message(e)); });
    return () => { live = false; };
  }, [q]);
  if (error) return <p className={css.quiet}><Mail size={14} aria-hidden="true" />{/Workspace|mailbox/i.test(error) ? "Mail appears here when you sign in with your own company account." : error}</p>;
  if (!rows) return <p className={css.quiet} aria-busy="true">Looking in your mailbox…</p>;
  if (!rows.length) return <p className={css.quiet}><Mail size={14} aria-hidden="true" />No mail with {email ?? name} in your mailbox.</p>;
  return <ul className={css.mails}>{rows.map((m) => <li key={m.id}>
    <a href={`https://mail.google.com/mail/u/0/#all/${encodeURIComponent(m.threadId)}`} target="_blank" rel="noreferrer">
      <span className={css.mailTop}><b>{m.subject || "(no subject)"}</b>{m.at ? <time dateTime={m.at}>{ago(m.at)}</time> : null}</span>
      <small>{m.fromName || m.fromEmail} · {m.snippet}</small></a><ExternalLink size={12} aria-hidden="true" /></li>)}</ul>;
}
