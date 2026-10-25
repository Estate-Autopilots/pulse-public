import "@pulse/design-system/tokens.css";
import "@pulse/design-system/scale.css";
import { AppDs } from "./ds-provider";
import "@pulse/ui-shell/styles.css";
import "./globals.css";
import "./round11.css";
import "@pulse/companion/pip.css";
import "@pulse/companion/panel.css";
import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { Suspense, type ReactNode } from "react";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { PulseShell, pathSwitchedOff } from "@pulse/ui-shell";
import { portalApi } from "./portal/api";
import { ClientLogin,ClientSignOut } from "./portal/login-form";
import portalCss from "./portal/portal.module.css";
import { LoginForm } from "./login/form";
import { InsightsMenuItem, IntelligenceRail } from "./intelligence/rail";
import { AppFeel } from "./fit";
import { DataPulse } from "./data-pulse";
import { BrowserPings } from "./browser-pings";
import { CallHost } from "./calls/call-host";
import { InboxBell } from "./inbox-bell";
import { ReviewChip } from "./tasks/review-chip";
import { PipIsland } from "./notify/island";
import { CreateHost } from "./create";
import { PresencePoller } from "./presence";
import { CheckinChip } from "./checkin-chip";
import { CommandPalette } from "./search/palette";
import { KeyboardWatch } from "./keyboard";
import { ShellBridge } from "./shell-bridge";
import { Spotlight } from "./destinations/go";
import { TaskCompanion } from "./tasks/companion";
import { ChatDock } from "./chats/dock";
import { shellFromUserAgent } from "./lib/native-shell";
import { CF_ACCESS_EMAIL_HEADER, resolveAccountIdentity } from "./lib/account-identity";
import { api, getMe, type Me } from "./lib/api";
import { accentCss, orgLogo } from "./lib/brand";
import { readBrand } from "./lib/brand-server";
import { OrgCodeProvider } from "./org-code";
import { FALLBACK_ZONE } from "./lib/zone.mjs";
import { hiddenRedirect, underBase } from "./lib/screens.mjs";
import { navFor, roleLabelFor } from "./lib/nav";
import { HiddenGate } from "./hidden/gate";
import { hostMode, requestHost } from "./lib/host-mode.mjs";
import { getBranding } from "./lib/branding";
import { organizationDisplayName } from "./lib/branding-name";
import { newestUpdate } from "./updates/data";
import { drawsCalmHome } from "./home/focus";
import { OrgSwitcher, OrgsMenuItem } from "./orgs/switcher";
import { kindLabel } from "./orgs/labels";
import { EmailGuard } from "./email-guard";
import { TelemetryHost } from "./telemetry-host";
import { TelemetryNotice } from "./telemetry-notice";
import { telemetryRelease } from "./lib/telemetry-release";

// RELEASE-5: Inter is preloaded with a size-matched fallback (next/font), so a first visit no longer re-wraps text when
// the font arrives after the first paint (UX-5A's layout-shift gate measured up to 0.17 on phones). The stacks read
// --font-inter (design-system tokens, the shell, the companion panel).
const inter = localFont({ src: "./fonts/InterVariable.woff2", weight: "100 900", display: "swap", variable: "--font-inter", adjustFontFallback: "Arial" });

// UX-TENANT: the title names the company whose address this is; on the install's own addresses, the signed-in
// organisation or the install's name (EST-655), and plain "Pulse" for a bare install.
export async function generateMetadata(): Promise<Metadata> {
  if ((await headers()).get('x-pulse-path') === '/developers') return { title: 'Pulse Developers · API v1' };
  const own = (await hostMode(requestHost(await headers()))).name;
  const name = organizationDisplayName((await getMe()).data?.orgName) ?? organizationDisplayName(own) ?? organizationDisplayName((await getBranding()).name);
  return {
    title: name ? `Pulse · ${name}` : "Pulse",
    description: name ? `Deliveries, projects and people at ${name}, with the evidence behind each number.` : "Deliveries, projects and people, with the evidence behind each number.",
  };
}

// Phones: draw under the status and navigation bars; the frame pads itself with the safe areas.
// E2E-4P: an on-screen keyboard shrinks the page (Android Chrome), so composers and sheets stay above it (keyboard.tsx).
export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover", interactiveWidget: "resizes-content",
  themeColor: [{ media: "(prefers-color-scheme: light)", color: "#f6f6fa" }, { media: "(prefers-color-scheme: dark)", color: "#121219" }] };

/** Public install pages and the client portal work without a staff sign-in. */
const OPEN = /^\/(apps|portal|accept|offer|developers)(\/|$)/;

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  const path=(await headers()).get('x-pulse-path')??'';
  // Public reference never loads company/session data or the authenticated shell's background requests.
  if (path === '/developers') return <html lang="en" className={inter.variable}><body>{children}</body></html>;
  // The Pulse phone app adds "PulseShell/<version>" to its user agent: phone-app styles render from the first paint.
  const shellPlatform=shellFromUserAgent((await headers()).get('user-agent'))??undefined;
  // ERP-INVOICE: a client's acceptance link is signed out and outside the staff shell; COMP-A: so is a person's offer link.
  const authPage=path.startsWith('/login')||path==='/join'||path==='/invited'||path.startsWith('/accept/')||path.startsWith('/offer/')||['/portal/login','/portal/set-password','/portal/confirm-email'].includes(path);
  // UX-TENANT: a company's own address signs in with Pulse passwords and wears its accent from the sign-in page on.
  const mode = await hostMode(requestHost(await headers()));
  const publicLogin = mode.signIn === "password";
  const brand = await readBrand();
  const accent = accentCss(brand?.accent);
  // FLOAT-2: every page carries the e-mail guard (email-guard.tsx) with the accent, before React starts.
  const accentStyle = <><EmailGuard />{accent ? <style dangerouslySetInnerHTML={{ __html: accent }} /> : null}</>;
  if(authPage)return <html suppressHydrationWarning lang="en" className={inter.variable} data-shell={shellPlatform}><body>{accentStyle}<PulseShell identity={null}>{children}</PulseShell><KeyboardWatch/></body></html>;
  if((await cookies()).has('pulse_client_session')){
    const client=await portalApi<{name:string;mustChange:boolean}>('/me');
    return <html lang="en" className={inter.variable}><body><div className={portalCss.clientFrame}><header className={portalCss.clientBrand}><strong>Pulse · Client collaboration</strong><a href="/portal/account">Account / Security</a><span>{client.data?.name}<ClientSignOut/></span></header><main>{client.data?.mustChange?<ClientLogin change/>:client.data?children:<ClientLogin/>}</main></div></body></html>;
  }
  const requestHeaders = await headers();
  const fromEmail = publicLogin ? null : resolveAccountIdentity(requestHeaders.get(CF_ACCESS_EMAIL_HEADER), process.env.NODE_ENV ?? "production");
  // The person's record in Pulse names them and carries their photo; the e-mail is only how they signed in.
  const read = (fromEmail && !fromEmail.isFixture) || (await cookies()).has("pulse_session") || publicLogin ? await getMe() : undefined;
  const me = read?.data;
  // LAYOUT-SWEEP: the organisation's own logo (Settings → Organisation) heads the rail and the phone's page list.
  const org = me ? orgLogo(brand) : null;
  const accountant = me?.role === 'accountant';
  // ERP-INVOICE: the Accountant also reads ERP (invoices, catalog, exports), never writes.
  if (accountant && !path.startsWith('/finance/desk') && !path.startsWith('/erp') && !path.startsWith('/account') && !path.startsWith('/login')) redirect('/finance/desk');
  // Signed out (or the session ended): the sign-in page, then back to where the person was going. Never a page
  // frame that only says "sign in".
  if (publicLogin && !me && read && (read.status === 401 || !read.status && /^Sign in/.test(read.error ?? "")) && !OPEN.test(path))
    redirect(`/login${path && path !== "/" && path !== "/dashboard" ? `?next=${encodeURIComponent(path + ((await headers()).get("x-pulse-search") ?? ""))}` : ""}`);
  // E2E-4P: the account menu names the person and their own organisation (a client's seat showed "pulse:rila.villas" and
  // "Member"); an account without an e-mail shows its @handle.
  const seatOf = me?.side === "client" ? me.orgName ?? "" : null;
  // MODULES-1024: a client works on shared tasks and chats; the API refuses them attendance, presence, Pip's day, the
  // freshness and push polls and the intelligence rail, so those stay off for them (they cost ~7 refused requests a page).
  const staffSeat = seatOf === null;
  const homeOrg = seatOf !== null ? me?.account?.orgs?.find((o) => !o.current && o.kind === "staff") : null;
  const handle = me?.account?.account?.handle ?? (me?.email?.startsWith("pulse:") ? me.email.slice(6) : null);
  const shownEmail = me ? seatOf !== null ? [homeOrg?.name, `${roleLabelFor(me) === "Partner" ? "partner" : "client"} of ${seatOf || "this organisation"}`].filter(Boolean).join(" · ")
    : me.email?.startsWith("pulse:") ? `@${handle}` : me.email : undefined;
  const identified = me ? { displayName: me.name, email: shownEmail ?? "", roleLabel: roleLabelFor(me) } : fromEmail;
  const identity = identified && me ? { ...identified, displayName: me.name || identified.displayName,
    profileHref: accountant ? '/account' : me.person ? `/people/${me.person}` : undefined,
    photoUrl: !accountant && me.person && me.photoAt ? `/photo/${me.person}?v=${Date.parse(me.photoAt)}` : undefined, signOut: publicLogin } : identified;
  // UX-TASKS-2: the rail follows the business model (a product company's Products / Customers / Releases; none for an internal team).
  // Switched-off modules leave the navigation; their route folders' layouts show the neutral page (module-off.tsx). The
  // company's own switches, the business model's words, Network and the screens hidden from this role: lib/nav.ts.
  const modulesOff = me?.modules?.off;
  const hasUpdates = !!(me?.person && !accountant && !me.mustChange && await newestUpdate());
  const { off, hiddenPaths, rename } = navFor(me, hasUpdates);
  // EST-1420: a direct link to a hidden screen lands on /hidden before the page renders. A switched-off module keeps
  // its own neutral page.
  // ORG: a client of this organisation lands on the work shared with them (before E2E-4P's closed screens apply).
  if (me?.side === 'client' && (path === '/' || path === '/dashboard')) redirect('/tasks');
  const away = hiddenRedirect(path, hiddenPaths, me?.person);
  if (away && !pathSwitchedOff(path, modulesOff) && !underBase(path, Object.keys(off))) redirect(away);
  // EST-2093: the calm home restyles the shell (rail, top bar); <html> carries it from the first paint, so nothing moves
  // while the page loads. The home sets and clears it itself on client-side navigation.
  // ORG: the Pulse account's organisations for the switcher (sidebar, rail tile, Ctrl+Shift+O).
  const orgs = me?.account?.orgs?.length ? { handle: me.account.account?.handle ?? null, invites: me.account.invites?.length ?? 0,
    list: me.account.orgs.map((o) => ({ id: o.id, name: o.name, handle: o.handle, role: kindLabel(o.kind), current: o.current })) } : undefined;
  const focus = drawsCalmHome(path, new URLSearchParams(requestHeaders.get("x-pulse-search") ?? ""), me);
  const pipDocked = (await cookies()).get("pulse.pip.dock")?.value === "1";
  // TELEMETRY: every movement and its timing for a signed-in person (PULSE_TELEMETRY=0 switches it off; PULSE_TELEMETRY_SAMPLE 0-1).
  // FEATURES-1024: a one-time card says what is measured (Settings → Privacy has the full words).
  const telemetryOn = process.env.PULSE_TELEMETRY !== "0";
  const telemetry = me && !me.mustChange ? <><TelemetryHost release={telemetryRelease()} enabled={telemetryOn}
    sample={Math.min(1, Math.max(0, Number(process.env.PULSE_TELEMETRY_SAMPLE ?? 1) || 0))} />
    {telemetryOn && me.person ? <TelemetryNotice privacyHref={me.role === "admin" || me.role === "hr" ? "/settings?tab=sign-in#privacy" : "/settings#privacy"} /> : null}</> : null;
  // CHAT-SHELL: a page opened in the chat's side panel (embed=1, or any page framed by Pulse itself) is the page alone:
  // no rail, no top bar, no Pip island; "+ New" and the spotlight stay, so a coach can point inside it.
  const embed = !!me && (/(?:^|[?&])embed=1(?:&|$)/.test(requestHeaders.get("x-pulse-search") ?? "") || requestHeaders.get("sec-fetch-dest") === "iframe");
  if (embed && me) return (
    <html suppressHydrationWarning lang="en" className={inter.variable} data-shell={shellPlatform} data-embed="">
      <body data-viewer={me.person ?? undefined}>{accentStyle}<PulseShell identity={identity} rename={rename} org={org} orgName={me.orgName} modulesOff={modulesOff} embed>{me.mustChange ? <LoginForm change framed companyName={org?.name ?? me.orgName ?? "Pulse"}/> : <OrgCodeProvider code={brand?.code ?? "EA"} zone={brand?.timeZone ?? FALLBACK_ZONE}><HiddenGate bases={hiddenPaths} person={me.person} admin={me.role === "admin"} client={seatOf} modulesOff={modulesOff} companyOff={Object.keys(off)}><AppDs>{children}</AppDs>{telemetry}</HiddenGate></OrgCodeProvider>}{me.person && !me.mustChange && !accountant ? <><CreateHost/><Suspense fallback={null}><Spotlight/></Suspense></> : null}</PulseShell></body>
    </html>
  );
  return (
    <html suppressHydrationWarning lang="en" className={inter.variable} data-shell={shellPlatform} data-pulse-focus={focus ? "" : undefined} data-pip-docked={pipDocked ? "" : undefined} data-seat={seatOf !== null ? "client" : undefined}>
      <body data-viewer={me?.person ?? undefined}>{accentStyle}<PulseShell identity={identity} rename={rename} org={org} orgName={me?.orgName} modulesOff={modulesOff} orgs={orgs}
        externalSearch={!!me && !me.mustChange} create={undefined}
        account={me&&!me.mustChange&&!accountant?<>{seatOf===null?<InsightsMenuItem/>:null}{me.person?<OrgsMenuItem/>:null}</>:undefined}
        utilities={me&&!me.mustChange?<>{me.person&&!accountant?<>{modulesOff?.includes("tasks")?null:<ReviewChip/>}{modulesOff?.includes("hr")||!staffSeat?null:<CheckinChip personId={me.person}/>}</>:null}{/* POLISH-2: Pip after the chips: a chip appearing or changing width never moves it over them. */}<PipIsland personId={accountant?undefined:me.person??undefined} canAsk={!accountant&&staffSeat} staff={staffSeat}/>{me.person&&!accountant&&!modulesOff?.includes("chats")?<InboxBell/>:null}{accountant||!staffSeat?null:<Suspense fallback={null}><IntelligenceRail/></Suspense>}</>:undefined}>{me?.mustChange ? <LoginForm change framed companyName={org?.name ?? me.orgName ?? "Pulse"}/> : <OrgCodeProvider code={brand?.code ?? "EA"} zone={brand?.timeZone ?? FALLBACK_ZONE}><HiddenGate bases={hiddenPaths} person={me?.person} admin={me?.role === "admin"} client={seatOf} modulesOff={modulesOff} companyOff={Object.keys(off)}><AppDs>{children}</AppDs>{telemetry}</HiddenGate></OrgCodeProvider>}{me?.person&&!me.mustChange&&!accountant?<><CreateHost/>{staffSeat?<PresencePoller/>:null}{modulesOff?.includes("chats")?null:<ChatDock/>}<Suspense fallback={null}><Spotlight/>{modulesOff?.includes("tasks")||!staffSeat?null:<TaskCompanion role={identity?.roleLabel ?? "Member"} modulesOff={modulesOff}/>}</Suspense></>:null}{me && !me.mustChange ? <CommandPalette role={identity?.roleLabel} modulesOff={modulesOff} rename={rename} hidden={hiddenPaths} person={accountant ? null : me.person ?? null} attendance={!modulesOff?.includes("hr")} /> : null}{me?.person&&!me.mustChange&&!accountant?<OrgSwitcher state={me.account}/>:null}<Suspense fallback={null}><AppFeel /></Suspense><KeyboardWatch/>{me&&!me.mustChange&&!accountant&&staffSeat?<DataPulse/>:null}{me?.person&&!me.mustChange&&!accountant?<>{staffSeat?<BrowserPings/>:null}{/* UI-POLISH (R120): calls and browser pings are staff features; the API refuses them to a client seat. */}{modulesOff?.includes("chats")||!staffSeat?null:<CallHost person={me.person}/>}<ShellBridge person={me.person} via={me.via} staff={staffSeat}/></>:null}</PulseShell></body>
    </html>
  );
}
