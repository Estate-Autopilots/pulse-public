"use client";
// PROFILE-2 (owner, 17 Nov 2026: "share an in-app link / share the phone app link", Megud asked for the phone app link):
// one tap to share a person's page or the link to install the phone app. On a phone the system share sheet opens
// (WhatsApp, Telegram, e-mail ...); on a computer the link is copied and a toast says so.
import { Link2, Share2, Smartphone } from "lucide-react";
import { Menu } from "./kit/menu";
import { toast } from "./kit/dialogs";

async function share(url: string, title: string, text: string) {
  const nav = typeof navigator === "undefined" ? null : navigator;
  const touch = typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;
  if (nav?.share && touch) {
    try { await nav.share({ title, text, url }); return; } catch (e) { if ((e as Error)?.name === "AbortError") return; }
  }
  try { await nav?.clipboard?.writeText(url); toast.success("Link copied. Paste it in a chat or an e-mail."); }
  catch { toast.info(`Copy this link: ${url}`); }
}

/** The person's page (`path`, e.g. /people/<id>) and the phone app's install page. */
export function ShareMenu({ path, name, className, label = "Share" }: { path?: string; name?: string; className?: string; label?: string }) {
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const items = [
    ...(path && name ? [{ key: "person", label: `Share ${name.split(/\s+/)[0]}'s page`, icon: <Link2 size={15} aria-hidden="true" />,
      onSelect: () => void share(`${origin}${path}`, name, `${name} on Pulse`) }] : []),
    { key: "app", label: "Share the phone app link", icon: <Smartphone size={15} aria-hidden="true" />,
      onSelect: () => void share(`${origin}/apps/get`, "Get the phone app", "Install the phone app from this link") },
  ];
  return <Menu label={label} buttonLabel={label} title={label} className={className} items={items}>
    <Share2 size={15} aria-hidden="true" /><span>{label}</span>
  </Menu>;
}
