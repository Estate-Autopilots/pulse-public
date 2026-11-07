"use client";

// BILLING-EMAIL (owner, 5 Nov 2026; Kazuk: e-mail is how his quotations go out). "Send by email" on an approved
// quotation, proforma or tax invoice opens this composer: the customer's addresses (from the document, the billing
// profile and the point of contact, one ticked), a subject and a message in plain words that the person can change, the
// filed PDF attached and, for a quotation, the acceptance link. Nothing goes until Send is pressed; then the document
// is marked sent and its activity says who sent it, when and to whom.
import { useEffect, useState } from "react";
import { Paperclip, Send } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { post } from "../../../records";
import { styles } from "../../../ui";
import { Drawer, DrawerFooter, DrawerSection } from "../../../kit/drawer";
import { useWords } from "../../../org-code";
import { say } from "../../../lib/words.mjs";
import { when } from "../chain";
import css from "../documents.module.css";

type Suggestion = { email: string; name: string | null; source: "document" | "billing" | "contact" };
type Compose = { to: Suggestion[]; subject: string; body: string; file: string; acceptLink: boolean; replyTo: string; sent: { at: string; to: string[] | null; by: string | null }[] };
const SOURCE: Record<Suggestion["source"], string> = { document: "on the document", billing: "{client}'s billing profile", contact: "point of contact" };
const EMAIL = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;

export function EmailComposer({ docId, title, context, onClose, onSent }: { docId: string; title: string; context: string; onClose: () => void; onSent: () => void }) {
  const words = useWords();
  const [data, setData] = useState<Compose | null>(null), [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const [to, setTo] = useState<string[]>([]), [typed, setTyped] = useState(""), [subject, setSubject] = useState(""), [body, setBody] = useState(""), [link, setLink] = useState(true);
  useEffect(() => {
    let gone = false;
    fetch(`/api/v0/erp/documents/${docId}/email`, { cache: "no-store" })
      .then(async (r) => { const x = await r.json().catch(() => ({})); if (!r.ok) throw new Error(typeof x.error === "string" ? x.error : "The e-mail could not be prepared just now"); return x as Compose; })
      .then((x) => { if (gone) return; setData(x); setTo(x.to.slice(0, 1).map((s) => s.email)); setSubject(x.subject); setBody(x.body); setLink(x.acceptLink); })
      .catch((e: unknown) => { if (!gone) setError(e instanceof Error ? e.message : "The e-mail could not be prepared just now"); });
    return () => { gone = true; };
  }, [docId]);
  const extra = typed.split(/[,;\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  const wrong = extra.filter((a) => !EMAIL.test(a));
  const all = [...new Set([...to, ...extra])];
  const problem = !data ? null : wrong.length ? `“${wrong[0]}” is not an e-mail address` : !all.length ? "Choose or type the customer's e-mail address" : all.length > 5 ? "Send to at most 5 addresses at a time"
    : !subject.trim() ? "Write a subject" : body.trim().length < 2 ? "Write the message" : null;
  async function send() {
    if (busy || problem || !data) return;
    setBusy(true); setError(null);
    try {
      const r = await post<{ sent: string[]; failed: string[] }>(`erp/documents/${docId}/email`, { to: all, subject, body, acceptLink: link });
      notify({ id: "erp-email", tone: "success", title: `E-mailed to ${r.sent.join(", ")}`, message: r.failed.length ? `Not sent to ${r.failed.join(", ")}: check the address.` : "Marked sent. It is in the activity.", timeout: 6000 });
      onSent();
    } catch (e) { setError(e instanceof Error ? e.message : "Not sent"); } finally { setBusy(false); }
  }
  const toggle = (email: string, on: boolean) => setTo((x) => (on ? [...x, email] : x.filter((a) => a !== email)));
  return <Drawer title={title} context={context} size="sm" onClose={onClose} snap="full"
    footer={<DrawerFooter status={error ?? problem} primary={<button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || !data || !!problem} onClick={() => void send()}>
      <Send size={15} aria-hidden="true" />{busy ? "Sending…" : all.length > 1 ? `Send to ${all.length} addresses` : "Send"}</button>}>
      <button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={onClose} disabled={busy}>Cancel</button></DrawerFooter>}>
    {!data ? <DrawerSection title="To"><p className={css.note}>{error ? "" : "Preparing the e-mail…"}</p></DrawerSection> : <>
      <DrawerSection title="To">
        {data.to.length ? <div className={css.fields} role="group" aria-label="Send to">{data.to.map((s) => <label key={s.email} className={css.check}>
          <input type="checkbox" checked={to.includes(s.email)} onChange={(e) => toggle(s.email, e.target.checked)} />
          <span>{s.name ? `${s.name} · ` : ""}{s.email} <span className={css.note}>({say(SOURCE[s.source], words)})</span></span></label>)}</div>
          : <p className={css.note}>{say("No e-mail is saved for this {client} yet. Type it below.", words)}</p>}
        <label className={styles.field}>{data.to.length ? "Other addresses (optional)" : "E-mail address"}<input type="email" multiple value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="name@company.com, another@company.com" autoComplete="off" /></label>
      </DrawerSection>
      <DrawerSection title="Message">
        <label className={styles.field}>Subject<input value={subject} maxLength={200} onChange={(e) => setSubject(e.target.value)} /></label>
        <label className={styles.field}>Message<textarea rows={10} maxLength={8000} value={body} onChange={(e) => setBody(e.target.value)} /></label>
        <p className={css.note}><Paperclip size={12} aria-hidden="true" /> <b>{data.file}</b> is attached: the PDF exactly as filed.</p>
        {data.acceptLink ? <label className={css.check}><input type="checkbox" checked={link} onChange={(e) => setLink(e.target.checked)} />Add the link to see and accept the quotation online (an earlier unanswered link stops working)</label> : null}
        <p className={css.note}>Answers come back to {data.replyTo}. Nothing is sent until you press Send; then it is marked sent and the activity shows who sent it, when and to whom.</p>
      </DrawerSection>
      {data.sent.length ? <DrawerSection title="Sent before">
        <ul className={css.steps}>{data.sent.map((s, i) => <li key={i}>{when(s.at)}{s.by ? ` · ${s.by}` : ""} · to {(s.to ?? []).join(", ")}</li>)}</ul>
      </DrawerSection> : null}
    </>}
  </Drawer>;
}
