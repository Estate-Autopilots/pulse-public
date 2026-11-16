"use client";

// KAZUK-V2 G14 (R49, R50): a Sales Agent reminder's drafted message. "Draft ready" opens it in the kit Drawer; the
// salesperson copies it, or opens WhatsApp on their own phone with it filled in, and sends it themselves. Pulse sends
// nothing here and the agent cannot send (1932's guard).
import { useState } from "react";
import { Copy, MessageCircle, Sparkles } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { Drawer, DrawerFooter, DrawerSection } from "../kit/drawer";
import { styles } from "../ui";
import css from "./home.module.css";

export function DraftButton({ title, draft, phone }: { title: string; draft: string; phone?: string | null }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(draft);
  const digits = (phone ?? "").replace(/[^\d]/g, "");
  const wa = digits.length >= 10 ? `https://wa.me/${digits.length === 10 ? `91${digits}` : digits}?text=${encodeURIComponent(text)}` : null;
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); notify({ id: "draft", tone: "success", title: "Copied. Paste it to the client.", timeout: 2500 }); }
    catch { notify({ id: "draft", tone: "error", title: "Could not copy", message: "Select the text and copy it yourself." }); }
  };
  return <>
    <button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => setOpen(true)} aria-label={`Open the drafted message: ${title}`}><Sparkles size={14} aria-hidden="true" />Open draft</button>
    {open ? <Drawer title="Your Sales Agent's draft" context={title} icon={<Sparkles size={16} />} size="sm" onClose={() => setOpen(false)}
      footer={<DrawerFooter tone="info" status="You send it. The agent never sends anything."
        primary={<button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => void copy()}><Copy size={14} aria-hidden="true" />Copy the message</button>}>
        {wa ? <a className={`${styles.btn} ${styles.btnGhost}`} href={wa} target="_blank" rel="noreferrer"><MessageCircle size={14} aria-hidden="true" />Open in WhatsApp</a> : null}
      </DrawerFooter>}>
      <DrawerSection title="Message" help="Change anything you like before you send it.">
        <textarea className={css.draft} value={text} onChange={(e) => setText(e.target.value)} rows={7} aria-label="Drafted message" />
      </DrawerSection>
    </Drawer> : null}
  </>;
}
