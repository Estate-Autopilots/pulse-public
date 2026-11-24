"use client";
// PM-UI 17 role map, the live part: the "Team" card. A row (the whole row is the button; its one visible control is the
// chevron) opens the person menu for that role: the kit's OptionList with faces, a tick on the current choice, "current"
// on the saved person and the load chip. Picking someone changes the row and the note ("Rifob → Ira moves 14 open
// steps."); "Save team" turns into the one filled button while something changed. Escape, a click outside or the row
// again close the menu. Real wiring: pass `onSave` (it gets role key → person id of the changed roles).
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { Check, ChevronDown, Info } from "lucide-react";
import { Avatar } from "../../../avatar";
import { OptionList, listKeys, type Option } from "../../../kit";
import { initials } from "../../../lib/face";
import type { LoadKey, RoleCandidate, RoleMapVM, RoleRow } from "../contract/role-map";
import type { HueKey, Person } from "../contract/shared";
import { Chip, PmButton, firstName, hued } from "../kit";
import css from "./role-map.module.css";

const LOAD: Record<LoadKey, { word: string; tone: "problem" | "done" }> = {
  overloaded: { word: "Overloaded", tone: "problem" },
  has_room: { word: "Has room", tone: "done" },
};
const LoadChip = ({ load }: { load?: LoadKey }) => (load ? <Chip tone={LOAD[load].tone}>{LOAD[load].word}</Chip> : null);
const shortName = (p: Person, client?: boolean) => (client ? p.name : firstName(p));
const stepsWord = (n: number) => `${n} open ${n === 1 ? "step" : "steps"}`;

/** A person's face: their photo when they have one (the app's Avatar), else their initials in this team's hue for them
 *  (the VM's `hues`), so no two people on the map share a colour. */
function Face({ person, hues, size }: { person: Person; hues: Record<string, HueKey>; size: number }) {
  if (person.photoAt) return <Avatar name={person.name} id={person.client ? undefined : person.id} photoAt={person.photoAt} size={size} />;
  return <span {...hued(hues[person.id] ?? "slate", css.face)} style={{ "--face": `${size}px` } as CSSProperties} aria-hidden="true">{initials(person.name)}</span>;
}

type Change = { role: RoleRow; from: Person | null; to: Person };

export function RoleTable({ vm, onSave }: { vm: RoleMapVM; onSave?: (picks: Record<string, string>) => void }) {
  const [roles, setRoles] = useState(vm.roles);
  const [picks, setPicks] = useState(vm.picks);
  const [open, setOpen] = useState(vm.openRole);
  const [toast, setToast] = useState(vm.toast ?? null);
  const [byUser, setByUser] = useState(false);
  const canEdit = vm.viewer.can.editPlan;
  const client = vm.project.client;

  const changes = useMemo<Change[]>(() => roles.flatMap((r) => {
    const id = picks[r.key];
    const to = id && id !== r.person?.id ? r.candidates.find((c) => c.person.id === id)?.person : undefined;
    return to ? [{ role: r, from: r.person, to }] : [];
  }), [roles, picks]);

  const toggle = (key: string) => { setByUser(true); setOpen((o) => (o === key ? null : key)); };
  const choose = (role: RoleRow, id: string) => {
    setPicks((p) => { const n = { ...p }; if (id === role.person?.id) delete n[role.key]; else n[role.key] = id; return n; });
    setToast(null);
  };
  const save = () => {
    if (!changes.length) return;
    onSave?.(Object.fromEntries(changes.map((c) => [c.role.key, c.to.id])));
    setRoles((rs) => rs.map((r) => {
      const c = changes.find((x) => x.role.key === r.key);
      return c ? { ...r, person: c.to, candidates: [...r.candidates.filter((k) => k.person.id === c.to.id), ...r.candidates.filter((k) => k.person.id !== c.to.id)] } : r;
    }));
    const moved = changes.reduce((n, c) => n + c.role.openSteps, 0);
    setToast(changes.length === 1 ? `Team saved · ${moved} ${moved === 1 ? "step" : "steps"} moved to ${shortName(changes[0].to, changes[0].role.client)}` : `Team saved · ${moved} steps moved`);
    setPicks({}); setOpen(null);
  };

  const note = changes.length
    ? <><b>{changes.map((c) => `${c.from ? shortName(c.from, c.role.client) : "Nobody"} → ${shortName(c.to, c.role.client)} moves ${stepsWord(c.role.openSteps)}.`).join(" ")}</b> Done steps keep their owner.</>
    : <>Changing a role moves its open steps. Done steps keep their owner.</>;

  return <div className={css.panel}>
    <section className={css.card} aria-labelledby="role-map-title">
      <h2 id="role-map-title" className={css.title}>Team</h2>
      <p className={css.note} aria-live="polite"><Info aria-hidden="true" /><span>{note}</span></p>
      <div className={css.table}>
        <div className={css.thead} aria-hidden="true"><span>Role</span><span>Person</span></div>
        <ul className={css.rows}>
          {roles.map((r) => <Row key={r.key} role={r} hues={vm.hues} client={client} pick={picks[r.key]} open={open === r.key} canEdit={canEdit} byUser={byUser}
            onToggle={() => toggle(r.key)} onClose={() => setOpen(null)} onChoose={(id) => choose(r, id)} />)}
        </ul>
      </div>
    </section>
    {canEdit ? <div className={css.foot}>
      <PmButton variant="primary" size="lg" className={css.save} disabled={!changes.length} onClick={save}>{vm.save.label}</PmButton>
    </div> : null}
    {toast ? <p className={css.toast} role="status"><Check aria-hidden="true" />{toast}</p> : null}
  </div>;
}

function Row({ role, hues, client, pick, open, canEdit, byUser, onToggle, onClose, onChoose }: {
  role: RoleRow; hues: Record<string, HueKey>; client: string | null; pick?: string; open: boolean; canEdit: boolean; byUser: boolean;
  onToggle: () => void; onClose: () => void; onChoose: (id: string) => void;
}) {
  const shownId = pick ?? role.person?.id;
  const shown: RoleCandidate | undefined = role.candidates.find((c) => c.person.id === shownId) ?? (role.person ? { person: role.person } : undefined);
  const uid = useId();
  const listId = `${uid}-list`;
  const li = useRef<HTMLLIElement>(null);
  const btn = useRef<HTMLButtonElement>(null);

  const who = shown ? <span className={css.who}>
    <Face person={shown.person} hues={hues} size={32} />
    <span className={css.whoText}>
      <span className={css.whoName}>{shortName(shown.person, role.client)}</span>
      {role.client && client ? <span className={css.company}><span className={css.dot} aria-hidden="true">·</span>{client}</span> : null}
      <LoadChip load={shown.load} />
    </span>
  </span> : <span className={css.who}><span className={css.muted}>Nobody yet</span></span>;

  // A click outside the open row closes its menu.
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (li.current && !li.current.contains(e.target as Node)) onClose(); };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open, onClose]);

  if (!canEdit) return <li className={css.row}><span className={css.rowBtn} data-static=""><span className={css.role}>{role.role}</span>{who}</span></li>;

  return <li ref={li} className={css.row} data-open={open ? "" : undefined}>
    <button ref={btn} type="button" className={css.rowBtn} aria-expanded={open} aria-controls={open ? listId : undefined} onClick={onToggle}
      aria-label={`${role.role}: ${shown ? shown.person.name : "nobody"}. Change`}>
      <span className={css.role}>{role.role}</span>
      {who}
      <span className={css.chev} aria-hidden="true"><ChevronDown /></span>
    </button>
    {open ? <PersonMenu role={role} hues={hues} listId={listId} chosen={shownId ?? null} focus={byUser}
      onChoose={(id) => { onChoose(id); onClose(); btn.current?.focus({ preventScroll: true }); }}
      onEscape={() => { onClose(); btn.current?.focus({ preventScroll: true }); }} /> : null}
  </li>;
}

/** The people who can fill the role, as the kit's option list: tick · face · name · "current" · load chip. */
function PersonMenu({ role, hues, listId, chosen, focus, onChoose, onEscape }: { role: RoleRow; hues: Record<string, HueKey>; listId: string; chosen: string | null; focus: boolean; onChoose: (id: string) => void; onEscape: () => void }) {
  const options = useMemo<Option<string>[]>(() => role.candidates.map((c) => ({
    value: c.person.id,
    label: shortName(c.person, role.client),
    keywords: c.person.name,
    icon: <span className={css.lead}>
      <span className={css.tick}>{c.person.id === chosen ? <Check aria-label="Chosen" /> : null}</span>
      <Face person={c.person} hues={hues} size={28} />
    </span>,
    tag: c.person.id === role.person?.id || c.load ? <span className={css.tag}>
      {c.person.id === role.person?.id ? <span className={css.current}><span aria-hidden="true">·</span> current</span> : null}
      {c.load ? <><span className={css.dot} aria-hidden="true">·</span><LoadChip load={c.load} /></> : null}
    </span> : undefined,
  })), [role, hues, chosen]);
  const at = Math.max(0, options.findIndex((o) => o.value === chosen));
  const [active, setActive] = useState(at);
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => { if (focus) list.current?.focus({ preventScroll: true }); }, [focus]);

  const keys = (e: KeyboardEvent) => {
    if (listKeys(e, options.length, active, setActive)) return;
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); const o = options[active]; if (o) onChoose(o.value); }
    else if (e.key === "Escape") { e.preventDefault(); onEscape(); }
  };

  return <div className={css.menu} onPointerLeave={() => setActive(at)}>
    <OptionList id={listId} label={`${role.role}: choose a person`} options={options} active={active} onActive={setActive}
      onChoose={(o) => onChoose(o.value)} focusRef={list} onKeyDown={keys} />
  </div>;
}
