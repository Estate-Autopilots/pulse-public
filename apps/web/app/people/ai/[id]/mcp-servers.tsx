"use client";
// AI-AGENTS-2 (owner, 17 Nov 2026: "MCP server addition is a plain text box"): the MCP servers an AI employee may use are
// the company's connectors (Settings → Connectors, CONNECTORS-CONTRACTS 1584): each added there with its address, its
// sign-in (OAuth or a token) and a check that reads its tools, then opened to AI employees all together or by name. Its
// profile shows each server with its state and tools, and an admin switches one on or off for this AI employee here
// (the connector's own "AI employees" list, the one rule its calls are checked against). "Add an MCP server" opens the
// guided form in Settings → Connectors. Nothing is typed by hand any more.
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { CircleAlert, LoaderCircle, Plug, Plus } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { post } from "../../../records";
import { styles } from "../../../ui";
import css from "./profile.module.css";

type Connector = { id: string; label: string; url: string; authKind: "oauth" | "bearer" | "none"; status: string; tools: { name: string }[]; enabledTools: string[];
  aiAccess: "none" | "chosen" | "all"; aiAgents: string[]; lastError: string | null };
const STATUS: Record<string, string> = { connected: "Ready", needs_auth: "Needs sign-in", error: "Needs attention", off: "Switched off" };
const host = (u: string) => { try { return new URL(u).host; } catch { return u; } };

export function AiMcpServers({ id, name }: { id: string; name: string }) {
  const [list, setList] = useState<Connector[] | null>(null), [state, setState] = useState<"loading" | "ok" | "denied" | "error">("loading");
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(() => fetch("/api/v0/mcp-connectors", { cache: "no-store" }).then(async (r) => {
    if (r.status === 401 || r.status === 403) { setState("denied"); return; }
    if (!r.ok) { setState("error"); return; }
    const d = await r.json() as { connectors?: Connector[] }; setList(d.connectors ?? []); setState("ok");
  }).catch(() => setState("error")), []);
  useEffect(() => { void load(); }, [load]);
  const may = (k: Connector) => k.aiAccess === "all" || (k.aiAccess === "chosen" && k.aiAgents.includes(id));
  async function flip(k: Connector, on: boolean) {
    setBusy(k.id);
    // "All AI employees" stays as it is when switched on; switched off for this one, the others keep it (chosen = the rest).
    const others = k.aiAccess === "all" ? null : k.aiAgents.filter((x) => x !== id);
    const body = on ? { aiAccess: k.aiAccess === "all" ? "all" : "chosen", aiAgents: [...new Set([...k.aiAgents, id])] }
      : k.aiAccess === "all" ? null : { aiAccess: others && others.length ? "chosen" : "none", aiAgents: others ?? [] };
    if (!body) { setBusy(null); notify({ id: "ai-mcp", tone: "info", title: "Open to every AI employee", message: `${k.label} is open to all AI employees. Choose who may use it in Settings → Connectors.` }); return; }
    try { await post(`mcp-connectors/${k.id}`, body); notify({ id: "ai-mcp", tone: "success", title: on ? `${name} may use ${k.label}` : `${k.label} is off for ${name}`, timeout: 2600 }); await load(); }
    catch (e) { notify({ id: "ai-mcp", tone: "error", title: "Not changed", message: (e as Error).message }); }
    finally { setBusy(null); }
  }
  return <div className={css.fieldGroup} data-ai-mcp="">
    <div className={css.groupHead}><span><Plug size={14} aria-hidden="true" /> Other apps it may use</span>
      {state === "ok" ? <Link className={`${styles.btn} ${styles.btnSmall}`} href="/settings?tab=connectors"><Plus size={14} aria-hidden="true" />Add an app</Link> : null}</div>
    {state === "loading" ? <p className={css.note} role="status"><LoaderCircle size={14} className={css.spin} aria-hidden="true" />Loading the company’s apps…</p>
      : state === "denied" ? <p className={css.note}><CircleAlert size={14} aria-hidden="true" />Company admins add apps and choose which AI employees use them (Settings → Connectors).</p>
      : state === "error" || !list ? <p className={css.note} role="alert"><CircleAlert size={14} aria-hidden="true" />The apps did not load.
        <button type="button" className={`${styles.btn} ${styles.btnGhost} ${styles.btnSmall}`} onClick={() => { setState("loading"); void load(); }}>Try again</button></p>
      : !list.length ? <p className={css.note}>No other app is connected yet.</p>
      : <ul className={css.toolList}>{list.map((k) => { const on = may(k), ready = k.status === "connected";
        return <li key={k.id}><label>
          <span><b>{k.label}</b><small>{host(k.url)} · {STATUS[k.status] ?? k.status}{ready ? ` · ${k.enabledTools.length} of ${k.tools.length} tools on` : k.lastError ? ` · ${k.lastError}` : ""}{k.aiAccess === "all" ? " · open to every AI employee" : ""}</small></span>
          {!ready ? <em className={css.tag}>{STATUS[k.status] ?? "Not ready"}</em> : null}
          <input type="checkbox" role="switch" className={css.switch} checked={on} disabled={busy === k.id} aria-label={`${name} may use ${k.label}`} onChange={(e) => void flip(k, e.target.checked)} />
        </label></li>; })}</ul>}
    <small className={css.help}>Apps that work with AI (MCP servers). It uses only the tools an admin switched on, and asks first before changing anything there.</small>
  </div>;
}
