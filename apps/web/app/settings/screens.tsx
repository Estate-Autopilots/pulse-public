"use client";
// EST-1420: Settings → Modules → Screens and menu. An admin picks a role and shows or hides each screen on that role's
// rail; Dashboard, Chats, My desk and the HR desk always stay (owner, 18 Oct). A hidden screen leaves the rail, the phone
// tabs and the palettes, and a direct link shows "Hidden by your admin". Nothing is deleted and no permission changes.
// Every switch saves at once (the API keeps the list per role; services/api/src/screens.ts). EST-1241: the same panel
// picks each role's home: the usual Dashboard or the sales home (an HR-only account keeps its own).
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { notify, shellNav } from "@pulse/ui-shell";
import { Segmented, Switch } from "../kit";
import css from "../companies/companies.module.css";
import { post } from "../records";
import { Panel, Skeleton, styles } from "../ui";

type Home = "dashboard" | "sales";
type Choice = { screens: { key: string; href: string; fixed: boolean }[]; roles: string[]; newScreensHidden: boolean; hidden: Record<string, string[]>; home?: Record<string, Home>; canEdit: boolean };
const HOMES: { value: Home; label: string }[] = [{ value: "dashboard", label: "Dashboard" }, { value: "sales", label: "Sales home" }];
type Role = "person" | "manager" | "pgs" | "finance" | "hr" | "leadership" | "admin";
// Each role and the rail the shell draws for it (layout.tsx's role labels).
const ROLES: { value: Role; label: string; shell: string }[] = [
  { value: "person", label: "Member", shell: "Member" },
  { value: "manager", label: "Manager", shell: "Manager / PGS" },
  { value: "pgs", label: "PGS", shell: "Manager / PGS" },
  { value: "finance", label: "Finance", shell: "Finance" },
  { value: "hr", label: "HR", shell: "HR" },
  { value: "leadership", label: "Leadership", shell: "Leadership" },
  { value: "admin", label: "Owner / admin", shell: "Organisation owner/admin" },
];

export function ScreensSettings() {
  const router = useRouter();
  const [data, setData] = useState<Choice | null | undefined>(undefined), [role, setRole] = useState<Role>("person"), [busy, setBusy] = useState("");
  useEffect(() => { void fetch("/api/v0/settings/screens", { cache: "no-store" }).then((r) => r.ok ? r.json() : null).then(setData).catch(() => setData(null)); }, []);
  const who = ROLES.find((r) => r.value === role)!;
  // The role's own rail, as the shell draws it, matched to the server's screens by address.
  const rows = useMemo(() => data ? shellNav(who.shell).pages.flatMap((page) => {
    const screen = data.screens.find((s) => s.href === page.href);
    return screen ? [{ ...screen, label: page.label, Icon: page.Icon }] : [];
  }) : [], [data, who.shell]);
  async function save(next: Pick<Choice, "newScreensHidden" | "hidden" | "home">, key: string, title: string) {
    setBusy(key);
    // EST-1420 P2: the viewer's own rail, tabs and palette follow at once (the root layout reads the choice).
    try { setData(await post<Choice>("settings/screens", next)); notify({ id: "screens", tone: "success", title, timeout: 2500 }); router.refresh(); }
    catch (e) { notify({ id: "screens", tone: "error", title: "Not changed", message: e instanceof Error ? e.message : "Try again" }); } finally { setBusy(""); }
  }
  const show = (key: string, label: string, on: boolean) => {
    if (!data) return;
    const list = data.hidden[role] ?? [];
    void save({ newScreensHidden: data.newScreensHidden, hidden: { ...data.hidden, [role]: on ? list.filter((k) => k !== key) : [...list, key] } }, key, `${label} ${on ? "shown" : "hidden"} for ${who.label}`);
  };
  return <Panel title="Screens and menu" sub="What each role sees">
    {data === undefined ? <ul className={css.toggles} aria-busy="true">{[0, 1, 2, 3].map((i) => <li key={i}><Skeleton width="40%" /><Skeleton width={56} /></li>)}</ul>
      : data === null ? <p className={css.note} style={{ paddingTop: 12 }}>The screen choices could not be loaded. Reload the page to try again.</p>
      : <>
        <div style={{ padding: "12px 14px 4px", minWidth: 0 }}><Segmented label="Role" size="sm" value={role} onChange={setRole} options={ROLES.map(({ value, label }) => ({ value, label, count: (data.hidden[value] ?? []).length || undefined }))} /></div>
        {role !== "hr" && data.home ? <div style={{ padding: "8px 14px 4px", minWidth: 0 }}>
          <Segmented label={`Home screen for ${who.label}`} size="sm" value={data.home[role] ?? "dashboard"} options={HOMES}
            onChange={(home: Home) => { if (!busy && data.canEdit && home !== (data.home?.[role] ?? "dashboard")) void save({ newScreensHidden: data.newScreensHidden, hidden: data.hidden, home: { ...data.home, [role]: home } }, "home", `Home screen for ${who.label}: ${home === "sales" ? "Sales home" : "Dashboard"}`); }} />
        </div> : null}
        {/* UI-POLISH-3: kit Switches; each saves at once and says so. */}
        <ul className={css.toggles}>{rows.map((s) => { const on = s.fixed || !(data.hidden[role] ?? []).includes(s.key); return <li key={s.key}>
          <Switch label={<><s.Icon size={14} aria-hidden="true" style={{ verticalAlign: "-2px", marginRight: 6 }} />{s.label}</>} hint={s.fixed ? "Always shown" : undefined} checked={on} disabled={s.fixed || !data.canEdit || !!busy}
            onChange={(next) => show(s.key, s.label, next)} aria-label={`${s.label} for ${who.label}: ${on ? "shown" : "hidden"}`} states={["Shown", "Hidden"]} />
        </li>; })}
          <li><Switch label="New screens start hidden" hint="Screens that arrive in later updates stay out of every role’s menu until you show them here." checked={data.newScreensHidden} disabled={!data.canEdit || !!busy}
            onChange={(on) => void save({ newScreensHidden: on, hidden: data.hidden }, "new", `New screens ${on ? "start hidden" : "start shown"}`)} aria-label={`New screens start hidden: ${data.newScreensHidden ? "on" : "off"}`} states={["On", "Off"]} /></li>
        </ul>
      </>}
    <p className={styles.panelFoot}>A hidden screen leaves this role&apos;s menu; a direct link says it is hidden by an admin. Nothing is deleted and nobody&apos;s access changes.</p>
  </Panel>;
}
