"use client";

import { Inbox, Search, ShieldAlert, UserRoundSearch } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { count, dayTime, plural, userId } from "../lib/format";
import { RelativeTime } from "../relative-time";
import { LoginActions, ResetRequestActions } from "../records";
import { Avatar, Badge, Empty, Panel, styles, Why, Workspace } from "../ui";
import css from "./settings.module.css";
import {AuthPolicy,ResendExpired} from "../account/admin";
import { InvitationPreview } from "./invitations";
import { GoogleSignIn } from "./google";
import { type AccessData, type AccessPerson } from "./types";
import { useOrgCode } from "../org-code";

type Filter = "all" | "password" | "none" | "disabled";
type Tone = "neutral" | "warning" | "success" | "danger" | "accent";

/** How a person's Pulse password stands, in the words an admin would use. */
function passwordState(p: AccessPerson): { label: string; tone: Tone } {
  // UI-POLISH-3: the status reads in sentence case like every badge ("Not invited", "Link expired"); the value is unchanged.
  if(p.authStatus)return {label:p.authStatus.charAt(0).toUpperCase()+p.authStatus.slice(1),tone:p.authStatus==='active'?'success':p.authStatus==='locked'?'danger':'neutral'};
  if (!p.loginStatus) return { label: "Not issued", tone: "neutral" };
  if (p.loginStatus !== "active") return { label: "Switched off", tone: "neutral" };
  if (p.locked) return { label: "Locked", tone: "danger" };
  if (p.mustChange) return { label: "Issued, must change", tone: "warning" };
  return { label: "Active", tone: "success" };
}

function Method({p}:{p:AccessPerson}){const state=passwordState(p);return <Badge tone={state.tone}>{state.label}</Badge>;}

/** Staff sign-in admin: the forgot-password queue, how username sign-in works, and everyone's sign-in method. */
export function SignIn({ people, requests, admin = false }: AccessData & { admin?: boolean }) {
  const orgCode = useOrgCode();
  const [query, setQuery] = useState(""); const [filter, setFilter] = useState<Filter>("all");
  const pending = requests.filter((r) => r.status === "pending"); const closed = requests.filter((r) => r.status !== "pending").slice(0, 5);
  const is: Record<Filter, (p: AccessPerson) => boolean> = {
    all: () => true, password: (p) => p.authStatus==='active',
    none: (p) => ['not invited','invited','link expired','locked'].includes(p.authStatus??'not invited'),disabled:(p)=>p.authStatus==='disabled',
  };
  const q = query.trim().toLowerCase();
  const matches = (p: AccessPerson) => !q || `${p.name} ${p.username ?? ""} ${userId(p.userNo, orgCode) ?? ""} ${p.role} ${p.pod ?? ""} ${p.accounts.join(" ")}`.toLowerCase().includes(q);
  const shown = people.filter((p) => is[filter](p) && matches(p));
  const chips: [Filter, string][] = [["all", "All"], ["password", "Active"], ["none", "Needs attention"], ["disabled", "Disabled"]];
  return <Workspace initial={pending.length ? 0 : 2} labels={["Forgot-password requests", "How username sign-in works", "Who can sign in", "Google"]}>
    <div className={css.top}>
      <Panel title="Forgot-password requests" sub={pending.length ? `${count(pending.length)} waiting` : "None waiting"}>
        {requests.length ? <ul className={styles.list}>
          {[...pending, ...closed].map((r) => (
            <li key={r.id} className={css.request} data-closed={r.status === "pending" ? undefined : ""}>
              <span className={css.requestMain}>
                <b>{r.name ?? r.username}</b>
                <small>{r.name ? <span className={styles.mono}>{r.username}</span> : "No person has this username"} · asked <RelativeTime value={r.requestedAt}/></small>
              </span>
              {r.status === "pending" ? <ResetRequestActions id={r.id} known={!!r.personId} />
                : <small className={styles.muted}>{r.status === "dismissed" ? "Dismissed" : "Reset link sent"}{r.resolvedBy ? ` by ${r.resolvedBy}` : ""}{r.resolvedAt ? ` · ${dayTime(r.resolvedAt)}` : ""}</small>}
            </li>
          ))}
        </ul> : <Empty icon={Inbox} compact title="No requests" text="When someone uses “Forgot password” on the sign-in screen, the request waits here for HR or an admin." />}
      </Panel>
      <Panel title="How username sign-in works" sub="For all staff · personal Gmail is welcome">
        <ol className={css.steps}>
          <li><span><b>HR or an admin sends a private sign-in link</b> from Account access below. The person chooses their own password.</span></li>
          <li><span><b>Links work once; resending invalidates old links.</b> Use Resend invitation for expired links, a one-time sign-in link when someone is locked out of a device, or Copy link when no delivery email is on file.</span></li>
          <li><span><b>“Forgot password” emails a private reset link.</b> When there is no delivery email, HR sees a request here and can send a reset link after updating the address.</span></li>
        </ol>
        <p className={css.note}><ShieldAlert size={15} aria-hidden="true" /><span>Use Pulse usernames and passwords on production. HR/admin previews team invitations before sending each person a private link to choose their own password.</span></p>
      </Panel>
    </div>
    <Panel title="Who can sign in" sub={`${plural(people.length, "person", "people")} · ${count(people.filter((p) => p.loginStatus === "active").length)} with a Pulse password`} tools={<><InvitationPreview/><ResendExpired/><Why detail="Production sign-in uses Pulse usernames and passwords. Workspace connections are used for individual email." more="Use Account access for fresh invitation and reset links, unlocking, offboarding and account history." /></>}>
      <div className={css.filters}>
        <label className={css.searchBox}><Search size={14} aria-hidden="true" /><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by name, username or ID…" aria-label="Search people" /></label>
        <div className={css.filterGroup} role="group" aria-label="Sign-in method">
          {chips.map(([key, label]) => <button key={key} type="button" className={css.chip} aria-pressed={filter === key} onClick={() => setFilter(key)}>{label}<small>{people.filter((p) => is[key](p) && matches(p)).length}</small></button>)}
        </div>
        {/* UI-POLISH-3: the two-step rule sits at the end of the filter row; in the panel's header it squeezed the count to "11 …". */}
        {admin ? <span className={css.filtersEnd}><AuthPolicy/></span> : null}
      </div>
      {shown.length ? <div className={styles.tableWrap}><table className={styles.table}>
        <thead><tr><th>Person</th><th className={styles.hideSmall}>User ID</th><th className={styles.hideSmall}>Username</th><th className={styles.hideSmall}>Signs in with</th><th className={styles.hideSmall}>Last sign-in</th><th className={styles.right}>Account access</th></tr></thead>
        <tbody>{shown.map((p) => {
          return (
            <tr key={p.id}>
              <td>
                <Link href={`/people/${p.id}`} className={styles.person}><Avatar name={p.name} id={p.id} photoAt={p.photoAt} size={28} /><span><span className={styles.cellLink}>{p.name}</span><span className={styles.cellSub}>{[p.role, p.pod].filter(Boolean).join(" · ")}</span></span></Link>
                <span className={css.onlySmall}><Method p={p} /></span>
              </td>
              <td className={`${styles.nowrap} ${styles.mono} ${styles.hideSmall}`}>{userId(p.userNo, orgCode) ?? <span className={styles.muted}>No ID yet</span>}</td>
              <td className={`${styles.nowrap} ${styles.mono} ${styles.hideSmall}`}>{p.username ?? <span className={styles.muted}>None</span>}</td>
              <td className={styles.hideSmall}><Method p={p}/>{p.delivery?<span className={css.methodSub}>{p.delivery}</span>:<span className={css.methodSub}>No delivery email</span>}</td>
              <td className={`${styles.nowrap} ${styles.hideSmall}`}>{p.lastLoginAt?<RelativeTime value={p.lastLoginAt}/>:<span className={styles.muted}>Never</span>}</td>
              <td><span className={css.actionsCell}><LoginActions personId={p.id} hasLogin={!!p.loginStatus} active={p.loginStatus === "active"} small /></span></td>
            </tr>
          );
        })}</tbody>
      </table></div> : <Empty icon={UserRoundSearch} title="Nobody matches" text="Try a different search, or show everyone."><button type="button" className={styles.btn} onClick={() => { setQuery(""); setFilter("all"); }}>Clear filters</button></Empty>}
    </Panel>
    <GoogleSignIn admin={admin} />
  </Workspace>;
}
