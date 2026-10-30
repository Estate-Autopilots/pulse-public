"use client";

/**
 * The console frame, after Pulse's shell: a rail of grouped sections on the
 * left (icons only on tablets or when collapsed), a slim top bar, and on
 * phones a bottom bar with the main sections plus "More", which opens the
 * full rail as a sheet. Sections a person can't use are not shown; the API
 * still checks every read and command. PULSE-ADMIN: ported from the Sales X-Ray admin console
 * (apps/admin-web) and rebranded to Pulse.
 */
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import {
  Activity,
  BarChart3,
  Bug,
  Building2,
  Coins,
  Gauge,
  Home,
  LogOut,
  Megaphone,
  MessageSquareHeart,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Plug,
  Rocket,
  ScrollText,
  Settings,
  UsersRound,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { useAdminWorkspaceControls } from "../components/admin-workspace-controls";
import type { ConsoleAccess } from "../lib/access";
import type { AdminConfig } from "../lib/config";
import { activeHref, visibleNavigation, type NavIcon } from "../lib/nav";
import { AccountMenu } from "./account-menu";
import { CommandMenu } from "./command-menu";
import { EnvironmentSwitch } from "./environment-switch";
import { ThemeToggle } from "./theme";
import styles from "./shell.module.css";

const ICONS: Record<NavIcon, LucideIcon> = {
  home: Home,
  bugs: Bug,
  feedback: MessageSquareHeart,
  organisations: Building2,
  people: UsersRound,
  usage: BarChart3,
  spend: Coins,
  telemetry: Gauge,
  health: Activity,
  releases: Rocket,
  updates: Megaphone,
  audit: ScrollText,
  integrations: Plug,
  settings: Settings,
  setup: Wrench,
};

/** Pulse's mark ("Ripple": a live point and the pulse spreading from it), from packages/design-system/src/brand.js. */
export function PulseMark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" fill="none">
      <path d="M8.9 13.2A9.9 9.9 0 0 1 18.8 23.1M8.9 6.2A16.9 16.9 0 0 1 25.8 23.1" stroke="currentColor" strokeWidth="3.6" strokeLinecap="round" />
      <circle cx="8.9" cy="23.1" r="4.4" fill="currentColor" />
    </svg>
  );
}

export function ConsoleShell({
  access,
  config,
  children,
}: {
  access: ConsoleAccess;
  config: AdminConfig;
  children: ReactNode;
}) {
  const pathname = usePathname() ?? "/";
  const search = useSearchParams()?.toString() ?? "";
  const groups = visibleNavigation();
  const current = activeHref(pathname, groups, search);
  const phoneItems = groups
    .flatMap((group) => group.items)
    .filter((item) => item.phone)
    .slice(0, 4);
  const {
    collapsed,
    toggleCollapsed,
    mobileOpen,
    openMobile,
    closeMobile,
    sidebarRef,
    triggerRef,
    signingOut,
    signOutError,
    requestSignOut,
  } = useAdminWorkspaceControls();
  const currentLabel =
    groups.flatMap((group) => group.items).find((item) => item.href === current)
      ?.label ?? "Admin";

  return (
        <div
          className={styles.shell}
          data-collapsed={collapsed ? "" : undefined}
          data-sheet={mobileOpen ? "" : undefined}
        >
          <aside
            className={styles.rail}
            id="admin-sidebar"
            ref={sidebarRef}
            aria-label="Admin navigation"
            onClick={(event) => {
              if (
                (event.target as HTMLElement).closest("a[href]") &&
                mobileOpen
              )
                closeMobile();
            }}
          >
            <div className={styles.brandRow}>
              <AccountMenu access={access} config={config} />
              <button
                type="button"
                className={`${styles.iconButton} ${styles.collapseToggle}`}
                onClick={toggleCollapsed}
                aria-label={
                  collapsed ? "Expand navigation" : "Collapse navigation"
                }
                aria-expanded={!collapsed}
                aria-controls="admin-sidebar"
                title={collapsed ? "Expand navigation" : "Collapse navigation"}
              >
                {collapsed ? (
                  <PanelLeftOpen size={16} aria-hidden="true" />
                ) : (
                  <PanelLeftClose size={16} aria-hidden="true" />
                )}
              </button>
              <button
                type="button"
                className={`${styles.iconButton} ${styles.sheetClose}`}
                onClick={closeMobile}
                aria-label="Close navigation"
              >
                <X size={18} aria-hidden="true" />
              </button>
            </div>

            <nav className={styles.nav} aria-label="Sections">
              {groups.map((group, index) => (
                <div className={styles.group} key={group.label || index}>
                  {group.label ? (
                    <p className={styles.groupLabel}>{group.label}</p>
                  ) : null}
                  {group.items.map((item) => {
                    const Icon = ICONS[item.icon];
                    return (
                      <Link
                        key={item.href}
                        href={item.href}
                        className={styles.navLink}
                        aria-current={
                          item.href === current ? "page" : undefined
                        }
                        title={item.label}
                        prefetch={false}
                      >
                        <Icon size={16} strokeWidth={1.8} aria-hidden="true" />
                        <span>{item.label}</span>
                      </Link>
                    );
                  })}
                </div>
              ))}
            </nav>

            <div className={styles.account}>
              <Link href="/" className={styles.brand} aria-label="Admin home">
                <span className={styles.brandMark}>
                  <PulseMark size={16} />
                </span>
                <span className={styles.brandText}>
                  <strong>{config.product} Admin</strong>
                  <small>{config.company ?? "Back office"}</small>
                </span>
              </Link>
              <button
                type="button"
                className={styles.iconButton}
                onClick={requestSignOut}
                disabled={signingOut}
                aria-label={signingOut ? "Signing out" : "Sign out"}
                title="Sign out"
              >
                <LogOut size={16} aria-hidden="true" />
              </button>
              {signOutError ? (
                <p className={styles.accountError} role="alert">
                  {signOutError}
                </p>
              ) : null}
            </div>
          </aside>

          {mobileOpen ? (
            <button
              type="button"
              className={styles.scrim}
              onClick={closeMobile}
              aria-label="Dismiss navigation"
              tabIndex={-1}
            />
          ) : null}

          <div className={styles.body} inert={mobileOpen}>
            <header className={styles.topbar}>
              <button
                type="button"
                ref={triggerRef}
                className={`${styles.iconButton} ${styles.menuButton}`}
                onClick={openMobile}
                aria-label="Open navigation"
                aria-expanded={mobileOpen}
                aria-controls="admin-sidebar"
              >
                <Menu size={18} aria-hidden="true" />
              </button>
              <span className={styles.where}>{currentLabel}</span>
              <span className={styles.topTools}>
                <EnvironmentSwitch config={config} />
                <CommandMenu groups={groups} />
                <ThemeToggle />
              </span>
            </header>
            <main id="admin-content" className={styles.main} tabIndex={-1}>
              {children}
            </main>
          </div>

          {phoneItems.length ? (
            <nav className={styles.bottomBar} aria-label="Main sections">
              {phoneItems.map((item) => {
                const Icon = ICONS[item.icon];
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={styles.bottomLink}
                    aria-current={item.href === current ? "page" : undefined}
                    prefetch={false}
                  >
                    <Icon size={18} strokeWidth={1.8} aria-hidden="true" />
                    <span>{item.label}</span>
                  </Link>
                );
              })}
              <button
                type="button"
                className={styles.bottomLink}
                onClick={openMobile}
                aria-label="More sections"
              >
                <Menu size={18} strokeWidth={1.8} aria-hidden="true" />
                <span>More</span>
              </button>
            </nav>
          ) : null}
        </div>
  );
}
