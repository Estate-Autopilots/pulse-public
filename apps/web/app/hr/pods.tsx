'use client';
import { useMemo, useState, type DragEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Crown, Lightbulb, Plus, Undo2, UserPlus, X } from 'lucide-react';
import { notify } from '@pulse/ui-shell';
import { Modal, post } from '../records';
import { Avatar, styles } from '../ui';
import type { FlowSettings } from './flow-types';
import css from './pods.module.css';

type P = FlowSettings['people'][number];
const NONE = '__none__';

/** HR → Pod heads: one card per pod with its head and members. Drag people between pods, add them through a search,
 *  accept Review data suggestions in place, and save every change at once from the bar that stays in view. */
export function PodCards({ data }: { data: FlowSettings }) {
  const router = useRouter();
  const initialPod = useMemo(() => Object.fromEntries(data.people.map((p) => [p.id, p.pod && data.podNames.includes(p.pod) ? p.pod : NONE])), [data]);
  const initialHead = useMemo(() => Object.fromEntries(data.podNames.map((n) => [n, data.pods.find((p) => p.name === n)?.headId ?? null])), [data]);
  const [pod, setPod] = useState<Record<string, string>>(initialPod), [head, setHead] = useState<Record<string, string | null>>(initialHead);
  const [accepted, setAccepted] = useState<string[]>([]), [over, setOver] = useState<string | null>(null), [busy, setBusy] = useState(false), [saved, setSaved] = useState(false);
  const [adding, setAdding] = useState<string | null>(null), [choosingHead, setChoosingHead] = useState<string | null>(null), [person, setPerson] = useState<P | null>(null);
  const byId = useMemo(() => new Map(data.people.map((p) => [p.id, p])), [data]);
  const members = (name: string) => data.people.filter((p) => pod[p.id] === name);
  const changedPods = data.podNames.filter((n) => head[n] !== initialHead[n] || data.people.some((p) => (pod[p.id] === n) !== (initialPod[p.id] === n)));
  const moved = data.people.filter((p) => pod[p.id] !== initialPod[p.id]).length;
  const changes = moved + data.podNames.filter((n) => head[n] !== initialHead[n]).length;
  const move = (id: string, to: string) => {
    setPod((s) => ({ ...s, [id]: to }));
    // A head who leaves their pod stops heading it.
    setHead((h) => Object.fromEntries(Object.entries(h).map(([n, x]) => [n, x === id && n !== to ? null : x])));
  };
  const makeHead = (name: string, id: string) => { setHead((h) => ({ ...h, [name]: id })); setPod((s) => ({ ...s, [id]: name })); };
  // Review data: "X reports to Y" proposes Y as the head of X's pod.
  const suggestions = data.suggestions.filter((s) => typeof s.proposed.managerId === 'string' && byId.has(String(s.proposed.managerId)) && !accepted.includes(s.id));
  const suggestedFor = (name: string) => {
    const counts = new Map<string, { id: string; n: number; ids: string[]; basis: string }>();
    for (const s of suggestions) {
      if (pod[s.personId] !== name) continue;
      const m = String(s.proposed.managerId); if (m === head[name]) continue;
      const c = counts.get(m) ?? { id: m, n: 0, ids: [], basis: String(s.proposed.basis ?? '') };
      c.n++; c.ids.push(s.id); counts.set(m, c);
    }
    return [...counts.values()].sort((a, b) => b.n - a.n);
  };
  async function save() {
    const pods = changedPods.map((n) => ({ name: n, headId: head[n], members: members(n).map((p) => p.id) }));
    setBusy(true);
    try {
      await post('hr/pods', { pods, accepted });
      notify({ id: 'pods', tone: 'success', title: 'Pods saved', message: `${changes} change${changes === 1 ? '' : 's'} saved. Approvals route to the new heads now.`, timeout: 3500 });
      setAccepted([]); setSaved(true); router.refresh();
    } catch (e) { notify({ id: 'pods', tone: 'error', title: 'Not saved', message: e instanceof Error ? e.message : 'Try again' }); } finally { setBusy(false); }
  }
  const drop = (to: string) => (e: DragEvent) => { e.preventDefault(); setOver(null); const id = e.dataTransfer.getData('text/plain'); if (id && byId.has(id)) move(id, to); };
  const chip = (p: P) => <li key={p.id}><button type="button" className={css.chip} draggable onDragStart={(e) => { e.dataTransfer.setData('text/plain', p.id); e.dataTransfer.effectAllowed = 'move'; }}
    onClick={() => setPerson(p)} title={`${p.name}. Drag to another pod, or click for choices.`} data-moved={pod[p.id] !== initialPod[p.id] ? '' : undefined}>
    <Avatar name={p.name} id={p.id} photoAt={p.photoAt ?? null} size={28} /><span>{p.name}</span></button></li>;
  const card = (name: string) => {
    const list = members(name).filter((p) => p.id !== head[name]); const h = head[name] ? byId.get(head[name]!) : null; const ideas = name === NONE ? [] : suggestedFor(name);
    return <section key={name} className={css.card} data-over={over === name ? '' : undefined} aria-label={name === NONE ? 'Not in a pod' : name}
      onDragOver={(e) => { e.preventDefault(); if (over !== name) setOver(name); }} onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(null); }} onDrop={drop(name)}>
      <header className={css.head}><h3>{name === NONE ? 'Not in a pod' : name}</h3><span>{members(name).length} {members(name).length === 1 ? 'person' : 'people'}</span></header>
      {name !== NONE ? <div className={css.headRow}>
        {h ? <button type="button" className={css.leader} onClick={() => setChoosingHead(name)} title="Change the head"><Avatar name={h.name} id={h.id} photoAt={h.photoAt ?? null} size={36} /><span><small><Crown size={11} aria-hidden="true" /> Pod head</small>{h.name}</span></button>
          : <button type="button" className={`${styles.btn} ${css.choose}`} onClick={() => setChoosingHead(name)}><Crown size={13} aria-hidden="true" />Choose a head</button>}
      </div> : <p className={css.hint}>People here have no pod. Drag them onto a pod, or use Add people on a pod.</p>}
      {ideas.map((s) => { const m = byId.get(s.id)!; return <p key={s.id} className={css.idea}><Lightbulb size={13} aria-hidden="true" /><span>Review data suggests <b>{m.name}</b> as head ({s.n} reporting line{s.n === 1 ? '' : 's'}){m.pod && m.pod !== name ? `; moves them from ${m.pod}` : ''}.</span>
        <button type="button" className={styles.btn} onClick={() => { makeHead(name, s.id); setAccepted((a) => [...new Set([...a, ...s.ids])]); }}>Accept</button></p>; })}
      {list.length ? <ul className={css.chips}>{list.map(chip)}</ul> : <p className={css.hint}>{name === NONE ? 'Everyone is in a pod.' : 'No members yet. Add people, or drag them here.'}</p>}
      {name !== NONE ? <button type="button" className={`${styles.btn} ${css.add}`} onClick={() => setAdding(name)}><UserPlus size={13} aria-hidden="true" />Add people</button> : null}
    </section>;
  };
  return <div className={css.wrap}>
    <div className={css.saveBar} role="region" aria-label="Save pod changes">
      <span>{changes || accepted.length ? <><b>{changes}</b> unsaved change{changes === 1 ? '' : 's'}{accepted.length ? ` · ${accepted.length} suggestion${accepted.length === 1 ? '' : 's'} accepted` : ''}</> : 'Drag people between pods, add them, or accept a suggestion. Nothing changes until you save.'}</span>
      {/* UX-5A: "Saved" sits in a slot that is always there, so the buttons never move when it appears. */}
      <span className={css.saveActions}><span role="status" className={css.saved} style={{ display: "inline-block", minWidth: "3.6em" }}>{saved && !changes && !accepted.length ? "Saved" : ""}</span><button type="button" className={styles.btn} disabled={busy || (!changes && !accepted.length)} onClick={() => { setPod(initialPod); setHead(initialHead); setAccepted([]); }}><Undo2 size={13} aria-hidden="true" />Undo</button>
        <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save pod assignments'}</button></span>
    </div>
    <div className={css.grid}>{data.podNames.map(card)}{members(NONE).length ? card(NONE) : null}</div>
    {adding ? <Modal title={`Add people to ${adding}`} sub="Search the team. Someone already in another pod moves here." onClose={() => setAdding(null)}>
      <Picker people={data.people.filter((p) => pod[p.id] !== adding)} podOf={(id) => pod[id] === NONE ? 'No pod' : pod[id]} onPick={(p) => { move(p.id, adding); notify({ id: 'pod-add', tone: 'info', title: `${p.name} → ${adding}`, message: 'Save pods to keep it.', timeout: 2000 }); }} />
    </Modal> : null}
    {choosingHead ? <Modal title={`Head of ${choosingHead}`} sub="The head approves this pod's requests (with HR able to see them) and can give tasks to its members." onClose={() => setChoosingHead(null)}>
      <Picker people={[...members(choosingHead), ...data.people.filter((p) => pod[p.id] !== choosingHead)]} podOf={(id) => pod[id] === NONE ? 'No pod' : pod[id]} onPick={(p) => { makeHead(choosingHead, p.id); setChoosingHead(null); }} />
    </Modal> : null}
    {person ? <Modal title={person.name} sub={`${pod[person.id] === NONE ? 'Not in a pod' : pod[person.id]}${person.role ? ` · ${person.role}` : ''}`} onClose={() => setPerson(null)}>
      <div className={css.moves}>
        {data.podNames.filter((n) => n !== pod[person.id]).map((n) => <button key={n} type="button" className={styles.btn} onClick={() => { move(person.id, n); setPerson(null); }}><Plus size={13} aria-hidden="true" />Move to {n}</button>)}
        {pod[person.id] !== NONE && head[pod[person.id]] !== person.id ? <button type="button" className={styles.btn} onClick={() => { makeHead(pod[person.id], person.id); setPerson(null); }}><Crown size={13} aria-hidden="true" />Make head of {pod[person.id]}</button> : null}
        {pod[person.id] !== NONE ? <button type="button" className={styles.btn} onClick={() => { move(person.id, NONE); setPerson(null); }}><X size={13} aria-hidden="true" />Remove from {pod[person.id]}</button> : null}
      </div>
    </Modal> : null}
  </div>;
}

function Picker({ people, podOf, onPick }: { people: P[]; podOf: (id: string) => string; onPick: (p: P) => void }) {
  const [q, setQ] = useState('');
  const list = people.filter((p) => !q || `${p.name} ${p.role ?? ''} ${podOf(p.id)}`.toLowerCase().includes(q.toLowerCase())).slice(0, 80);
  return <div className={css.picker}>
    <input className={styles.input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name, role or pod" aria-label="Search people" autoFocus />
    <ul>{list.map((p) => <li key={p.id}><button type="button" onClick={() => onPick(p)}><Avatar name={p.name} id={p.id} photoAt={p.photoAt ?? null} size={26} /><span>{p.name}{p.role ? <small>{p.role}</small> : null}</span><em>{podOf(p.id)}</em></button></li>)}
      {!list.length ? <li className={css.hint}>Nobody matches.</li> : null}</ul>
  </div>;
}
