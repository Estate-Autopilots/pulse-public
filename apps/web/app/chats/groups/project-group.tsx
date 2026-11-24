"use client";
// CHAT-GROUPS (owner report EA #4: "a project's group shows on the project page"): one button that opens the project's
// team chat. The database reuses the team chat already linked to the project and makes one (in Projects, with the lead
// and the people the plan names) only when there is none, so a project never gets a second group (2530).
import { useRouter } from "next/navigation";
import { useState } from "react";
import { MessageCirclePlus } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { send } from "../net";

export function ProjectGroupButton({ projectId, className, label = "Start the project's team chat" }: { projectId: string; className?: string; label?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function go() {
    if (busy) return; setBusy(true);
    try {
      const r = await send<{ id: string; name: string; made: boolean }>(`projects/${projectId}/group`);
      notify({ id: `project-group-${projectId}`, tone: "success", title: r.made ? `Made: ${r.name}` : `Opening ${r.name}`, message: r.made ? "Linked to this project, filed under Projects." : "This project's team chat already exists.", timeout: 4000 });
      router.push(`/chats?channel=${r.id}`);
    } catch (e) {
      notify({ id: `project-group-${projectId}`, tone: "error", title: "The team chat did not open", message: (e as Error).message, timeout: 8000 });
      setBusy(false);
    }
  }
  return <button type="button" className={className} onClick={() => void go()} disabled={busy} data-project-group="">
    <MessageCirclePlus size={14} aria-hidden="true" />{busy ? "Opening…" : label}</button>;
}
