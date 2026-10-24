"use client";

import { Building2, Check, ChevronsUpDown, Handshake, Mail, Plus, Settings2 } from "lucide-react";
import { useState, type CSSProperties, type RefObject } from "react";
import type { PulseOrgs, PulseWorkspace } from "./types";

import styles from "./workspace-switcher.module.css";

type WorkspaceKind = PulseWorkspace["kind"];
type Workspace = PulseWorkspace;

export function initials(name: string): string {
  const parts = name.replace(/\([^)]*\)/g, " ").trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return (name.slice(0, 2) || "·").toUpperCase();
}
/** Owner workbench UI: an organisation without a logo shows its initials on a colour of its own (the same for it
 *  everywhere: the sidebar's tile and the collapsed rail's), so Estate Autopilots, Atlas Crest and Pulse look
 *  different at a glance. */
export function orgHue(name: string): number { let h = 7; for (const c of name) h = (h * 31 + (c.codePointAt(0) ?? 0)) % 360; return h; }

/**
 * The sidebar's account switcher: Personal (your own account) and the
 * organisations you belong to, each clearly marked, with create and join.
 */
export function WorkspaceSwitcher({
  workspaces,
  currentId,
  personName,
  pending,
  open,
  setOpen,
  containerRef,
  onSelect,
  orgMark,
  orgs,
}: {
  workspaces: readonly Workspace[];
  currentId: string | null;
  personName: string | null;
  pending: boolean;
  open: boolean;
  setOpen: (next: boolean) => void;
  containerRef: RefObject<HTMLDivElement | null>;
  onSelect: (tenantId: string) => void;
  /** The organisation's own mark (its logo tile); the generic building icon only when it has none. */
  orgMark?: string | null;
  /** ORG: the Pulse account's organisations; with them the switcher switches for real (the app does it). */
  orgs?: PulseOrgs;
}) {
  // A mark that fails to load (a 404, a removed logo) falls back to the initials tile: never a broken picture.
  const [failed, setFailed] = useState<string | null>(null);
  const mark = orgMark && failed !== orgMark ? orgMark : null;
  const broken = () => setFailed(orgMark ?? null);
  if (orgs && orgs.list.length) return <OrgList orgs={orgs} open={open} setOpen={setOpen} containerRef={containerRef} orgMark={mark} onBroken={broken} pending={pending} />;
  const current =
    workspaces.find((workspace) => workspace.tenant_id === currentId) ??
    workspaces[0] ??
    null;
  const kind = current?.kind ?? "personal";
  const you = personName || "Your account";
  const title = current?.name ?? you;
  const subtitle = kind === "personal" ? "Personal account" : "Organisation";
  const personal = workspaces.filter(
    (workspace) => workspace.kind === "personal",
  );
  const organisations = workspaces.filter(
    (workspace) => workspace.kind === "organisation",
  );

  const item = (workspace: Workspace, itemKind: WorkspaceKind) => {
    const selected = workspace.tenant_id === current?.tenant_id;
    const name = workspace.name;
    return (
      <button
        key={workspace.tenant_id}
        type="button"
        role="menuitemradio"
        aria-checked={selected}
        className={styles.item}
        data-selected={selected ? "" : undefined}
        onClick={() => onSelect(workspace.tenant_id)}
      >
        <span className={styles.tile} data-kind={itemKind} data-img={itemKind === "organisation" && mark ? "" : undefined} aria-hidden="true">
          {itemKind === "organisation" ? (
            (mark ? <img src={mark} alt="" width={28} height={28} className={styles.tileImg} onError={broken} /> : <Building2 size={14} />)
          ) : (
            initials(name)
          )}
        </span>
        <span className={styles.itemCopy}>
          <b>{name}</b>
          <small>
            {itemKind === "personal" ? "Just you" : "Your organisation"}
          </small>
        </span>
        {selected ? (
          <Check size={15} className={styles.check} aria-hidden="true" />
        ) : null}
      </button>
    );
  };

  return (
    <div className={styles.container} ref={containerRef}>
      <button
        type="button"
        className={styles.trigger}
        data-loading={pending ? "" : undefined}
        onClick={() => setOpen(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Current workspace: ${title}`}
        title={title}
      >
        <span className={styles.tile} data-kind={kind} data-img={kind === "organisation" && mark ? "" : undefined} aria-hidden="true">
          {kind === "organisation" ? (mark ? <img src={mark} alt="" width={32} height={32} className={styles.tileImg} onError={broken} /> : <Building2 size={15} />) : initials(title)}
        </span>
        <span className={styles.copy}>
          <b>{title}</b>
          <small>{subtitle}</small>
        </span>
        <ChevronsUpDown
          size={14}
          className={styles.chevron}
          aria-hidden="true"
        />
      </button>

      {open && (
        <div className={styles.menu} role="menu" aria-label="Switch account">
          {personal.length > 0 && (
            <>
              <p className={styles.group}>Personal</p>
              {personal.map((workspace) => item(workspace, "personal"))}
            </>
          )}
          <p className={styles.group}>Organisations</p>
          {organisations.length > 0 ? (
            organisations.map((workspace) => item(workspace, "organisation"))
          ) : (
            <p className={styles.empty}>You are not in an organisation yet.</p>
          )}
          <span className={styles.separator} />
          <button type="button" className={styles.action} disabled>
            <Plus size={15} aria-hidden="true" />
            Create an organisation
            <span className={styles.soon}>Soon</span>
          </button>
          <button type="button" className={styles.action} disabled>
            <Mail size={15} aria-hidden="true" />
            Join with an invite
            <span className={styles.soon}>Soon</span>
          </button>
        </div>
      )}
    </div>
  );
}

const send = (name: string, detail?: unknown) => window.dispatchEvent(detail === undefined ? new Event(name) : new CustomEvent(name, { detail }));

/** ORG: the account's organisations, the current one marked; picking another switches at once (no sign-in). */
function OrgList({ orgs, open, setOpen, containerRef, orgMark, onBroken, pending }: { orgs: PulseOrgs; open: boolean; setOpen: (next: boolean) => void;
  containerRef: RefObject<HTMLDivElement | null>; orgMark?: string | null; onBroken: () => void; pending: boolean }) {
  const current = orgs.list.find((o) => o.current) ?? orgs.list[0];
  return (
    <div className={styles.container} ref={containerRef}>
      <button type="button" className={styles.trigger} data-loading={pending ? "" : undefined} onClick={() => setOpen(!open)}
        aria-haspopup="menu" aria-expanded={open} aria-label={`Organisation: ${current.name}. Switch organisation`} title={`${current.name} · Ctrl+Shift+O to switch`}>
        <span className={styles.tile} data-kind="organisation" data-img={orgMark ? "" : undefined} data-hue="" style={{ "--org-hue": orgHue(current.name) } as CSSProperties} aria-hidden="true">
          {orgMark ? <img src={orgMark} alt="" width={32} height={32} className={styles.tileImg} onError={onBroken} /> : initials(current.name)}
        </span>
        <span className={styles.copy}><b>{current.name}</b><small>{current.handle ? `@${current.handle}` : current.role}</small></span>
        <ChevronsUpDown size={14} className={styles.chevron} aria-hidden="true" />
      </button>
      {open && (
        <div className={styles.menu} role="menu" aria-label="Switch organisation">
          <p className={styles.group}>{orgs.handle ? `@${orgs.handle}` : "Your organisations"}</p>
          {orgs.list.map((o, i) => (
            <button key={o.id} type="button" role="menuitemradio" aria-checked={o.current} className={styles.item} data-selected={o.current ? "" : undefined}
              onClick={() => { setOpen(false); if (!o.current) send("pulse:org-switch", { org: o.id }); }}>
              <span className={styles.tile} data-kind="organisation" aria-hidden="true">{o.current && orgMark ? <img src={orgMark} alt="" width={28} height={28} className={styles.tileImg} onError={onBroken} /> : initials(o.name)}</span>
              <span className={styles.itemCopy}><b>{o.name}</b><small>{o.role}{i < 9 && !o.current ? ` · ${i + 1}` : ""}</small></span>
              {o.current ? <Check size={15} className={styles.check} aria-hidden="true" /> : null}
            </button>
          ))}
          <span className={styles.separator} />
          {orgs.invites ? <a className={styles.action} href="/orgs"><Mail size={15} aria-hidden="true" />{orgs.invites === 1 ? "1 invitation waiting" : `${orgs.invites} invitations waiting`}</a> : null}
          <a className={styles.action} href="/orgs/new"><Plus size={15} aria-hidden="true" />Start your own Pulse</a>
          <a className={styles.action} href="/orgs#join"><Mail size={15} aria-hidden="true" />Join with an invitation</a>
          <a className={styles.action} href="/connections"><Handshake size={15} aria-hidden="true" />Connected organisations</a>
          <a className={styles.action} href="/orgs"><Settings2 size={15} aria-hidden="true" />Manage organisations</a>
        </div>
      )}
    </div>
  );
}
