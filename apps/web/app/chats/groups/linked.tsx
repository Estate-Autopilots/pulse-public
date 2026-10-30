"use client";
// GROUPS-2: a client's or a project's groups with the hub's facts (type, health, who is waiting on us, open tasks,
// activity), on their pages. Each opens in the groups hub; members also open the chat. Groups the viewer sees only.
import Link from "next/link";
import { useEffect, useState } from "react";
import { Clock3, ListChecks, MessageCircle, Users } from "lucide-react";
import { get } from "../net";
import css from "./hub.module.css";
import { GroupMark } from "./hub";
import { ago, displayName, HEALTH, KIND, monthLabel, STATUS, type Group } from "./model";

export function LinkedGroups({ client, project }: { client?: string; project?: string }) {
  const [groups, setGroups] = useState<Group[] | null>(null), [error, setError] = useState("");
  const qs = client ? `client=${client}` : `project=${project}`;
  useEffect(() => { const a = new AbortController(); get<{ groups: Group[] }>(`chats/hub/linked?${qs}`, a.signal).then((d) => setGroups(d.groups)).catch((e) => { if (!a.signal.aborted) setError((e as Error).message); }); return () => a.abort(); }, [qs]);
  if (error) return <p className={css.errorText} role="alert">{error}</p>;
  if (!groups) return <p className={css.small}>Loading the groups…</p>;
  if (!groups.length) return <p className={css.small}>No group is linked to this {client ? "client" : "project"} yet. Link one in Chats → All groups (a group&apos;s Brief, or To review).</p>;
  const waiting = groups.filter((g) => g.waitingSince).length, tasks = groups.reduce((n, g) => n + g.openTasks, 0);
  return <div className={css.vars} data-linked-groups="">
    <p className={css.linkedSum}>{groups.length} group{groups.length === 1 ? "" : "s"}{waiting ? <> · <b data-tone="warn">{waiting} waiting on us</b></> : " · nobody waiting on us"}{tasks ? ` · ${tasks} open task${tasks === 1 ? "" : "s"}` : ""}</p>
    <ul className={css.linkedList}>{groups.map((g) => <li key={g.id} className={css.linkedRow} data-group-row={g.id}>
      <Link href={`/chats/groups?group=${g.id}`} className={css.linkedMain} aria-label={`${g.name} in the groups hub`}>
        <GroupMark g={g} size={36} />
        <span className={css.linkedName}><b title={g.name}>{displayName(g.name)}</b>
          <span className={css.line2}>{g.kind ? <span className={css.kind} data-kind={g.kind}>{KIND[g.kind]}</span> : null}
            <span className={css.pill} data-status={g.status}>{STATUS[g.status]}</span>
            {g.health ? <span className={css.healthTag} data-health={g.health}>{HEALTH[g.health]}</span> : null}
            {g.period ? <span className={css.muted}>{monthLabel(g.period)}</span> : null}</span></span>
        <span className={css.linkedFacts}>
          {g.waitingSince ? <span className={css.waiting} title={`${g.waitingWho ?? "A client"} wrote and nobody from the team answered yet`}><Clock3 size={12} aria-hidden="true" />{g.waitingWho ?? "Client"} · {ago(g.waitingSince).replace(" ago", "")}</span> : null}
          <span className={css.muted}><ListChecks size={13} aria-hidden="true" /> {g.openTasks} open</span>
          <span className={css.muted}><Users size={13} aria-hidden="true" /> {g.members}</span>
          <span className={css.muted}>{ago(g.lastAt)}</span>
          {g.unread ? <span className={css.unread} aria-label={`${g.unread} unread`}>{g.unread > 99 ? "99+" : g.unread}</span> : null}
        </span>
      </Link>
      {g.member || g.canRead ? <Link href={`/chats?channel=${g.id}`} className={css.iconBtn} aria-label={`Open the chat ${g.name}`}><MessageCircle size={16} aria-hidden="true" /></Link> : null}
    </li>)}</ul>
  </div>;
}
