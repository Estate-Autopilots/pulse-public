"use client";
// CHAT-GROUPS (owner report EA #4, 28 Oct 2026; built 22 Nov 2026): the Groups tab by category (a section per category,
// folded or open, the company's order, "Other groups" last), the top of the tab (New group, or Ask for a group where
// the company's setting says so; group requests waiting on me), the requests themselves, a group's icon and colour, its
// category, and its rules (who adds people, who sends messages) and notifications in Group info.
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { ArrowLeft, Bell, BellOff, Briefcase, Bug, Building2, Calendar, Camera, Check, ChevronDown, Film, FolderKanban, Hash, LifeBuoy, Megaphone, Palette, PenTool, Plus,
  Sparkles, Truck, Users, Wallet, X, type LucideIcon } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { BUILTIN, COLOURS, ICONS, groupSections, sectionOpen, type Category } from "../lib/chat-groups.mjs";
import { say as sayWords } from "../lib/words.mjs";
import { useOrgZone, useWords } from "../org-code";
import { get, send } from "./net";
import type { Channel, ChatData, GroupRequest } from "./types";
import css from "./chats.module.css";
import g from "./groups-ui.module.css";

const GLYPHS: Record<string, LucideIcon> = { hash: Hash, users: Users, "folder-kanban": FolderKanban, briefcase: Briefcase, bug: Bug, megaphone: Megaphone, "building-2": Building2,
  palette: Palette, camera: Camera, film: Film, "pen-tool": PenTool, truck: Truck, wallet: Wallet, "life-buoy": LifeBuoy, sparkles: Sparkles, calendar: Calendar };
const COLOUR_NAMES: Record<string, string> = { slate: "Slate", blue: "Blue", green: "Green", amber: "Amber", red: "Red", violet: "Violet", teal: "Teal", pink: "Pink" };
const ICON_NAMES: Record<string, string> = { hash: "Hash", users: "People", "folder-kanban": "Folder", briefcase: "Briefcase", bug: "Bug", megaphone: "Megaphone", "building-2": "Office",
  palette: "Palette", camera: "Camera", film: "Film", "pen-tool": "Pen", truck: "Truck", wallet: "Wallet", "life-buoy": "Life buoy", sparkles: "Sparkles", calendar: "Calendar" };

/** A group's or category's mark: its icon on its colour (round for a group, a small square for a category). */
export function GroupGlyph({ icon, colour, size = 48, square = false, label }: { icon?: string | null; colour?: string | null; size?: number; square?: boolean; label?: string }) {
  const Icon = GLYPHS[icon ?? ""] ?? Hash;
  return <span className={g.glyph} data-colour={COLOURS.includes(colour ?? "") ? colour : "slate"} data-square={square || undefined} style={{ "--size": `${size}px` } as CSSProperties}
    role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}><Icon size={Math.max(12, Math.round(size * 0.5))} strokeWidth={2.2} /></span>;
}

/** A category's name in the company's own words ({Teams}, {Clients}). */
export function useCategoryName() {
  const words = useWords();
  return useCallback((c: Pick<Category, "id" | "name" | "builtin">) => c.builtin && c.id === "teams" ? sayWords("{Teams}", words) : c.builtin && c.id === "clients" ? sayWords("{Clients}", words) : c.name, [words]);
}

const FOLD_KEY = "pulse.chats.folded";
const foldListeners = new Set<() => void>();
const readFolded = () => { try { return window.localStorage.getItem(FOLD_KEY) ?? ""; } catch { return ""; } };
const onFolded = (l: () => void) => { foldListeners.add(l); return () => { foldListeners.delete(l); }; };
const noFolded = () => "";
const PAGE = 8, MORE = 50;
// As v3.tsx (not imported: parts.tsx draws a group's glyph from here, and v3 imports parts).
const mutedNow = (until?: string | null) => !!until && (until === "infinity" || Date.parse(until) > Date.now());
/** "Muted until 23 Nov, 03:10" in the company's time; "Muted" when it is for good (or a year and more). */
const mutedLine = (until: string | null | undefined, zone: string) => !until || until.startsWith("infinity") || Date.parse(until) >= Date.now() + 365 * 86400000 ? "Muted"
  : `Muted until ${new Date(until).toLocaleString("en-IN", { timeZone: zone, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`;

/** The Groups tab: one section per category with groups in it. A section folds (remembered in this browser) and shows its
 *  first groups, then "Show more" (a company with hundreds of client groups keeps a short list). */
export function GroupSections<T extends Channel>({ channels, categories, row, searching = false }: { channels: T[]; categories: Category[]; row: (c: T) => ReactNode; searching?: boolean }) {
  const name = useCategoryName();
  const raw = useSyncExternalStore(onFolded, readFolded, noFolded);
  const folded = useMemo(() => new Set(raw.split(",").filter(Boolean)), [raw]);
  const [shown, setShown] = useState<Record<string, number>>({});
  const sections = useMemo(() => groupSections(channels, categories), [channels, categories]);
  const toggle = (key: string) => {
    const next = new Set(folded); if (next.has(key)) next.delete(key); else next.add(key);
    try { window.localStorage.setItem(FOLD_KEY, [...next].join(",")); } catch { /* private window */ }
    foldListeners.forEach((l) => l());
  };
  return <>{sections.map((s) => {
    const open = sectionOpen(s.id, folded, searching), limit = shown[s.id] ?? PAGE, list = open ? s.channels.slice(0, limit) : [];
    return <section key={s.id} className={g.section} data-group-section={s.id} aria-label={name(s)}>
      <h3 className={g.sectionHead}><button type="button" aria-expanded={open} onClick={() => toggle(s.id)} data-section-toggle={s.id}>
        <GroupGlyph icon={s.icon} colour={s.colour} size={24} square />
        <span className={g.sectionName}>{name(s)}</span>
        {/* Open, each group shows its own news; folded, the head says how many groups and how many have news. */}
        {open ? null : <small className={g.sectionCount}>{s.channels.length === 1 ? "1 group" : `${s.channels.length} groups`}</small>}
        {!open && s.unread ? <b className={g.sectionUnread} aria-label={`${s.unread} with unread messages`}>{s.unread > 99 ? "99+" : s.unread}</b> : null}
        <ChevronDown size={16} aria-hidden="true" className={g.chev} data-open={open || undefined} />
      </button></h3>
      {list.map(row)}
      {open && s.channels.length > list.length ? <button type="button" className={g.more} onClick={() => setShown((x) => ({ ...x, [s.id]: limit + MORE }))}>
        Show {Math.min(MORE, s.channels.length - list.length)} more of {s.channels.length}</button> : null}
    </section>;
  })}</>;
}

/** The top of the Groups tab: make a group (or ask for one), and the requests waiting on me. */
export function GroupsTop({ data, onNew, onRequests }: { data: ChatData; onNew: () => void; onRequests: () => void }) {
  const ctx = data.groups;
  if (!ctx) return null;
  const waiting = ctx.requests.waiting, mine = ctx.requests.mine;
  return <div className={g.top} data-groups-top="">
    <div className={g.newRow}>
      <button type="button" className={g.newBtn} onClick={onNew} data-new-group={ctx.canCreate ? "make" : "ask"}><Plus size={17} aria-hidden="true" />{ctx.canCreate ? "New group" : "Ask for a group"}</button>
      {ctx.canCreate ? null : <small>{ctx.creators === "managers" ? "A manager or leadership approves it" : "Leadership approves it"}</small>}
    </div>
    {waiting ? <button type="button" className={g.banner} onClick={onRequests} data-requests-waiting={waiting}>
      <Users size={16} aria-hidden="true" /><span><b>{waiting === 1 ? "1 group request" : `${waiting} group requests`}</b> to answer</span><span className={g.bannerGo}>Review</span></button>
      : mine ? <button type="button" className={g.banner} onClick={onRequests} data-requests-mine={mine}>
        <Users size={16} aria-hidden="true" /><span>{mine === 1 ? "Your request" : `${mine} requests`} {mine === 1 ? "waits" : "wait"} for {ctx.creators === "managers" ? "a manager" : "leadership"}</span><span className={g.bannerGo}>See</span></button> : null}
  </div>;
}

/** "Rifob Das asks for a Teams group with Tara Iyer · waiting" */
function requestLine(r: GroupRequest, category: string | null) {
  const who = r.mine ? "You asked" : `${r.requestedByName} asks`, kind = category ? `a ${category} group` : "a group";
  const people = r.people?.length ? ` with ${r.people.slice(0, 3).join(", ")}${r.people.length > 3 ? ` and ${r.people.length - 3} more` : ""}` : "";
  return `${who} for ${kind}${people}`;
}
/** Group requests: the ones waiting on me (approve, or decline with a reason), and mine (withdraw one still waiting). */
export function GroupRequests({ onBack, onOpen, onChanged, categories = BUILTIN }: { onBack: () => void; onOpen: (id: string) => void; onChanged: () => Promise<void> | void; categories?: Category[] }) {
  const name = useCategoryName();
  const catLabel = (key?: string | null) => { const c = categories.find((x) => x.id === key); return c ? name(c) : null; };
  const [list, setList] = useState<GroupRequest[] | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState<string | null>(null), [declining, setDeclining] = useState<string | null>(null), [why, setWhy] = useState("");
  const load = useCallback(async () => { try { setList((await get<{ requests: GroupRequest[] }>("chats/group-requests")).requests); setError(""); } catch (e) { setError((e as Error).message); } }, []);
  useEffect(() => { queueMicrotask(() => void load()); }, [load]);
  async function act(r: GroupRequest, body: Record<string, unknown>, done: string) {
    setBusy(r.id); setError("");
    try { const out = await send<GroupRequest>(`chats/group-requests/${r.id}`, body); notify({ id: `group-request-${r.id}`, tone: "success", title: done, timeout: 3000 }); setDeclining(null); setWhy(""); await load(); await onChanged(); if (out.channelId && body.approve === true) onOpen(out.channelId); }
    catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  }
  const waiting = (list ?? []).filter((r) => r.canDecide), mine = (list ?? []).filter((r) => r.mine);
  const card = (r: GroupRequest) => <li key={r.id} className={g.request} data-request={r.status}>
    <GroupGlyph icon={r.meta.icon ?? BUILTIN.find((c) => c.id === r.meta.category)?.icon} colour={r.meta.colour ?? BUILTIN.find((c) => c.id === r.meta.category)?.colour} size={40} />
    <div className={g.requestMain}>
      <small className={g.requestWho}>{requestLine(r, catLabel(r.meta.category))}</small>
      <b>{r.name}</b>
      {r.status !== "pending" ? <small className={g.requestState} data-state={r.status}>{r.status === "approved" ? `Approved by ${r.decidedByName ?? "an approver"}` : r.status === "declined" ? `Declined by ${r.decidedByName ?? "an approver"}` : "Withdrawn"}</small> : null}
      {r.description ? <p>{r.description}</p> : null}
      {r.note ? <p className={g.quote}><span>Why:</span> {r.note}</p> : null}
      {r.decisionNote ? <p className={g.quote}>{r.decidedByName ?? "Answer"}: “{r.decisionNote}”</p> : null}
      {r.canDecide && declining === r.id ? <div className={g.decline}>
        <textarea value={why} onChange={(e) => setWhy(e.target.value.slice(0, 300))} placeholder="Why not? (optional, they see it)" aria-label="Why not" rows={2} autoFocus />
        <span><button type="button" className={css.secondary} onClick={() => setDeclining(null)}>Cancel</button><button type="button" className={css.danger} disabled={busy === r.id} onClick={() => void act(r, { approve: false, note: why }, "Declined")}>Decline</button></span></div>
        : r.canDecide ? <span className={g.requestActions}><button type="button" className={css.secondary} onClick={() => setDeclining(r.id)} disabled={busy === r.id}><X size={15} aria-hidden="true" />Decline</button>
          <button type="button" className={css.primary} onClick={() => void act(r, { approve: true }, `Approved: ${r.name}`)} disabled={busy === r.id}><Check size={15} aria-hidden="true" />{busy === r.id ? "Approving…" : "Approve"}</button></span>
        : r.mine && r.status === "pending" ? <span className={g.requestActions}><button type="button" className={css.secondary} onClick={() => void act(r, { withdraw: true }, "Request withdrawn")} disabled={busy === r.id}>Withdraw</button></span>
        : r.status === "approved" && r.channelId ? <span className={g.requestActions}><button type="button" className={css.secondary} onClick={() => onOpen(r.channelId!)}>Open the group</button></span> : null}
    </div>
  </li>;
  return <div className={g.requests} data-group-requests="">
    <button type="button" className={g.back} onClick={onBack}><ArrowLeft size={16} aria-hidden="true" />Back to groups</button>
    {error ? <p className={css.sideError} role="alert">{error}</p> : null}
    {!list ? <p className={css.empty} role="status">Opening group requests…</p> : <>
      {waiting.length ? <section aria-label="Waiting for you"><h2 className={g.listHead}>Waiting for you</h2><ul>{waiting.map(card)}</ul></section> : null}
      {mine.length ? <section aria-label="Your requests"><h2 className={g.listHead}>Your requests</h2><ul>{mine.map(card)}</ul></section> : null}
      {!waiting.length && !mine.length ? <p className={css.empty}>No group requests right now.</p> : null}
    </>}
  </div>;
}

/** Pick an icon and a colour (a group's or a category's). */
export function LookPicker({ icon, colour, onIcon, onColour }: { icon: string; colour: string; onIcon: (v: string) => void; onColour: (v: string) => void }) {
  return <div className={g.look}>
    <div role="radiogroup" aria-label="Colour" className={g.swatches}>{COLOURS.map((c) =>
      <button key={c} type="button" role="radio" aria-checked={colour === c} aria-label={COLOUR_NAMES[c]} title={COLOUR_NAMES[c]} className={g.swatch} data-colour={c} onClick={() => onColour(c)}>{colour === c ? <Check size={14} aria-hidden="true" /> : null}</button>)}</div>
    <div role="radiogroup" aria-label="Icon" className={g.icons}>{ICONS.map((i) => { const Icon = GLYPHS[i] ?? Hash;
      return <button key={i} type="button" role="radio" aria-checked={icon === i} aria-label={ICON_NAMES[i] ?? i} title={ICON_NAMES[i] ?? i} className={g.iconPick} data-colour={colour} onClick={() => onIcon(i)}><Icon size={18} aria-hidden="true" /></button>; })}</div>
  </div>;
}

/** Pick a category (or none: "Other groups"). */
export function CategoryPicker({ categories, value, onChange, label = "Category" }: { categories: Category[]; value: string | null; onChange: (v: string | null) => void; label?: string }) {
  const name = useCategoryName();
  return <div role="radiogroup" aria-label={label} className={g.cats}>
    {categories.map((c) => <button key={c.id} type="button" role="radio" aria-checked={value === c.id} className={g.cat} data-colour={c.colour} onClick={() => onChange(c.id)} data-category={c.id}>
      <GroupGlyph icon={c.icon} colour={c.colour} size={20} square />{name(c)}</button>)}
    <button type="button" role="radio" aria-checked={value === null} className={g.cat} onClick={() => onChange(null)} data-category="other"><GroupGlyph icon="hash" colour="slate" size={20} square />None</button>
  </div>;
}

/** Two choices side by side (who adds people, who sends messages). */
function Choice<V extends string>({ label, value, options, onChange, disabled }: { label: string; value: V; options: [V, string][]; onChange: (v: V) => void; disabled?: boolean }) {
  return <div className={g.choice}><span>{label}</span><div role="radiogroup" aria-label={label} className={g.segments}>{options.map(([v, l]) =>
    <button key={v} type="button" role="radio" aria-checked={value === v} disabled={disabled} onClick={() => { if (value !== v) onChange(v); }}>{l}</button>)}</div></div>;
}

/** New group (and Ask for a group): the group's look, category, description and rules. */
export type GroupDraft = { category: string | null; icon: string; colour: string; description: string; adders: "admins" | "members"; posting: "everyone" | "admins" };
export function draftFor(category: string | null, categories: Category[]): Pick<GroupDraft, "icon" | "colour" | "posting"> {
  const c = categories.find((x) => x.id === category);
  return { icon: c?.icon ?? "users", colour: c?.colour ?? "blue", posting: category === "announcements" ? "admins" : "everyone" };
}
export function GroupDraftFields({ draft, categories, onChange, asking }: { draft: GroupDraft; categories: Category[]; onChange: (d: GroupDraft) => void; asking: boolean }) {
  const [look, setLook] = useState(false);
  return <div className={g.draft}>
    <label className={css.nameField}><span>Description (optional)</span>
      <textarea className={g.textarea} value={draft.description} onChange={(e) => onChange({ ...draft, description: e.target.value.slice(0, 300) })} placeholder="What the group is for" rows={2} maxLength={300} /></label>
    <div className={g.field}><span className={g.fieldLabel}>Category <small>· where it is listed in Groups</small></span>
      <CategoryPicker categories={categories} value={draft.category} onChange={(category) => onChange({ ...draft, category, ...draftFor(category, categories) })} /></div>
    <div className={g.field}><button type="button" className={g.lookToggle} aria-expanded={look} onClick={() => setLook(!look)} data-more-options="">
      <GroupGlyph icon={draft.icon} colour={draft.colour} size={28} /><span>More: icon, colour, who can post<small>{draft.posting === "admins" ? "Only admins send messages" : "Everyone sends messages"} · {draft.adders === "members" ? "every member adds people" : "admins add people"}</small></span>
      <ChevronDown size={15} aria-hidden="true" className={g.chev} data-open={look || undefined} /></button>
      {look ? <div className={g.moreBox}>
        <LookPicker icon={draft.icon} colour={draft.colour} onIcon={(icon) => onChange({ ...draft, icon })} onColour={(colour) => onChange({ ...draft, colour })} />
        <Choice label="Who adds people" value={draft.adders} options={[["admins", "Admins"], ["members", "Every member"]]} onChange={(adders) => onChange({ ...draft, adders })} />
        <Choice label="Who sends messages" value={draft.posting} options={[["everyone", "Everyone"], ["admins", "Only admins"]]} onChange={(posting) => onChange({ ...draft, posting })} />
        {draft.posting === "admins" ? <p className={css.hint}>Others reply in a message&apos;s thread{asking ? "" : "; you can change it later in Group info"}.</p> : null}
      </div> : null}</div>
  </div>;
}

/** Group info: the category, icon and colour, the rules, and my notifications for this group. */
export function GroupSettings({ channel, data, onChanged, onError }: { channel: Channel; data: ChatData; onChanged: () => Promise<void> | void; onError: (m: string) => void }) {
  const name = useCategoryName(), zone = useOrgZone();
  const categories = data.groups?.categories ?? BUILTIN;
  const own = channel.kind === "custom" && channel.myRole === "admin", lead = !!data.groups?.canChange, may = own || lead;
  const [look, setLook] = useState(false), [cat, setCat] = useState(false), [busy, setBusy] = useState(false);
  const muted = mutedNow(channel.mutedUntil);
  const category = categories.find((c) => c.id === channel.category) ?? null;
  async function set(body: Record<string, unknown>, done?: string) {
    if (busy) return; setBusy(true);
    try { await send(`chats/groups/${channel.id}/settings`, body); await onChanged(); if (done) notify({ id: `group-settings-${channel.id}`, tone: "success", title: done, timeout: 2500 }); }
    catch (e) { onError((e as Error).message); } finally { setBusy(false); }
  }
  async function mute(until: string | null) { try { await send(`chats/${channel.id}/mute`, { until }); await onChanged(); } catch (e) { onError((e as Error).message); } }
  if (channel.kind === "direct" || channel.moderationOnly) return null;
  return <section className={g.settings} aria-label="Group settings" data-group-settings="">
    <h4 className={g.settingsHead}>Group settings</h4>
    <div className={g.settingRow}><span className={g.fieldLabel}>Category</span>
      <span className={g.settingValue}><GroupGlyph icon={category?.icon ?? "hash"} colour={category?.colour ?? "slate"} size={20} square />{category ? name(category) : "Other groups"}</span>
      {may ? <button type="button" className={css.linkBtn} onClick={() => setCat(!cat)} aria-expanded={cat}>{cat ? "Done" : "Change"}</button> : null}</div>
    {cat ? <CategoryPicker categories={categories} value={category?.id ?? null} onChange={(v) => void set({ category: v }, v ? `Filed under ${name(categories.find((c) => c.id === v)!)}` : "Moved to Other groups")} /> : null}
    {may && !channel.photoAt ? <div className={g.settingRow}><span className={g.fieldLabel}>Icon</span>
      <span className={g.settingValue}><GroupGlyph icon={channel.icon ?? category?.icon} colour={channel.colour ?? category?.colour} size={24} />{ICON_NAMES[channel.icon ?? category?.icon ?? "hash"] ?? "Icon"}</span>
      <button type="button" className={css.linkBtn} onClick={() => setLook(!look)} aria-expanded={look}>{look ? "Done" : "Change"}</button></div> : null}
    {look ? <LookPicker icon={channel.icon ?? category?.icon ?? "users"} colour={channel.colour ?? category?.colour ?? "blue"} onIcon={(icon) => void set({ icon })} onColour={(colour) => void set({ colour })} /> : null}
    {channel.kind === "custom" ? <>
      <Choice label="Who adds people" value={channel.adders ?? "admins"} options={[["admins", "Admins"], ["members", "Every member"]]} disabled={!own || busy} onChange={(adders) => void set({ adders })} />
      <Choice label="Who sends messages" value={channel.posting ?? "everyone"} options={[["everyone", "Everyone"], ["admins", "Only admins"]]} disabled={!own || busy} onChange={(posting) => void set({ posting })} />
      {!own ? <p className={css.hint}>The group&apos;s admins choose these.</p> : null}
    </> : null}
    {!channel.browsing ? <div className={g.settingRow}><span className={g.fieldLabel}>Notifications</span>
      <span className={g.settingValue}>{muted ? <><BellOff size={15} aria-hidden="true" />{mutedLine(channel.mutedUntil, zone)}</> : <><Bell size={15} aria-hidden="true" />On</>}</span>
      {muted ? <button type="button" className={css.linkBtn} onClick={() => void mute(null)}>Unmute</button>
        : <span className={g.muteChoices}><span className={g.muteLabel}>Mute:</span><button type="button" className={css.linkBtn} onClick={() => void mute(new Date(Date.now() + 8 * 3600000).toISOString())} aria-label="Mute for 8 hours">8 hours</button><button type="button" className={css.linkBtn} onClick={() => void mute("always")} aria-label="Mute always">Always</button></span>}</div> : null}
    {muted ? <p className={css.hint}>Muted: no sound or push from this group. Mentions and replies to you still come.</p> : null}
  </section>;
}
