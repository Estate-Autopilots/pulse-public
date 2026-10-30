import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { getMe, holdAtGate } from "./lib/api";

export const dynamic = "force-dynamic";

/** CHAT-SHELL (owner, 22 Oct 2026): on a desktop Pulse opens on the chat, the place to work and manage tasks; a person
 *  who chose the dashboard ("Use the dashboard as my home" on the chat's home, cookie pulse.home.start=dashboard), a
 *  phone, the Accountant and a company with Chats switched off open on the dashboard as before. The query is carried. */
export default async function Root({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const q = new URLSearchParams(await searchParams).toString();
  const me = (await getMe()).data;
  // STAFF-UX: held at the profile gate, straight to it (no dashboard render whose calls all answer 403).
  await holdAtGate();
  // CLIENT-PORTAL: a client's seat opens on their own home.
  if (me?.side === "client" && !me.mustChange) redirect(`/client${q ? `?${q}` : ""}`);
  const ua = (await headers()).get("user-agent") ?? "";
  const phone = /Mobi|Android|iPhone|iPad|PulseShell/i.test(ua);
  const chat = !!me?.person && !me.mustChange && me.role !== "accountant" && !me.modules?.off?.includes("chats") && !phone
    && (await cookies()).get("pulse.home.start")?.value !== "dashboard";
  redirect(`${chat ? "/chats" : "/dashboard"}${q ? `?${q}` : ""}`);
}
