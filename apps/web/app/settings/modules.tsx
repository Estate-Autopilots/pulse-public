"use client";
// UX-TENANT: the organisation's own switches. Admins turn a module off when the company does not use it: it leaves the
// navigation and its pages and API answer that it is off. Attendance is the HR policy's switch (the same one HR sees).
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Building2, ChevronRight } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { AccentPicker } from "../companies/accent";
import css from "../companies/companies.module.css";
import { post } from "../records";
import { Panel, Skeleton, styles } from "../ui";
import { Switch } from "../kit";
import { ScreensSettings } from "./screens";

type Modules = { tasks: boolean; chats: boolean; finance: boolean; attendance: boolean };
const MODULES = [
  { key: "tasks", label: "Work and tasks", hint: "Tasks, asks, the pool, workflows and field forms." },
  { key: "chats", label: "Chats", hint: "Team chats and direct messages." },
  { key: "finance", label: "Finance", hint: "Finance desk, Billing (invoices, quotations, catalogue), money views." },
  { key: "attendance", label: "Attendance", hint: "Check-in, leave and the attendance month." },
] as const;

export function ModulesSettings({ operator }: { operator: boolean }) {
  const router = useRouter();
  const [data, setData] = useState<{ modules: Modules; canEdit: boolean } | null>(null), [busy, setBusy] = useState(""), [accent, setAccent] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    void fetch("/api/v0/settings/modules", { cache: "no-store" }).then((r) => r.ok ? r.json() : null).then(setData).catch(() => setData(null));
    void fetch("/api/v0/brand", { cache: "no-store" }).then((r) => r.ok ? r.json() : null).then((b) => setAccent(b?.accent ?? null)).catch(() => setAccent(null));
  }, []);
  async function change(key: keyof Modules, enabled: boolean) {
    setBusy(key);
    try { const r = await post<{ modules: Modules }>("settings/modules", { module: key, enabled }); setData((d) => d && { ...d, modules: r.modules }); notify({ id: "modules", tone: "success", title: `${MODULES.find((m) => m.key === key)?.label} ${enabled ? "on" : "off"}`, timeout: 2500 }); router.refresh(); }
    catch (e) { notify({ id: "modules", tone: "error", title: "Not changed", message: e instanceof Error ? e.message : "Try again" }); } finally { setBusy(""); }
  }
  return <div className={css.stage}>
    <Panel title="Modules" sub="What this organisation uses">
      {/* UI-POLISH-3: kit Switches; each saves at once and says so. */}
      {!data ? <ul className={css.toggles} aria-busy="true">{MODULES.map((m) => <li key={m.key}><Skeleton width="45%" /><Skeleton width={36} /></li>)}</ul> : <ul className={css.toggles}>{MODULES.map((m) => <li key={m.key}>
        <Switch label={m.label} hint={m.hint} checked={data.modules[m.key]} disabled={!data.canEdit || !!busy} onChange={(on) => void change(m.key, on)} aria-label={`${m.label} ${data.modules[m.key] ? "on" : "off"}`} states={["On", "Off"]} /></li>)}</ul>}
      <p className={styles.panelFoot}>{data?.canEdit ? "A module that is off leaves the navigation for everyone; nothing in it is deleted." : "Organisation admins change these."}</p>
    </Panel>
    {data?.canEdit ? <ScreensSettings /> : null}
    {data?.canEdit && accent !== undefined ? <Panel title="Accent colour" sub="Buttons, links and focus">
      <AccentPicker key={accent ?? "none"} value={accent} onSave={async (hex) => { await post("settings/brand-accent", { accent: hex }); setAccent(hex); router.refresh(); }} />
    </Panel> : null}
    {operator ? <Panel title="Companies on this Pulse" sub="Platform">
      <p className={css.note} style={{ paddingTop: 12 }}>Set up another company with its own address, brand, people and switches. Its people never see this organisation&apos;s data.</p>
      <p className={styles.panelFoot}><Link href="/companies" className={styles.panelAction}><Building2 size={13} aria-hidden="true" />Companies<ChevronRight size={13} aria-hidden="true" /></Link></p>
    </Panel> : null}
  </div>;
}
