"use client";
// FLOW-E: in a step's side sheet, the app a kind of step uses (Sales X-Ray, Google Drive, Gmail, Webhooks …): what it
// needs and gives back, whether it is connected for this company or person, and a Connect button. A Start "another app
// sends it in" makes the process's own address here (shown once; making a new one stops the old).
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Copy, ExternalLink, Link2 } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { flow, why } from "../flow-client";
import css from "./builder.module.css";

export type AppView = { key: string; name: string; maker: string; summary: string; actions: { key: string; name: string; block: string; kind: string; needs: string; gives: string }[];
  status: { state: "connected" | "not_connected" | "built_in" | "partial" | "off"; text: string; connect?: { label: string; href?: string; action?: string } | null } };
let apps: Promise<AppView[]> | null = null;
/** The company's apps, read once per page (statuses change rarely while a process is being built). */
export const loadApps = () => (apps ??= flow<{ apps: AppView[] }>("apps").then((r) => r.apps).catch(() => { apps = null; return []; }));
export const STATE_WORD: Record<AppView["status"]["state"], string> = { connected: "Connected", not_connected: "Not connected", built_in: "Built in", partial: "Partly", off: "Off" };

export function AppLine({ block, kind, stepId, readOnly }: { block: string; kind: string; stepId: string; readOnly: boolean }) {
  const [list, setList] = useState<AppView[] | null>(null);
  useEffect(() => { let on = true; void loadApps().then((x) => { if (on) setList(x); }); return () => { on = false; }; }, []);
  const app = list?.find((x) => x.actions.some((y) => y.block === block && y.kind === kind));
  const action = app?.actions.find((y) => y.block === block && y.kind === kind);
  if (!app || !action) return null;
  return <div className={css.appLine} data-state={app.status.state} aria-label={`App: ${app.name}`}>
    <div className={css.appTop}><b>{app.name}</b><span className={css.appState}>{STATE_WORD[app.status.state]}</span>
      {app.status.connect?.href && app.status.state !== "connected" && app.status.state !== "built_in" ? <Link href={app.status.connect.href} className={css.appConnect}><ExternalLink size={12} aria-hidden="true" />{app.status.connect.label}</Link>
        : app.status.connect?.action ? <Link href="/settings?tab=apps" className={css.appConnect}>{app.status.connect.label}</Link> : null}</div>
    <p>{app.status.text}</p>
    <dl><dt>Needs</dt><dd>{action.needs}</dd><dt>Gives back</dt><dd>{action.gives}</dd></dl>
    {block === "start" && kind === "webhook" ? <HookAddress stepId={stepId} readOnly={readOnly} /> : null}
  </div>;
}

function HookAddress({ stepId, readOnly }: { stepId: string; readOnly: boolean }) {
  const { id } = useParams<{ id: string }>();
  const [url, setUrl] = useState<string | null>(null), [busy, setBusy] = useState(false);
  async function make() {
    setBusy(true);
    try { const r = await flow<{ path: string }>(`processes/${id}/hook`, "POST", { step: stepId }); setUrl(`${window.location.origin}${r.path}`); }
    catch (e) { notify({ id: "hook", tone: "error", title: "No address made", message: why(e) }); } finally { setBusy(false); }
  }
  return <div className={css.hook}>
    {url ? <><code>{url}</code><button type="button" onClick={() => void navigator.clipboard.writeText(url).then(() => notify({ id: "hook", tone: "success", title: "Copied", timeout: 2000 }))}><Copy size={12} aria-hidden="true" />Copy</button>
      <small>Shown once. The other app posts JSON here; each post starts a run (when the process is live) with what it sent.</small></>
      : readOnly ? null : <button type="button" disabled={busy} onClick={() => void make()}><Link2 size={12} aria-hidden="true" />{busy ? "Making…" : "Make this process’s address"}</button>}
  </div>;
}
