"use client";
// STAFF-UX (owner, 28 Oct 2026: "on a person's page, message and call them straight from the top"): Message opens (or
// starts) the direct chat with them; Call rings them in Pulse from that chat, or, when their work phone is shown to the
// viewer, offers the phone too. Someone's own page and a left colleague show neither.
import { useRouter } from "next/navigation";
import { useState } from "react";
import { MessageSquare, Phone, PhoneCall } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { startCall } from "../../calls/call-host";
import { Menu } from "../../kit";
import { post } from "../../records";
import { styles } from "../../ui";
import css from "../people.module.css";

const reason = (e: unknown) => e instanceof Error ? e.message : "Try again in a moment.";

export function ReachActions({ personId, name, phone, canCall = true }: { personId: string; name: string; phone?: string | null; canCall?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<"chat" | "call" | null>(null);
  const first = name.split(/\s+/)[0] || name;
  const direct = async () => (await post<{ id: string }>("chats/direct", { personId })).id;
  const message = async () => {
    setBusy("chat");
    try { router.push(`/chats?channel=${encodeURIComponent(await direct())}`); }
    catch (e) { notify({ id: "reach", tone: "error", title: `Couldn’t open a chat with ${first}`, message: reason(e) }); setBusy(null); }
  };
  const ring = async () => {
    setBusy("call");
    try { startCall(await direct(), false); }
    catch (e) { notify({ id: "reach", tone: "error", title: `Couldn’t call ${first}`, message: reason(e) }); }
    finally { setBusy(null); }
  };
  const tel = phone ? `tel:${phone.replace(/[^\d+]/g, "")}` : null;
  return <span className={css.reach} role="group" aria-label={`Reach ${first}`}>
    <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={!!busy} aria-busy={busy === "chat" || undefined} onClick={() => void message()}>
      <MessageSquare size={15} aria-hidden="true" />Message</button>
    {canCall && tel ? <Menu label={`Call ${first}`} buttonLabel={`Call ${first}`} title={`Call ${first}`} className={styles.btn} items={[
      { key: "pulse", label: "Call in Pulse", hint: "Rings them in the app", icon: <PhoneCall size={15} aria-hidden="true" />, onSelect: () => void ring() },
      { key: "phone", label: `Phone ${phone}`, hint: "Their work phone", icon: <Phone size={15} aria-hidden="true" />, href: tel }]}>
      <Phone size={15} aria-hidden="true" />Call</Menu>
      : canCall ? <button type="button" className={styles.btn} disabled={!!busy} aria-busy={busy === "call" || undefined} onClick={() => void ring()} aria-label={`Call ${first} in Pulse`}><Phone size={15} aria-hidden="true" />Call</button>
      : tel ? <a className={styles.btn} href={tel} aria-label={`Phone ${first}`}><Phone size={15} aria-hidden="true" />Call</a> : null}
  </span>;
}
