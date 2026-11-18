"use client";
// AGENTS-LIVE (owner, 7 Nov 2026): "Activate <AI employee> for this discussion / for tasks? Allow". One small question
// wherever an AI employee is called where it is not on yet (a chat @mention, a task's discussion, a task given to it):
// Allow switches it on when it is off, gives it what the place needs and brings it in (POST agents/:id/activate; the
// database decides who may). Nothing changes until Allow.
import { useEffect, useState } from "react";
import { Bot } from "lucide-react";
import css from "./agent-activate.module.css";

export type ReachAgent = { id: string; name: string; username: string | null; employeeId: string; title: string; state: "on" | "paused" | "off";
  pausedReason: string | null; runtime: string; inChat: boolean; canCall: boolean; canTask: boolean; canAdd: boolean; canSwitch: boolean; tools: string[] };

/** Who the viewer can call (every AI employee of the company, its state and whether it is in `channel`). */
export async function loadReach(channel?: string | null): Promise<ReachAgent[]> {
  const r = await fetch(`/api/v0/agents/reach${channel ? `?channel=${encodeURIComponent(channel)}` : ""}`, { cache: "no-store" }).catch(() => null);
  if (!r?.ok) return [];
  return ((await r.json()) as { agents?: ReachAgent[] }).agents ?? [];
}

export async function activateAgent(id: string, place: { channelId?: string | null; for: "chat" | "tasks" }) {
  const r = await fetch(`/api/v0/agents/${encodeURIComponent(id)}/activate`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ for: place.for, ...(place.channelId ? { channelId: place.channelId } : {}) }) });
  const d = await r.json().catch(() => ({})) as { error?: string; agent?: ReachAgent };
  if (!r.ok) throw new Error(d.error ?? "It could not be activated. Try again.");
  return d.agent ?? null;
}

const first = (n: string) => n.replace(/\s*\(AI\)\s*$/, "");

/** The question. `where`: "this discussion", "tasks", or a conversation's name. Allow runs `onAllow` (which activates). */
export function ActivateAgent({ agents, where, onAllow, onCancel }: { agents: { id: string; name: string; state?: string }[]; where: string;
  onAllow: () => Promise<void>; onCancel: () => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onCancel(); }; document.addEventListener("keydown", k); return () => document.removeEventListener("keydown", k); }, [busy, onCancel]);
  const names = agents.map((a) => first(a.name)).join(" and ");
  const off = agents.some((a) => a.state && a.state !== "on");
  async function allow() { setBusy(true); setError(""); try { await onAllow(); } catch (e) { setError((e as Error).message); setBusy(false); } }
  return <div className={css.backdrop} onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onCancel(); }}>
    <div className={css.dialog} role="alertdialog" aria-modal="true" aria-labelledby="agent-activate-title" data-agent-activate="">
      <h2 id="agent-activate-title"><Bot size={18} aria-hidden="true" />Activate {names} for {where}?</h2>
      <p>{off ? `${agents.length > 1 ? "They are" : "It is"} switched off now. Allow switches ${agents.length > 1 ? "them" : "it"} on and ` : "Allow "}
        {where === "tasks" ? "lets it take this task." : `adds ${agents.length > 1 ? "them" : "it"} here so ${agents.length > 1 ? "they answer" : "it answers"}.`}</p>
      {error ? <p className={css.error} role="alert">{error}</p> : null}
      <footer><button type="button" className={css.secondary} onClick={onCancel} disabled={busy} autoFocus>Not now</button>
        <button type="button" className={css.primary} onClick={() => void allow()} disabled={busy}>{busy ? "Activating…" : "Allow"}</button></footer>
    </div></div>;
}
