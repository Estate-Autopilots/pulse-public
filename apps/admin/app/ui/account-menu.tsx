"use client";

/**
 * Who is signed in, at the top of the rail (PULSE-ADMIN, after the Sales X-Ray admin's account menu): the person,
 * their organisation, and the way back to Pulse itself.
 */
import { ChevronsUpDown, ExternalLink } from "lucide-react";

import type { ConsoleAccess } from "../lib/access";
import type { AdminConfig } from "../lib/config";
import styles from "./shell.module.css";
import { usePopover } from "./use-popover";

export function initialsOf(access: ConsoleAccess) {
  const source = access.displayName || access.email || "?";
  return (
    source
      .split(/[\s@.]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => Array.from(part)[0])
      .join("")
      .toUpperCase() || "?"
  );
}

const personName = (access: ConsoleAccess) => access.displayName || access.email || "Your account";

export function AccountMenu({ access, config }: { access: ConsoleAccess; config: AdminConfig }) {
  const { open, toggle, panelId, box, trigger } = usePopover();
  return (
    <div className={styles.person} ref={box}>
      <button
        type="button"
        ref={trigger}
        className={styles.personButton}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`Signed in as ${personName(access)}`}
        title={access.email ?? undefined}
        onClick={toggle}
      >
        <span className={styles.avatar} aria-hidden="true">{initialsOf(access)}</span>
        <span className={styles.accountText}>
          <strong>{personName(access)}</strong>
          <small>Platform admin</small>
        </span>
        <ChevronsUpDown size={14} aria-hidden="true" className={styles.personChevron} />
      </button>
      <div id={panelId} className={styles.personPanel} hidden={!open} role="region" aria-label="Signed-in person">
        <div className={styles.personHead}>
          <span className={styles.avatar} aria-hidden="true">{initialsOf(access)}</span>
          <span className={styles.accountText}>
            <strong>{personName(access)}</strong>
            <small>{access.email ?? "Signed in"}</small>
            <small>Platform admin{access.orgName ? ` · ${access.orgName}` : ""}</small>
          </span>
        </div>
        {config.appUrl ? (
          <a href={config.appUrl} className={styles.personFoot}>
            <ExternalLink size={14} aria-hidden="true" />
            Open {config.product}
          </a>
        ) : null}
      </div>
    </div>
  );
}
