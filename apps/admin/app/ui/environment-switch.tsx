"use client";

/**
 * Which environment this admin site is, and one click to the same page in the other (PULSE-ADMIN, after the Sales
 * X-Ray admin's switch). The sites come from configuration (PULSE_ADMIN_PRODUCTION_URL, PULSE_ADMIN_DEV_URL).
 */
import { Check, ChevronDown, ExternalLink } from "lucide-react";
import { usePathname, useSearchParams } from "next/navigation";

import type { AdminConfig } from "../lib/config";
import styles from "./shell.module.css";
import { usePopover } from "./use-popover";

const LABEL = { production: "Production", development: "Development" } as const;

export function EnvironmentSwitch({ config }: { config: AdminConfig }) {
  const { open, toggle, panelId, box, trigger } = usePopover();
  const path = usePathname() ?? "/";
  const search = useSearchParams()?.toString();
  const here = `${path}${search ? `?${search}` : ""}`;
  const label = LABEL[config.environment];
  if (config.sites.length < 2) return <span className={styles.env} data-env={config.environment}>{label}</span>;
  return (
    <div className={styles.envSwitch} ref={box}>
      <button type="button" ref={trigger} className={styles.env} data-env={config.environment} aria-expanded={open} aria-controls={panelId} onClick={toggle}>
        {label}
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      <div id={panelId} className={styles.envPanel} hidden={!open} role="menu" aria-label="Admin environments">
        {config.sites.map((site) => (
          <a key={site.key} role="menuitem" href={`${site.url}${here}`} className={styles.envRow} aria-current={site.key === config.environment ? "true" : undefined}>
            <span>{site.label}</span>
            {site.key === config.environment ? <Check size={14} aria-hidden="true" /> : <ExternalLink size={14} aria-hidden="true" />}
          </a>
        ))}
      </div>
    </div>
  );
}
