import { getMe } from "../../lib/api";
import { Message } from "../../ui";
import { DataReviewView } from "./view";

export const dynamic = "force-dynamic";
export const metadata = { title: "Data review" };

/** FIX-CHAT-AI (owner walkthrough, 10 Nov 2026: "WhatsApp signals, imports, check notes and voice-note transcripts belong
 *  in a separate Data review area, not inside chat"): one place for what Pulse read out of the company's WhatsApp
 *  history and imports, so Chats stays a place to talk. Each row opens the page that already does the work.
 *  VISUAL-QA: drawn by view.tsx on the client (the game kit is a client component; icons cannot be passed to it from here). */
export default async function DataReview() {
  const me = await getMe();
  if (!me.data?.person) return <Message text="Data review needs your own employee account." />;
  const role = me.data.role;
  const importOn = !(me.data.modules?.off ?? []).includes("chat_import");
  return <DataReviewView leads={role === "admin" || role === "leadership"} canImport={role === "admin" && importOn} />;
}
