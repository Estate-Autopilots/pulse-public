"use client";
// GROUP-ACCESS (owner, 25 Oct 2026): Settings → Chats, for admins and leadership: who reads the company's client group
// conversations. Members only (how Pulse starts), members + admins and leadership + pod heads for their pod's groups, or
// all staff. Applies to client groups only; the database decides every read and records each change (1098).
import { useCallback, useEffect, useState } from "react";
import { Eye, Info, Lock, Users } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { dayTime, plural } from "../lib/format";
import { post } from "../records";
import { Panel, Skeleton, styles } from "../ui";
import css from "./chats.module.css";
import settings from "./settings.module.css";

type Readers = "members" | "leaders" | "staff";
type Data = { readers: Readers; changedAt: string | null; changedBy: string | null; clientGroups: number; untyped: number; staff: number; canChange: boolean };
const CHOICES: { value: Readers; label: string; detail: string; Icon: typeof Lock }[] = [
  { value: "members", label: "Members only", detail: "Only the people in a group read it. This is how Pulse starts.", Icon: Lock },
  { value: "leaders", label: "Members, admins and leadership", detail: "Admins and leadership read every client group, and pod heads read their own pod’s groups. Everyone else reads the groups they are in.", Icon: Eye },
  { value: "staff", label: "All staff", detail: "Every member of staff reads every client group, for example to learn how the work is done. Freelancers and client-side people never do.", Icon: Users },
];
const why = (e: unknown) => e instanceof Error ? e.message : "Could not save";

export function ChatSettings() {
  const [data, setData] = useState<Data | null>(null), [error, setError] = useState(""), [choice, setChoice] = useState<Readers | null>(null), [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const r = await fetch("/api/v0/chats/group-access", { cache: "no-store" }); const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error ?? "Settings → Chats is not available");
    return d as Data;
  }, []);
  useEffect(() => { let live = true; load().then((d) => { if (live) setData(d); }).catch((e) => { if (live) setError(why(e)); }); return () => { live = false; }; }, [load]);
  if (error) return <Panel title="Client group conversations"><p className={styles.status} role="alert" style={{ padding: 14 }}>{error}</p></Panel>;
  if (!data) return <Panel title="Client group conversations"><div style={{ display: "grid", gap: 10, padding: 14 }}><Skeleton width="45%" /><Skeleton height={52} /><Skeleton height={52} /><Skeleton height={52} /></div></Panel>;
  const picked = choice ?? data.readers, label = CHOICES.find((c) => c.value === picked)!.label;
  async function save() {
    if (!data || picked === data.readers) return;
    const opening = picked !== "members";
    if (!window.confirm(opening ? `Let ${picked === "staff" ? "all staff" : "admins, leadership and pod heads"} read client group conversations they are not in? They read them read-only and are not notified until they join. The change is recorded with your name.`
      : "Only members will read client groups again. People who read groups they are not in lose them now; groups they joined stay.")) return;
    setBusy(true);
    try { setData(await post<Data>("chats/group-access", { readers: picked })); setChoice(null); notify({ id: "group-access", tone: "success", title: `Client groups: ${label.toLowerCase()}`, timeout: 3000 }); }
    catch (e) { notify({ id: "group-access", tone: "error", title: "The setting was not changed", message: why(e) }); } finally { setBusy(false); }
  }
  return <Panel title="Client group conversations" sub="Who reads the company’s client groups in Chats">
    <fieldset className={css.choices} disabled={!data.canChange || busy}>
      <legend>Client group conversations can be read by</legend>
      {CHOICES.map(({ value, label: l, detail, Icon }) => <label key={value} className={css.choice} data-selected={picked === value || undefined}>
        <input type="radio" name="group-readers" value={value} checked={picked === value} onChange={() => setChoice(value)} />
        <Icon size={17} aria-hidden="true" /><span><b>{l}{data.readers === value ? <small> · now</small> : null}</b><small>{detail}</small></span>
      </label>)}
    </fieldset>
    <p className={settings.note} data-tone="neutral"><Info size={15} aria-hidden="true" /><span>
      A <b>client group</b> is a group imported from WhatsApp or made in Pulse whose type is Client in the groups hub. Direct messages, pods, teams, Google groups, HR, finance and every group of another type stay with their members whatever you choose. Someone who is not in a group reads it read-only and gets no notifications from it; <b>Join to post</b> makes them a member. AI employees keep their own group roles. Every change is recorded with who made it.
    </span></p>
    <div className={css.foot}>
      <span>{plural(data.clientGroups, "client group", "client groups")} · {plural(data.staff, "member of staff", "members of staff")}{data.untyped ? ` · ${plural(data.untyped, "group", "groups")} not typed yet (Pulse reads their names when you open client groups up, as the groups hub does)` : ""}{data.changedBy && data.changedAt ? ` · Changed by ${data.changedBy}, ${dayTime(data.changedAt)}` : ""}</span>
      {data.canChange ? <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || picked === data.readers} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</button> : null}
    </div>
  </Panel>;
}
