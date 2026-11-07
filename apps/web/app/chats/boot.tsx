"use client";
import { useSearchParams } from "next/navigation";
import { ChatsApp } from "./app";
import { EmailApp } from "./email";
/** The loading state of /chats is the app itself, drawn from the local cache, with no requests of its own. */
export function ChatsBoot() {
  return useSearchParams().get("source") === "email" ? <EmailApp initial={null} /> : <ChatsApp initial={null} boot />;
}
