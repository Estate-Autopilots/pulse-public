"use client";
// LIFECYCLE: project staffing. Who fits this project best (domains, the same kind of work, load, leave, the client),
// with one line of reasons; the owner or head adds them in one click (people outside their reach get an invitation).
import { UserPlus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { notify } from "@pulse/ui-shell";
import { post } from "../records";
import { Avatar, styles } from "../ui";
import css from "./tasks.module.css";

export type Fit = { id: string; name: string; why: string; photoAt: string | null; pod: string | null };

export function SuggestedPeople({ projectId, people, canAdd }: { projectId: string; people: Fit[]; canAdd: boolean }) {
  const router = useRouter(); const [busy, setBusy] = useState<string | null>(null);
  if (!people.length) return <p className={css.note}>Nobody stands out yet: no one has a domain or history in this kind of work.</p>;
  return <ul className={css.fitList}>{people.map((p) => <li key={p.id}>
    <Avatar name={p.name} id={p.id} photoAt={p.photoAt} size={26} />
    <span><Link href={`/people/${p.id}`}><b>{p.name}</b></Link><small>{p.why}</small></span>
    {canAdd ? <button type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={busy === p.id} aria-label={`Add ${p.name} to the project`} onClick={async () => {
      setBusy(p.id);
      try { const r = await post<{ added: number; invited: number }>(`work/projects/${projectId}/people`, { add: [p.id], remove: [] });
        notify({ id: "fit-add", tone: "success", title: r.added ? `${p.name.split(" ")[0]} added` : `${p.name.split(" ")[0]} invited`, timeout: 2500 }); router.refresh(); }
      catch (e) { notify({ id: "fit-add", tone: "error", title: "Not added", message: e instanceof Error ? e.message : "Not saved" }); } finally { setBusy(null); }
    }}><UserPlus size={13} aria-hidden="true" />Add</button> : null}
  </li>)}</ul>;
}
