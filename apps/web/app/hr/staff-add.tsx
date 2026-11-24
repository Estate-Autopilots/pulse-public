'use client';
// HR-AGENT (owner, 20 Nov 2026, migration 2493): an AI employee asks to add a staff member; a named approver decides.
// StaffAddQueue is the card on My desk → Approvals (Approve adds them through People → Add person; Decline asks why, and
// the AI hears the reason). StaffAddApprovers is HR → Policies → Approvals' "New staff approvers" (admins choose).
import {useState} from 'react';
import {useRouter} from 'next/navigation';
import {Check, Clock, UserPlus, X} from 'lucide-react';
import {notify} from '@pulse/ui-shell';
import {AiBadge, PeopleInput, PersonChip, SaveBar, countChanges, promptDialog, type PickPerson} from '../kit';
import {Celebrate} from '../kit/celebrate';
import {post} from '../records';
import {Badge, Empty, Panel, styles} from '../ui';
import {ago, longDay} from '../lib/format';
import {useWords} from '../org-code';
import {functionWord} from '../pod-team';
import css from './flows.module.css';

type Who = {id: string; name: string};
export type StaffAddRequest = {requestId: string; status: 'waiting_for_approval' | 'approved' | 'declined' | 'expired'; name: string; role: string;
  team: string | null; pod: string | null; startDate: string | null; email: string | null; note: string | null; createdAt: string; expiresAt: string;
  requestedBy: Who; approvers: Who[]; decidedBy: Who | null; decidedAt: string | null; declineReason: string | null; personId: string | null;
  canDecide: boolean; message: string};
export type StaffAddApproverSetting = {named: boolean; approvers: Who[]; canEdit: boolean; choices: (Who & {role?: string | null})[]};

const STATUS: Record<StaffAddRequest['status'], [string, 'warning' | 'success' | 'danger' | 'neutral']> = {
  waiting_for_approval: ['Waiting for you', 'warning'], approved: ['Added', 'success'], declined: ['Declined', 'danger'], expired: ['Ended', 'neutral']};
const errorOf = (e: unknown) => e instanceof Error ? e.message : 'That did not work. Try again.';

function StaffAddCard({r, selected}: {r: StaffAddRequest; selected: boolean}) {
  const router = useRouter(), words = useWords();
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [added, setAdded] = useState(false);
  const waiting = r.status === 'waiting_for_approval';
  const [label, tone] = waiting && !r.canDecide ? ['Waiting', 'warning' as const] : STATUS[r.status];
  async function approve() {
    setBusy(true); setError('');
    try {
      await post(`people/add-requests/${r.requestId}/approve`, {});
      setAdded(true);
      notify({id: `staff-add-${r.requestId}`, tone: 'success', title: `${r.name} is in People`, message: `${r.requestedBy.name} will hear that you said yes.`, timeout: 3500});
      router.refresh();
    } catch (e) { setError(errorOf(e)); } finally { setBusy(false); }
  }
  async function decline() {
    const reason = await promptDialog({title: `Decline adding ${r.name}?`, label: 'Why?', body: `${r.requestedBy.name} will be told your reason. Nobody is added.`,
      placeholder: 'For example: we are not hiring for this team now', confirmLabel: 'Decline', multiline: true, minLength: 3, maxLength: 500});
    if (reason === null) return;
    setBusy(true); setError('');
    try {
      await post(`people/add-requests/${r.requestId}/decline`, {reason});
      notify({id: `staff-add-${r.requestId}`, tone: 'success', title: 'Declined', message: `${r.requestedBy.name} will be told why.`, timeout: 3000});
      router.refresh();
    } catch (e) { setError(errorOf(e)); } finally { setBusy(false); }
  }
  // DE-EA (tenant-neutral check): the unit (pod) and the function (team) in the company's own words (pod-team.ts).
  const facts: [string, string | null][] = [['Role', r.role], [functionWord(words), r.team], [words.team, r.pod], ['Starts', r.startDate ? longDay(r.startDate) : null], ['Work e-mail', r.email]];
  return <article className={css.card} id={`staff-${r.requestId}`} aria-current={selected || undefined} data-staff-add={r.status}>
    <Celebrate when={added} id={`staff-add-${r.requestId}`}/>
    <div className={css.title}>
      <h3><UserPlus size={15} aria-hidden="true"/> Add {r.name}?</h3>
      {/* Yours to decide: no pill (the panel counts what waits); the deadline sits by the buttons. Else the outcome. */}
      {waiting && r.canDecide ? null : <Badge tone={tone}>{label}</Badge>}
    </div>
    <p className={css.meta}>{r.requestedBy.name} <AiBadge/> asked {ago(r.createdAt)}.{waiting && !r.canDecide ? ` Ends ${longDay(r.expiresAt.slice(0, 10))} if nobody decides.` : ''}</p>
    {waiting && r.canDecide ? <p className={css.decideBy}><Clock size={14} aria-hidden="true"/>Decide by {longDay(r.expiresAt.slice(0, 10))}</p> : null}
    <dl className={css.facts}>{facts.filter(([, v]) => v).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
    {r.note ? <p className={css.askNote}>{r.note}</p> : null}
    {waiting ? (r.canDecide
      ? <div className={css.actions}>
          <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy} onClick={() => void approve()}><Check size={14} aria-hidden="true"/>Approve and add</button>
          <button type="button" className={styles.btn} disabled={busy} onClick={() => void decline()}><X size={14} aria-hidden="true"/>Decline</button>
        </div>
      : <p className={css.hint}>Waiting for {r.approvers.map(a => a.name).join(' or ')}.</p>)
      : <p className={css.hint}>{r.message}</p>}
    {error ? <p className={css.status} role="alert">{error}</p> : null}
  </article>;
}

/** My desk → Approvals: new staff an AI asked to add. Shown only when there is a request to see. */
export function StaffAddQueue({rows, selected}: {rows: StaffAddRequest[]; selected?: string}) {
  if (!rows.length) return null;
  const yours = (r: StaffAddRequest) => r.status === 'waiting_for_approval' ? (r.canDecide ? 0 : 1) : 2;
  const waiting = rows.filter(r => yours(r) === 0).length;
  // Yours to decide first, then waiting on someone else, then decided or ended (each group keeps the API's order).
  const shown = rows.map((r, i) => [r, i] as const).sort(([a, i], [b, j]) => yours(a) - yours(b) || i - j).map(([r]) => r);
  return <Panel title="New staff to approve" sub={waiting ? `${waiting} waiting for you` : 'Nothing to decide'} className={css.queue}>
    <div className={`${css.cards} ${css.staffCards}`} data-items="">{shown.map(r => <StaffAddCard key={r.requestId} r={r} selected={selected === r.requestId}/>)}</div>
  </Panel>;
}

/** HR → Policies → Approvals: who approves new staff an AI asks to add. None chosen = the company's admins. */
export function StaffAddApprovers({data}: {data: StaffAddApproverSetting}) {
  const router = useRouter();
  const base = data.named ? data.approvers.map(a => a.id) : [];
  const [saved, setSaved] = useState(base), [ids, setIds] = useState(base);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const people: PickPerson[] = data.choices.map(c => ({id: c.id, name: c.name, role: c.role ?? null}));
  const changes = countChanges({ids: saved.join(',')}, {ids: ids.join(',')});
  // None named: `approvers` is who approves today (the company's admins), so the card can say who that is.
  const admins = !data.named ? data.approvers : [];
  async function save() {
    setBusy(true); setError('');
    try {
      await post('hr/staff-add-approvers', {people: ids});
      setSaved(ids);
      notify({id: 'staff-add-approvers', tone: 'success', title: 'New staff approvers saved', timeout: 2500});
      router.refresh();
    } catch (e) { setError(errorOf(e)); } finally { setBusy(false); }
  }
  return <section className={`${css.card} ${css.policyCard}`} aria-labelledby="staff-add-approvers-title">
    <h3 id="staff-add-approvers-title">New staff approvers</h3>
    <p className={css.meta}>An AI employee can add someone only after one of these people says yes.</p>
    {data.canEdit
      ? <form onSubmit={e => { e.preventDefault(); void save(); }} className={css.policyForm}>
          {/* Who approves today comes first (the judge: the key fact came last, small and grey); then the picker. */}
          <div className={css.approverBox}>
            {ids.length ? null
              : <div className={css.approverNow} role="status"><b>Approved by your admins (the default):</b>{admins.map(a => <PersonChip key={a.id} person={a}/>)}</div>}
            <div className={css.approverPick}>
              <PeopleInput label="New staff approvers" people={people} value={ids} onChange={setIds} addLabel={ids.length ? 'Add an approver' : 'Change approvers'}/>
              <small className={css.hint}>Only HR, admins and leaders can approve.</small>
            </div>
          </div>
          {/* Only while something is unsaved: an always-on bar floated over this card and stacked on the policy's own bar. */}
          <SaveBar changes={changes} busy={busy} error={error || undefined} onSave={() => void save()} onDiscard={() => setIds(saved)} saveLabel="Save approvers"/>
        </form>
      : data.approvers.length
        ? <div className={css.actions}>{data.approvers.map(a => <PersonChip key={a.id} person={a}/>)}</div>
        : <Empty icon={UserPlus} compact title="No one can approve yet" text="Ask an admin to choose an approver. Until then, AI employees cannot add staff."/>}
  </section>;
}
