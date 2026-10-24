"use client";
// New chat (one button, then a person), New group (members, then a name and a photo) and the details drawer: a person
// with their presence, or a group's members by department with what an admin of a group may change.
import Link from "next/link";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ArrowLeft, ArrowRight, Camera, Check, LogOut, MessageCircle, Pin, PinOff, Search, Shield, Trash2, UserPlus, Users, X } from "lucide-react";
import { Avatar } from "../ui";
import { AiBadge } from "../kit/ai-badge";
import { PresenceLine } from "../presence";
import { byDepartment, kindLabel } from "../lib/chat-format.mjs";
import { cachedThread, storeVersion, subscribe } from "./store";
import { GroupAvatar, syncThread } from "./parts";
import { Confirm } from "./conversation";
import { ChatAside, MEDIA_EVENT } from "./aside";
import { Gallery } from "./v3";
import { send } from "./net";
import type { Channel, ChatData, Member } from "./types";
import css from "./chats.module.css";

const matches = (p: Member, q: string) => `${p.name} ${p.username ?? ""} ${p.team ?? ""} ${p.pod ?? ""}`.toLowerCase().includes(q.trim().toLowerCase());
/** A photo made small in the browser (256 px, JPEG) before it is sent: groups do not need a camera original. */
async function shrink(file: File): Promise<{ mime: string; bytes: string }> {
  const bitmap = await createImageBitmap(file); const side = 256, scale = Math.max(side / bitmap.width, side / bitmap.height);
  const canvas = document.createElement("canvas"); canvas.width = side; canvas.height = side;
  canvas.getContext("2d")!.drawImage(bitmap, (side - bitmap.width * scale) / 2, (side - bitmap.height * scale) / 2, bitmap.width * scale, bitmap.height * scale);
  const blob = await new Promise<Blob>((ok, no) => canvas.toBlob((b) => b ? ok(b) : no(new Error("Could not read that photo")), "image/jpeg", 0.86));
  const bytes = await new Promise<string>((ok) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(",")[1]); r.readAsDataURL(blob); });
  return { mime: "image/jpeg", bytes };
}

function PersonRow({ p, onClick, picked, end }: { p: Member; onClick: () => void; picked?: boolean; end?: React.ReactNode }) {
  return <button type="button" className={css.row} onClick={onClick} aria-pressed={picked}>
    <Avatar ai={p.agent} name={p.name} id={p.id} photoAt={p.photoAt} size={44} status />
    <span className={css.rowMain}><span className={css.rowTop}><b>{p.name}{p.agent ? <AiBadge employeeId={p.employeeId} /> : null}</b></span><span className={css.rowBottom}><span className={css.preview}>{[p.team, p.pod].filter(Boolean).join(" · ") || "Team member"}</span></span></span>
    {picked !== undefined ? <span className={css.check} data-on={picked || undefined} aria-hidden="true">{picked ? <Check size={14} /> : null}</span> : end}
  </button>;
}

export function NewChat({ data, onClose, onPick, onGroup }: { data: ChatData; onClose: () => void; onPick: (p: Member) => void; onGroup: () => void }) {
  const [q, setQ] = useState("");
  const people = useMemo(() => [...data.people, ...(q ? data.searchOnly ?? [] : [])].filter((p) => p.id !== data.viewer && matches(p, q)), [data, q]);
  const letters = useMemo(() => { const out: [string, Member[]][] = []; for (const p of people) { const l = p.name[0]?.toUpperCase() ?? "#"; if (out.at(-1)?.[0] === l) out.at(-1)![1].push(p); else out.push([l, [p]]); } return out; }, [people]);
  return <div className={css.panel}>
    <header className={css.panelHead}><button type="button" className={css.iconBtn} onClick={onClose} aria-label="Back to chats"><ArrowLeft size={20} aria-hidden="true" /></button><h2>New chat</h2></header>
    <label className={css.search}><Search size={16} aria-hidden="true" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a name, department or pod" aria-label="Search people" autoFocus /></label>
    <div className={css.rows}>
      {!q ? <button type="button" className={css.row} onClick={onGroup}><span className={css.channelIcon} data-channel="group" aria-hidden="true"><Users size={20} /></span><span className={css.rowMain}><span className={css.rowTop}><b>New group</b></span><span className={css.rowBottom}><span className={css.preview}>A name, the people, a photo</span></span></span></button> : null}
      {letters.map(([l, ps]) => <section key={l} aria-label={l}><h2 className={css.letter}>{l}</h2>{ps.map((p) => <PersonRow key={p.id} p={p} onClick={() => onPick(p)} />)}</section>)}
      {!people.length ? <p className={css.empty}>Nobody matches “{q}”.</p> : null}
    </div>
  </div>;
}

export function NewGroup({ data, onClose, onCreated }: { data: ChatData; onClose: () => void; onCreated: (id: string) => Promise<void> | void }) {
  const [step, setStep] = useState<1 | 2>(1), [q, setQ] = useState(""), [picked, setPicked] = useState<Member[]>([]), [name, setName] = useState("");
  const [photo, setPhoto] = useState<File | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const preview = useMemo(() => photo ? URL.createObjectURL(photo) : null, [photo]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  const fileRef = useRef<HTMLInputElement>(null);
  const people = [...data.people, ...(q ? data.searchOnly ?? [] : [])].filter((p) => p.id !== data.viewer && matches(p, q));
  const toggle = (p: Member) => setPicked((x) => x.some((y) => y.id === p.id) ? x.filter((y) => y.id !== p.id) : [...x, p]);
  async function create() {
    if (busy || name.trim().length < 2) return; setBusy(true); setError("");
    try {
      const { id } = await send<{ id: string }>("chats/groups", { name, memberIds: picked.map((p) => p.id) });
      if (photo) await send(`chats/groups/${id}/photo`, await shrink(photo)).catch(() => { /* the group stands without its photo */ });
      await onCreated(id);
    } catch (e) { setError((e as Error).message); setBusy(false); }
  }
  return <div className={css.panel}>
    <header className={css.panelHead}><button type="button" className={css.iconBtn} onClick={step === 2 ? () => setStep(1) : onClose} aria-label={step === 2 ? "Back to members" : "Back to chats"}><ArrowLeft size={20} aria-hidden="true" /></button>
      <h2>{step === 1 ? "Add group members" : "New group"}</h2></header>
    {step === 1 ? <>
      {picked.length ? <div className={css.chosen}>{picked.map((p) => <button key={p.id} type="button" onClick={() => toggle(p)} aria-label={`Remove ${p.name}`}><Avatar ai={p.agent} name={p.name} id={p.id} photoAt={p.photoAt} size={22} />{p.name.split(" ")[0]}<X size={13} aria-hidden="true" /></button>)}</div> : null}
      <label className={css.search}><Search size={16} aria-hidden="true" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a name, department or pod" aria-label="Search people" autoFocus /></label>
      <div className={css.rows}>{people.map((p) => <PersonRow key={p.id} p={p} picked={picked.some((x) => x.id === p.id)} onClick={() => toggle(p)} />)}</div>
      <footer className={css.panelFoot}><span>{picked.length ? `${picked.length} selected` : "Choose at least one person"}</span><button type="button" className={css.fab} disabled={!picked.length} onClick={() => setStep(2)} aria-label="Next"><ArrowRight size={20} aria-hidden="true" /></button></footer>
    </> : <div className={css.groupForm}>
      <button type="button" className={css.photoPick} onClick={() => fileRef.current?.click()} aria-label="Add a group photo">
        {/* eslint-disable-next-line @next/next/no-img-element -- a local preview before upload */}
        {preview ? <img src={preview} alt="" /> : <><Camera size={26} aria-hidden="true" /><small>Add photo</small></>}</button>
      <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => setPhoto(e.target.files?.[0] ?? null)} />
      <label className={css.nameField}><span>Group name</span><input value={name} onChange={(e) => setName(e.target.value.slice(0, 60))} placeholder="e.g. Launch crew" autoFocus maxLength={60} onKeyDown={(e) => { if (e.key === "Enter") void create(); }} /></label>
      <p className={css.hint}>{picked.length + 1} people, you included. You’re the group’s admin: you can rename it, change the photo and add or remove people.</p>
      {error ? <p className={css.sideError} role="alert">{error}</p> : null}
      <button type="button" className={css.primary} disabled={busy || name.trim().length < 2} onClick={() => void create()}><Check size={16} aria-hidden="true" />{busy ? "Creating…" : "Create group"}</button>
    </div>}
  </div>;
}

export function InfoPanel({ channel, data, onClose, onChanged, onMessage, onLeft, onPin }: { channel: Channel; data: ChatData; onClose: () => void; onChanged: () => Promise<void>; onMessage: (p: Member) => void; onLeft: () => void; onPin: () => void }) {
  useSyncExternalStore(subscribe, storeVersion, () => 0);
  const members = cachedThread(channel.id)?.members ?? [];
  const former = cachedThread(channel.id)?.formerMembers ?? [];
  const admin = channel.kind === "custom" && channel.myRole === "admin";
  const [editing, setEditing] = useState(false), [name, setName] = useState(channel.name), [description, setDescription] = useState(channel.description);
  const [adding, setAdding] = useState(false), [q, setQ] = useState(""), [add, setAdd] = useState<string[]>([]), [error, setError] = useState(""), [leaving, setLeaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; document.addEventListener("keydown", k); return () => document.removeEventListener("keydown", k); }, [onClose]);
  const act = async (path: string, body: unknown) => { setError(""); try { await send(path, body); await syncThread(channel.id); await onChanged(); return true; } catch (e) { setError((e as Error).message); return false; } };
  const peer = channel.kind === "direct" ? [...members, ...data.people].find((p) => p.id === channel.peerId) : null;
  const outside = data.people.filter((p) => !members.some((m) => m.id === p.id) && (!q || matches(p, q)));
  return <ChatAside className={css.info} label={channel.kind === "direct" ? "Contact info" : "Group info"}>
    <header className={css.panelHead}><button type="button" className={css.iconBtn} onClick={onClose} aria-label="Close details"><X size={20} aria-hidden="true" /></button><h2>{channel.kind === "direct" ? "Contact info" : "Group info"}</h2></header>
    <div className={css.infoBody}>
      <div className={css.infoHero}>
        {admin ? <button type="button" className={css.heroPhoto} onClick={() => fileRef.current?.click()} aria-label="Change the group photo"><GroupAvatar channel={channel} size={96} /><span><Camera size={16} aria-hidden="true" /></span></button> : <GroupAvatar channel={channel} size={96} />}
        <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) { try { await act(`chats/groups/${channel.id}/photo`, await shrink(f)); } catch (x) { setError((x as Error).message); } } }} />
        {editing ? <div className={css.editName}><input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} aria-label="Group name" autoFocus /><textarea value={description} onChange={(e) => setDescription(e.target.value.slice(0, 300))} placeholder="Description (optional)" aria-label="Description" rows={2} />
          <span><button type="button" className={css.secondary} onClick={() => setEditing(false)}>Cancel</button><button type="button" className={css.primary} onClick={async () => { if (await act(`chats/groups/${channel.id}`, { name, description })) setEditing(false); }}>Save</button></span></div>
          : <><h3>{channel.peerAgent && channel.peerId ? <Link href={`/people/ai/${encodeURIComponent(channel.peerId)}`}>{channel.name}</Link> : channel.name}{channel.peerAgent ? <AiBadge employeeId={peer?.employeeId} /> : null}{admin ? <button type="button" className={css.linkBtn} onClick={() => setEditing(true)}>Edit</button> : null}</h3>
            {peer ? <>{peer.agent ? <small>AI employee</small> : <PresenceLine id={peer.id} />}<p className={css.hint}>{[peer.team, peer.pod].filter(Boolean).join(" · ")}{peer.username ? ` · @${peer.username}` : ""}</p></>
              : <p className={css.hint}>{kindLabel(channel.kind)} · {channel.members} member{channel.members === 1 ? "" : "s"}</p>}</>}
      </div>
      {channel.kind !== "direct" ? <p className={css.infoNote}>{channel.description || "No description."}{channel.kind !== "custom" ? <><br /><small>Membership follows Pulse: who is in a pod or department comes from People, so it updates by itself.</small></> : null}</p> : null}
      {error ? <p className={css.sideError} role="alert">{error}</p> : null}
      <div className={css.infoActions}>
        {peer ? <Link href={peer.agent ? `/people/ai/${encodeURIComponent(peer.id)}` : `/people/${peer.id}`} className={css.secondary}>View profile</Link> : null}
        {!channel.moderationOnly ? <button type="button" className={css.secondary} onClick={onPin}>{channel.pinnedAt ? <PinOff size={15} aria-hidden="true" /> : <Pin size={15} aria-hidden="true" />}{channel.pinnedAt ? "Unpin" : "Pin"}</button> : null}
      </div>
      {/* CHAT-V4: what was shared here, a glance away: the latest photos and the count; "all" opens the gallery column. */}
      {!channel.moderationOnly ? <div className={css.infoMedia}><Gallery channel={channel} compact onOpenImage={(m, f) => window.dispatchEvent(new CustomEvent(MEDIA_EVENT, { detail: { m, f } }))}
        onAll={() => window.dispatchEvent(new CustomEvent(MEDIA_EVENT, { detail: {} }))} onJump={() => {}} /></div> : null}
      {channel.kind !== "direct" ? <section className={css.members} aria-label="Members">
        <h4>{members.length || channel.members} members{admin ? <button type="button" className={css.linkBtn} onClick={() => setAdding(!adding)}><UserPlus size={15} aria-hidden="true" />Add people</button> : null}</h4>
        {adding ? <div className={css.addBox}><label className={css.search}><Search size={16} aria-hidden="true" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people to add" aria-label="Search people to add" autoFocus /></label>
          <div className={css.addList}>{outside.slice(0, 30).map((p) => <PersonRow key={p.id} p={p} picked={add.includes(p.id)} onClick={() => setAdd((x) => x.includes(p.id) ? x.filter((y) => y !== p.id) : [...x, p.id])} />)}</div>
          <button type="button" className={css.primary} disabled={!add.length} onClick={async () => {
            // EST-1035: co-workers (leaders see them) join through their own path; people's group path takes staff only.
            const agents = add.filter((x) => data.people.some((p) => p.id === x && p.agent)), people = add.filter((x) => !agents.includes(x));
            let done = true;
            if (people.length) done = await act(`chats/groups/${channel.id}/members`, { add: people });
            for (const a of agents) if (done) done = await act(`chats/${channel.id}/agents`, { agentId: a, add: true });
            if (done) { setAdd([]); setAdding(false); } }}>Add {add.length || ""}</button></div> : null}
        {byDepartment(members).map((g) => <div key={g.department} className={css.dept}><h5>{g.department}<span>{g.people.length}</span></h5>
          {g.people.map((m) => <div key={m.id} className={css.memberRow}>
            <Avatar ai={m.agent} name={m.name} id={m.id} photoAt={m.photoAt} size={36} status />
            <span className={css.rowMain}><b>{m.agent ? <Link href={`/people/ai/${encodeURIComponent(m.id)}`}>{m.name}</Link> : m.id === data.viewer ? "You" : m.name}{m.agent ? <AiBadge employeeId={m.employeeId} /> : null}{m.role === "admin" ? <em className={css.adminTag}><Shield size={11} aria-hidden="true" />Admin</em> : null}</b>{m.agent ? <small>AI co-worker</small> : <PresenceLine id={m.id} />}</span>
            {m.id !== data.viewer ? <button type="button" className={css.iconBtn} onClick={() => onMessage(m)} aria-label={`Message ${m.name}`} title="Message"><MessageCircle size={16} aria-hidden="true" /></button> : null}
            {admin && m.id !== data.viewer ? <button type="button" className={css.iconBtn} onClick={() => void (data.people.some((p) => p.id === m.id && p.agent) ? act(`chats/${channel.id}/agents`, { agentId: m.id, add: false }) : act(`chats/groups/${channel.id}/members`, { remove: [m.id] }))} aria-label={`Remove ${m.name} from the group`} title="Remove"><Trash2 size={15} aria-hidden="true" /></button> : null}
          </div>)}</div>)}
        {!members.length ? <p className={css.hint}>Opening members…</p> : null}
        {former.length ? <div className={css.dept}><h5>Former members<span>{former.length}</span></h5>
          {former.map((f) => <div key={f.id} className={css.memberRow} data-former=""><Avatar name={f.name} id={f.id} photoAt={f.photoAt} size={36} />
            <span className={css.rowMain}><b>{f.name}</b><small className={css.hint}>{f.reason === "left_company" ? "Left the company" : "Removed when leaving"} · their messages stay</small></span></div>)}</div> : null}
      </section> : null}
      {channel.kind === "custom" ? <button type="button" className={css.leave} onClick={() => setLeaving(true)}><LogOut size={16} aria-hidden="true" />Leave group</button> : null}
    </div>
    {leaving ? <Confirm title={`Leave “${channel.name}”?`} text="You stop receiving its messages. An admin can add you back." action="Leave" onCancel={() => setLeaving(false)} onConfirm={async () => { setLeaving(false); try { await send(`chats/groups/${channel.id}/leave`); onLeft(); } catch (e) { setError((e as Error).message); } }} /> : null}
  </ChatAside>;
}
