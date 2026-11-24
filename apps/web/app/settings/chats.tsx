"use client";
// GROUP-ACCESS (owner, 25 Oct 2026): Settings → Chats, for admins and leadership: who reads the company's client group
// conversations. Members only (how Pulse starts), members + admins and leadership + pod heads for their pod's groups, or
// all staff. Applies to client groups only; the database decides every read and records each change (1098).
import { useCallback, useEffect, useState } from "react";
import { Crown, Eye, Info, Lock, Plus, UserCog, Users } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { dayTime, plural } from "../lib/format";
import { post } from "../records";
import { Panel, Skeleton, styles } from "../ui";
import css from "./chats.module.css";
import settings from "./settings.module.css";
import { lower, say as sayWords } from "../lib/words.mjs";
import { useWords } from "../org-code";
import { W } from "../kit/word";
import { useConfirm } from "../kit/dialogs";
import { BUILTIN, COLOURS, type Category } from "../lib/chat-groups.mjs";
import { GroupGlyph, LookPicker, useCategoryName } from "../chats/groups-ui";

type Readers = "members" | "leaders" | "staff";
type Data = { readers: Readers; changedAt: string | null; changedBy: string | null; clientGroups: number; untyped: number; staff: number; canChange: boolean };
const CHOICES: { value: Readers; label: string; detail: string; Icon: typeof Lock }[] = [
  { value: "members", label: "Members only", detail: "Only the people in a group read it. This is how Pulse starts.", Icon: Lock },
  { value: "leaders", label: "Members, admins and leadership", detail: `Admins and leadership read every client group, and {team} heads read their own {team}’s groups. Everyone else reads the groups they are in.`, Icon: Eye },
  { value: "staff", label: "All staff", detail: "Every member of staff reads every client group, for example to learn how the work is done. Freelancers and client-side people never do.", Icon: Users },
];
const why = (e: unknown) => e instanceof Error ? e.message : "Could not save";

/** Settings → Chats: who may make groups (and the company's group categories), then who reads client groups. */
export function ChatSettings() {
  return <><GroupMakers /><ClientGroupReaders /></>;
}

// CHAT-GROUPS (owner report EA #4: "who can make a group and who cannot"): the company's setting, for admins and
// leadership; everyone else reads it. Everyone (as before), managers and leadership, or leadership only; the others ask,
// and an approver makes the group with them as its admin. The database decides every group made (2530).
type Makers = "leaders" | "managers" | "everyone";
type Policy = { creators: Makers; categories: Category[]; canCreate: boolean; canChange: boolean; changedAt: string | null; changedBy: string | null; pending: number };
const MAKERS: { value: Makers; label: string; detail: string; Icon: typeof Lock }[] = [
  { value: "everyone", label: "Everyone", detail: "Anyone on staff can make a group. This is how Pulse starts.", Icon: Users },
  { value: "managers", label: "Managers and leadership", detail: "People who manage others, HR, admins and leadership. Others ask; their manager or leadership approves.", Icon: UserCog },
  { value: "leaders", label: "Leadership only", detail: "Admins and leadership. Everyone else asks; leadership approves.", Icon: Crown },
];
function GroupMakers() {
  const confirm = useConfirm();
  const words = useWords();
  const catName = useCategoryName();
  const [data, setData] = useState<Policy | null>(null), [error, setError] = useState(""), [choice, setChoice] = useState<Makers | null>(null), [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false), [name, setName] = useState(""), [icon, setIcon] = useState("hash"), [colour, setColour] = useState("teal");
  const load = useCallback(async () => {
    const r = await fetch("/api/v0/chats/group-policy", { cache: "no-store" }); const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error ?? "Settings → Chats is not available");
    return d as Policy;
  }, []);
  useEffect(() => { let live = true; load().then((d) => { if (live) setData(d); }).catch((e) => { if (live) setError(why(e)); }); return () => { live = false; }; }, [load]);
  if (error) return <Panel title="Who may make groups"><p className={styles.status} role="alert" style={{ padding: 14 }}>{error}</p></Panel>;
  if (!data) return <Panel title="Who may make groups"><div style={{ display: "grid", gap: 10, padding: 14 }}><Skeleton width="45%" /><Skeleton height={52} /><Skeleton height={52} /><Skeleton height={52} /></div></Panel>;
  const picked = choice ?? data.creators, label = MAKERS.find((c) => c.value === picked)!.label;
  async function save() {
    if (!data || picked === data.creators) return;
    if (picked !== "everyone" && !(await confirm({ title: `Let only ${picked === "managers" ? "managers and leadership" : "leadership"} make groups?`,
      body: "Groups already made stay as they are. Everyone else asks for a group, and an approver makes it with them as its admin. We note that you made this change.", confirmLabel: "Save" }))) return;
    setBusy(true);
    try { await post("chats/group-policy", { creators: picked }); setData(await load()); setChoice(null); notify({ id: "group-makers", tone: "success", title: `Groups: ${label.toLowerCase()} make them`, timeout: 3000 }); }
    catch (e) { notify({ id: "group-makers", tone: "error", title: "The setting was not changed", message: why(e) }); } finally { setBusy(false); }
  }
  async function category(body: Record<string, unknown>, done: string) {
    setBusy(true);
    try { const r = await post<{ categories: Category[] }>("chats/categories", body); setData((d) => d ? { ...d, categories: r.categories } : d); notify({ id: "group-category", tone: "success", title: done, timeout: 3000 }); setAdding(false); setName(""); }
    catch (e) { notify({ id: "group-category", tone: "error", title: "Not saved", message: why(e) }); } finally { setBusy(false); }
  }
  const own = data.categories.filter((c) => !c.builtin);
  return <Panel title="Who may make groups" sub="Team chat groups in Chats: who makes them, and the categories they sit in">
    <fieldset className={css.choices} disabled={!data.canChange || busy}>
      <legend>Groups can be made by</legend>
      {MAKERS.map(({ value, label: l, detail, Icon }) => <label key={value} className={css.choice} data-selected={picked === value || undefined}>
        <input type="radio" name="group-makers" value={value} checked={picked === value} onChange={() => setChoice(value)} />
        <Icon size={17} aria-hidden="true" /><span><b>{l}{data.creators === value ? <small> · current</small> : null}</b><small>{sayWords(detail, words)}</small></span>
      </label>)}
    </fieldset>
    <div className={css.foot}>
      <span>{data.pending ? `${plural(data.pending, "group request", "group requests")} waiting · ` : ""}{data.changedBy && data.changedAt ? `Changed by ${data.changedBy}, ${dayTime(data.changedAt)}` : "Inside a group, its admins choose who adds people and who sends messages."}</span>
      {data.canChange ? <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || picked === data.creators} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</button> : null}
    </div>
    <div className={css.cats} data-group-categories="">
      <h3>Group categories</h3>
      <p className={settings.note} data-tone="neutral"><Info size={15} aria-hidden="true" /><span>Chats → Groups shows a section for each category. A group&apos;s admins choose its category. Groups without one show under {sayWords("{Clients}", words)}, Projects or Teams when Pulse knows, else under Other groups.</span></p>
      <ul className={css.catList}>
        {[...BUILTIN, ...own].map((c) => <li key={c.id} data-category={c.id}><GroupGlyph icon={c.icon} colour={c.colour} size={26} square /><b>{catName(c)}</b>
          {c.builtin ? <small>Always there</small> : data.canChange ? <button type="button" className={styles.btn} disabled={busy} onClick={() => void category({ id: c.id, archived: true }, `${c.name} removed; its groups moved back`)}>Remove</button> : null}</li>)}
      </ul>
      {data.canChange ? adding ? <div className={css.catAdd}>
        <label><span>Name</span><input value={name} onChange={(e) => setName(e.target.value.slice(0, 40))} placeholder="e.g. Vendors" maxLength={40} autoFocus /></label>
        <LookPicker icon={icon} colour={COLOURS.includes(colour) ? colour : "teal"} onIcon={setIcon} onColour={setColour} />
        <span className={css.catAddActions}><button type="button" className={styles.btn} onClick={() => setAdding(false)}>Cancel</button>
          <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || name.trim().length < 2} onClick={() => void category({ name, icon, colour }, `Category added: ${name.trim()}`)}>Add category</button></span>
      </div> : <button type="button" className={styles.btn} onClick={() => setAdding(true)} disabled={own.length >= 12}><Plus size={15} aria-hidden="true" />Add a category</button> : null}
    </div>
  </Panel>;
}

function ClientGroupReaders() {
  const confirm = useConfirm();
  const words = useWords();
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
    if (!(await confirm(opening ? { title: `Let ${picked === "staff" ? "all staff" : `admins, leadership and ${lower(words.team)} heads`} read client groups they are not in?`,
        body: "They can read but not write, and nobody is told until they join. We note that you made this change.", confirmLabel: "Let them read" }
      : { title: "Let only members read client groups?", body: "People who read groups they are not in lose them now. Groups they joined stay.", confirmLabel: "Only members" }))) return;
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
      A <b>client group</b> is a group imported from WhatsApp or made in Pulse whose type is Client in the groups hub. Direct messages, <W k="teams" lc />, <W k="function" lc />s, Google groups, HR, finance and every group of another type stay with their members whatever you choose. Someone who is not in a group reads it read-only and gets no notifications from it; <b>Join to post</b> makes them a member. AI employees keep their own group roles. Every change is recorded with who made it.
    </span></p>
    <div className={css.foot}>
      <span>{plural(data.clientGroups, "client group", "client groups")} · {plural(data.staff, "member of staff", "members of staff")}{data.untyped ? ` · ${plural(data.untyped, "group", "groups")} not typed yet (Pulse reads their names when you open client groups up, as the groups hub does)` : ""}{data.changedBy && data.changedAt ? ` · Changed by ${data.changedBy}, ${dayTime(data.changedAt)}` : ""}</span>
      {data.canChange ? <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || picked === data.readers} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</button> : null}
    </div>
  </Panel>;
}
