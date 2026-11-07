// UX-SETTINGS-CHAT (owner, 5 Nov 2026: "many panels ugly, confusing and stupid"): the Settings home, in My day's
// language. A header with the company and four tiles; "Start with" names what needs an admin now (password requests,
// people who cannot sign in, leaders without two-step, a setup not finished); then one card per area, each section a
// stripe card with one plain line; a quiet rail holds the person's own account and theme. Admins used to land on the
// sign-in table and members on a heap of cards; everyone now starts here and goes one tap in.
import type { LucideIcon } from "lucide-react";
import { Activity, Bell, Briefcase, Building2, Cable, HardDrive, KeyRound, LayoutGrid, ListChecks, Lock, LogIn, Mail, MessagesSquare, Monitor, Palette, Plug, RefreshCw, Server, ShieldCheck, Smartphone, Sparkles, Terminal, UserRound, Users } from "lucide-react";
import { CalmGrid, CalmPage, Card, Facts, PageHeader, Quiet, RailLinks, SectionHeader, StartWith, StatTile, StatTiles, StripeCard, StripeList, type Pick } from "../components/page-kit";
import type { Me } from "../lib/api";
import { ThemeChips } from "./appearance";
import { areasFor } from "./nav";
import { TAB_TEXT as TEXT, type AccessData, type TabKey } from "./types";
import { Say } from "../kit/word";

const TAB_ICON: Record<TabKey, LucideIcon> = {
  account: UserRound, notifications: Bell, appearance: Palette, privacy: Lock, devices: Smartphone, "connected-apps": KeyRound, "api-keys": Terminal,
  organisation: Building2, industry: Briefcase, "sign-in": LogIn, "work-rules": ListChecks, roles: ShieldCheck, team: Users, chats: MessagesSquare,
  apps: LayoutGrid, connectors: Cable, ai: Sparkles, servers: Server, mail: Mail, connected: RefreshCw, "data-health": Activity, "desktop-app": Monitor,
};
const AREA_ICON: Record<string, LucideIcon> = { you: UserRound, organisation: Building2, access: ShieldCheck, connections: Plug, data: HardDrive };
const IN_RAIL = new Set<TabKey>(["account", "appearance", "privacy"]);
const NO_SIGN_IN = ["not invited", "invited", "link expired", "locked"];
const LEADS = new Set(["admin", "hr", "leadership"]);
const ROLE: Record<string, string> = { admin: "Organisation admin", hr: "HR", leadership: "Leadership", finance: "Finance", manager: "Manager", member: "Member", person: "Member", accountant: "Accountant" };
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function SettingsHome({ me, available, access, setupTrial }: { me: Me; available: readonly { key: TabKey; label: string }[]; access: AccessData | null; setupTrial: boolean }) {
  // The rail holds the person's account, theme and privacy, so the You area lists only the rest (each shows once).
  const areas = areasFor(available.filter((t) => !IN_RAIL.has(t.key)));
  const people = access?.people ?? [];
  const pending = (access?.requests ?? []).filter((r) => r.status === "pending").length;
  const cannot = people.filter((p) => NO_SIGN_IN.includes(p.authStatus ?? "not invited")).length;
  const active = people.filter((p) => p.authStatus === "active").length;
  const leadsNoTwoStep = people.filter((p) => LEADS.has(p.role) && p.authStatus === "active" && !p.twoStep).length;
  const org = me.orgName ?? "Your company";
  const role = ROLE[me.role] ?? me.role;

  const picks: Pick[] = [];
  if (access) {
    if (pending) picks.push({ key: "requests", title: `${plural(pending, "password request")} waiting`, sub: "Someone cannot sign in until you answer", href: "/settings?tab=sign-in", stripe: 265 });
    if (cannot) picks.push({ key: "cannot", title: `${plural(cannot, "person", "people")} cannot sign in yet`, sub: "Send their invitations, or a fresh link", href: "/settings?tab=sign-in", stripe: 265 });
    if (leadsNoTwoStep) picks.push({ key: "two-step", title: `${plural(leadsNoTwoStep, "leader")} without two-step`, sub: "Admins, HR and leadership see the most; ask for two-step", href: "/settings?tab=sign-in", stripe: 265 });
  }
  if (setupTrial) picks.unshift({ key: "setup", title: `Finish setting up ${org}`, sub: "The setup checklist, while the company is on trial", href: "/settings?tab=organisation", stripe: 172 });

  const stats = access
    ? <StatTiles count={4} label="Sign-in at a glance">
        <StatTile label="People" value={people.length} href="/settings?tab=sign-in" />
        <StatTile label="Can sign in" value={active} tone={people.length && active === people.length ? "good" : undefined} href="/settings?tab=sign-in" />
        <StatTile label="Cannot yet" value={cannot} tone={cannot ? "warn" : undefined} href="/settings?tab=sign-in" />
        <StatTile label="Requests" value={pending} tone={pending ? "bad" : undefined} href="/settings?tab=sign-in" />
      </StatTiles>
    : <StatTiles count={3} label="You at a glance">
        <StatTile label="Role" value={role} />
        <StatTile label="Team" value={me.pod ?? "None yet"} />
        <StatTile label="Signs in with" value={me.via === "password" ? "Password" : "Google"} />
      </StatTiles>;

  return <CalmPage>
    <PageHeader eyebrow={<>{org} · {role}</>} title="Settings" lede={access ? "Everything about the company and how people get in, one tap from here." : "Your account, notifications and how Pulse looks, one tap from here."} stats={stats} />
    <CalmGrid railLabel="Your account" rail={<>
      <Card label="Your account" area="account">
        <SectionHeader icon={UserRound} title="Your account" />
        <Facts items={[["Name", me.name ?? "—"], ["Username", me.username ?? "—"], ["Signs in with", me.via === "password" ? "A Pulse password" : "The company Google account"]]} />
        <RailLinks links={[{ href: "/settings?tab=account", label: "Account details" }, ...(me.via === "password" ? [{ href: "/login?change=own", label: "Change your password" }] : []), { href: "/settings?tab=devices", label: "Get the apps" }]} />
      </Card>
      <Card label="Appearance" area="appearance">
        <SectionHeader icon={Palette} title="Appearance" note="this device" />
        <ThemeChips />
      </Card>
      <Card label="Privacy" area="privacy">
        <SectionHeader icon={Lock} title="Privacy" />
        <Quiet>Pulse measures taps and load times to get faster. It never records what you type, your messages, files or passwords.</Quiet>
        <RailLinks links={[{ href: "/settings?tab=privacy", label: "What is measured" }]} />
      </Card>
    </>}>
      <StartWith picks={picks} icon={Sparkles} />
      {areas.map((a) => <section key={a.key} aria-label={a.label} data-settings-area={a.key} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <SectionHeader icon={AREA_ICON[a.key]} title={a.label} note={plural(a.sections.length, "section")} />
        <StripeList columns={2}>{a.sections.map((t) => <StripeCard key={t.key} href={`/settings?tab=${t.key}`} icon={TAB_ICON[t.key]} stripe={a.hue} title={t.label} text={<Say t={TEXT[t.key]} />}
          badge={t.key === "sign-in" && pending ? { label: `${pending} waiting`, tone: "bad" } : t.key === "sign-in" && cannot ? { label: `${cannot} cannot sign in`, tone: "warn" } : undefined} />)}</StripeList>
      </section>)}
    </CalmGrid>
  </CalmPage>;
}
