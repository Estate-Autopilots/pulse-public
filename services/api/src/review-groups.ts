// PEOPLE-LIVE: the review queue as groups. Proposals that share a kind, a proposed value and a basis form one group;
// one click accepts or dismisses the group through the same per-item rules as Review data (company.ts decideReview),
// and a few items' evidence shows inline. Work-evidence suggestions (people_work_link) are grouped the same way.
import { ORG_TZ } from './org-time.js';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { decideReview } from './company.js';
import { admin, fail, hr, type Tx, type Viewer } from './routes.js';
import { rankAttention } from './review-attention.js';

type Row = Record<string, unknown>;
export type Group = { kind: string; key: string; label: string; note: string; count: number; high: number; confidence: number | null;
  pod?: string | null; canAccept: boolean; sample: { id: string; title: string; evidence: string[]; entityId?: string | null; entityType?: string | null }[]; ids: string[] };

const s = (x: unknown) => x === null || x === undefined ? '' : String(x);
const MISSING: Record<string, string> = { client: 'Choose the client on the project (Projects → Edit).', location: 'Pin the project on the Map or add its location (Projects → Edit).',
  'joining date': 'Add the joining date on the person (People → Edit).', 'employment type': 'Set the employment type (People → Edit).', 'work e-mail': 'Add the work e-mail (People → Edit).' };

/** Evidence as short lines: method, tab, row and source reference, never source contents. */
export function evidenceLines(e: unknown): string[] {
  const items = (Array.isArray(e) ? e : e && typeof e === 'object' ? [e] : []) as Row[];
  const ref = (x: Row) => { const v = s(x.source_id ?? x.source); return /^[A-Za-z0-9_-]{20,}$/.test(v) ? null : v; };   // Drive ids say nothing to a reader
  return [...new Set(items.slice(0, 4).map(x => [x.method ?? x.basis, x.sheet ? `tab “${s(x.sheet)}”` : null, x.row ? `row ${s(x.row)}` : null, ref(x)]
    .filter(Boolean).map(s).join(' · ')).filter(Boolean))];
}

/** Groups of pending review items. A project's pod comes from the proposal, else from its PM's pod or a client sheet titled by pod. */
export function groupItems(rows: Row[], pods: string[]): Group[] {
  const groups = new Map<string, Group>();
  for (const r of rows) {
    const p = (r.proposed ?? {}) as Row; const kind = s(r.kind);
    let key = kind, label = kind, note = '', canAccept = true, pod: string | null = null;
    // Fill suggestions carry a fixed placeholder confidence until their rules are calibrated: each is accepted on its own.
    if (kind === 'onboard_project_fill' || s(r.source_key).startsWith('onboard_project_fill:') || (kind === 'project_pod' && !!s((r.evidence as Row | null)?.ruleId))) {
      key = `${kind}|fill`; label = kind === 'project_pod' ? 'Pods from configured project rules' : 'Project details from configured rules';
      note = 'These come from configured rules whose confidence is not calibrated yet: accept them one by one.'; canAccept = false;
      pod = kind === 'project_pod' && pods.includes(s(p.pod)) ? s(p.pod) : null;
    } else if (kind === 'project_pod') {
      const hints = ((r.hints ?? []) as Row[]);
      const fromSheet = [...new Set(hints.map(h => s(h.sheetPod)).filter(x => pods.includes(x)))];
      const fromPm = [...new Set(hints.filter(h => h.role === 'Assigned PM' || h.role === 'PGS for the client').map(h => s(h.pod)).filter(x => ['Pod 1', 'Pod 2'].includes(x)))];
      const pm = s(p.pgsCandidate) || s(hints.find(h => h.role === 'Assigned PM' || h.role === 'PGS for the client')?.name);
      const proposed = pods.includes(s(p.pod)) ? s(p.pod) : null;
      // A pod-titled client sheet and the PM's own pod must agree; when they do not, the group asks for a pod.
      const bySheet = fromSheet.length === 1 && (!fromPm.length || fromPm.includes(fromSheet[0])) ? fromSheet[0] : null;
      const byPm = !bySheet && fromPm.length === 1 && (!fromSheet.length || fromSheet.includes(fromPm[0])) ? fromPm[0] : null;
      const conflict = !proposed && !bySheet && !byPm && fromSheet.length > 0 && fromPm.length > 0;
      const derived = proposed ? null : bySheet ?? byPm;
      pod = proposed ?? derived;
      key = `project_pod|${pod ?? 'none'}|${proposed ? 'source' : bySheet ? 'sheet' : byPm ? 'pm' : conflict ? 'conflict' : 'none'}|${pm.toLowerCase()}`;
      label = pod ? `${pod}${pm ? ` · PM ${pm}` : ''}` : pm ? `No pod yet · PM ${pm}` : 'No pod or PM in any source';
      note = proposed ? `The project sources assign these projects to ${proposed}.${fromPm.length && !fromPm.includes(proposed) ? ` ${pm}'s own pod is ${fromPm.join(' or ')}: check before accepting.` : ''}`
        : bySheet ? `A client sheet titled “${bySheet}” names these projects${pm ? `; ${pm} is their PM` : ''}.`
        : byPm ? `${pm} is the assigned PM and works in ${byPm}.`
        : conflict ? `Sources disagree: a client sheet titled “${fromSheet.join(' or ')}” names these projects, and ${pm || 'their PM'} works in ${fromPm.join(' or ')}. Choose the pod for the group, or decide them one by one.`
        : 'No source names a pod. Choose one for the whole group, or decide them one by one.';
      canAccept = !!pod;
    } else if (kind === 'contact_type') {
      const methods = [...new Set(evidenceLines(r.evidence).map(x => x.split(' · ')[0]))].sort().join('; ');
      key = `contact_type|${s(p.contactType)}|${methods}`; label = `${s(p.contactType).replaceAll('_', ' ') || 'Unknown'} · ${methods || 'no method recorded'}`;
      note = s(p.contactType) === 'other' ? '“Other” means no source names a business role; accepting records that, and the contact can be retyped later.' : `Sources name these contacts as ${s(p.contactType).replaceAll('_', ' ')}.`;
    } else if (kind === 'wa_contact') {
      // WA-INTEL (1070): what the WhatsApp groups show about a contact or client; accepting fills only what is empty.
      const fields = ['designation', 'email', 'contactType', 'clientId', 'website'].filter((f) => p[f]), made = !!p.newContact;
      key = `wa_contact|${s(r.entity_type)}|${made ? 'new|' : ''}${fields.join('+')}`;
      label = `${made ? 'New contacts' : r.entity_type === 'client' ? 'Client websites' : 'Contacts'} from the chats${fields.length ? `: ${fields.map((f) => ({ designation: 'role', email: 'e-mail', contactType: 'contact type', clientId: 'client link', website: 'website' } as Record<string, string>)[f]).join(', ')}` : ''}`;
      note = made ? 'People the client WhatsApp groups name who are not in Pulse yet. Accepting adds each as a point of contact of that client (no invitation is sent) with the role the chats show.'
        : 'Read from the client WhatsApp groups. Accepting fills only fields that are still empty and keeps the change log; open one to check its evidence.';
    } else if (kind === 'data_gap') {
      const missing = ((p.missing ?? []) as string[]).map(String);
      key = `data_gap|${s(r.entity_type)}|${missing.join('+')}`; label = `${r.entity_type === 'person' ? 'People' : 'Projects'} missing ${missing.join(', ')}`;
      note = `${missing.map(m => MISSING[m] ?? `Add the ${m}.`).join(' ')} Filled records close themselves on the next check; accepting only marks the group done.`;
    } else if (kind === 'manager') {
      key = `manager|${s(p.managerId)}`; label = `Reporting lines${r.managerName ? ` to ${s(r.managerName)}` : ''}`; note = 'Accepting sets the reporting manager, who then approves leave and corrections.';
    } else if (kind === 'holiday') { label = 'Holidays to add'; note = 'Accepting adds each holiday to the company calendar.'; }
    else if (kind === 'onboard_project_new') { label = 'New projects from Drive folders'; note = 'Accepting creates each project from its folder.'; }
    else if (kind === 'talent') {
      // R55: a model's name written without a surname, or a shoot whose project is unsure. Accepting takes Pulse's best guess.
      const alias = p.what === 'alias', guess = alias ? s(p.personId) : s(p.projectId);
      key = `talent|${alias ? 'alias' : 'shoot'}|${guess ? 'guess' : 'none'}`;
      label = alias ? (guess ? 'Model names Pulse matched by first name' : 'Model names Pulse could not match') : (guess ? 'Shoots with a likely project' : 'Shoots with no likely project');
      note = alias ? (guess ? 'Each name is linked to the model with a portfolio folder or the full name in the sheets. Accepting confirms that; dismissing unlinks the name.' : 'Open each one and choose the model.')
        : guess ? 'The client written in the shoot sheet, the dated videos in the project folder and the month point to one project, but not clearly enough. Accepting links each shoot to it.' : 'Open each one and choose the project.';
      canAccept = !!guess;
    } else if (kind === 'geocode') {
      // R55: places on the map their own evidence contradicts, by rule. Only folder-named localities carry a point to accept.
      const rule = s(p.rule);
      key = `geocode|${rule}`;
      label = rule === 'locality_centre' ? 'Micro-market centres far from their city' : rule === 'folder_place' ? 'Pins far from the locality their folder names'
        : rule === 'far_from_city' ? 'Pins far from their city' : 'Projects whose sources disagree on the place';
      note = rule === 'folder_place' ? 'Accepting moves each pin to the centre of the locality its folder names, with the move in its pin history.'
        : 'Each needs a point: open it, check it on a map and paste the location, or keep it as it is.';
      canAccept = rule === 'folder_place';
    }
    else { canAccept = false; label = kind.replaceAll('_', ' '); note = 'Review these one by one: each needs its own evidence check.'; }
    const g = groups.get(key) ?? { kind, key, label, note, count: 0, high: 0, confidence: null, pod, canAccept, sample: [], ids: [] };
    g.count += 1; g.ids.push(s(r.id));
    if (r.confidence !== null && r.confidence !== undefined) { g.high += Number(r.confidence) >= .9 ? 1 : 0; g.confidence = Math.max(g.confidence ?? 0, Number(r.confidence)); }
    if (g.sample.length < 3) g.sample.push({ id: s(r.id), title: s(r.title), evidence: evidenceLines(r.evidence), entityId: (r.entity_id as string) ?? null, entityType: (r.entity_type as string) ?? null });
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => Number(b.canAccept) - Number(a.canAccept) || b.count - a.count);
}

export async function reviewGroups(c: PoolClient, v: Viewer, kind?: string) {
  const rows = (await c.query(`select r.id,r.kind,r.source_key,r.title,r.proposed,r.confidence::float confidence,r.evidence,r.entity_id,r.entity_type,
    (select display_name from pulse.person m where m.id::text=r.proposed->>'managerId') "managerName",
    case when r.kind='project_pod' then (select jsonb_agg(jsonb_build_object('pod',pp.pod,'name',p.display_name,'role',l.role,'sheetPod',l.evidence->>'projectPod'))
      from pulse.people_work_link l join pulse.person p on p.id=l.person_id join pulse.people_profile pp on pp.person_id=l.person_id
      where l.project_id=r.entity_id and l.kind='project' and l.retired_at is null and l.status in ('accepted','suggested') and l.role in ('Assigned PM','Runs the client sheet','PGS for the client')) end hints
    from pulse.review_item r where r.status='pending' and ($1::text is null or r.kind=$1) and ($2::boolean or r.kind in ('manager','holiday','opening_balance'))
    order by r.confidence desc nulls last,r.title`, [kind ?? null, admin(v)])).rows;
  const pods = (await c.query("select name from pulse.unit where kind='pod' and valid_to is null")).rows.map(r => r.name as string);
  return groupItems(rows, pods);
}

/** Work-evidence suggestions by review group, largest first, with three items' basis inline. */
export async function workGroups(c: PoolClient) {
  return (await c.query(`select l.group_key key,l.group_label label,count(*)::int count,count(*) filter(where l.confidence>=.9)::int high,
    round(avg(l.confidence),2)::float confidence,array_agg(distinct l.kind) kinds,count(distinct l.person_id)::int people,
    (array_agg(distinct p.display_name))[1:3] names,
    (select jsonb_agg(x) from (select l2.id,l2.kind,l2.title,l2.basis,l2.confidence::float confidence from pulse.people_work_link l2
      where l2.group_key=l.group_key and l2.status='suggested' and l2.retired_at is null order by l2.confidence desc,l2.title limit 3) x) sample
    from pulse.people_work_link l join pulse.person p on p.id=l.person_id where l.status='suggested' and l.retired_at is null
    group by 1,2 order by count(*) desc,label limit 200`)).rows;
}

export function registerReviewGroups(app: FastifyInstance, { tx }: { tx: Tx }) {
  app.get('/api/v0/review-data/groups', req => tx(req, async (c, v) => {
    if (!hr(v)) fail(403, 'HR and leadership review suggestions');
    const q = req.query as { kind?: string };
    if (q.kind === 'people_work') return { kind: q.kind, groups: [], work: await workGroups(c) };
    const groups = (await reviewGroups(c, v, q.kind || undefined)).map(({ ids: _ids, ...g }) => g);
    return { kind: q.kind ?? null, groups, work: [] };
  }));
  // R55: every pending suggestion ranked by what needs attention, each explained, with the action that resolves it.
  app.get('/api/v0/review-data/attention', req => tx(req, async (c, v) => {
    if (!hr(v)) fail(403, 'HR and leadership review suggestions');
    const rows = (await c.query(`select r.id,r.kind,r.title,r.proposed,r.confidence::float confidence,r.evidence,r.entity_type "entityType",r.entity_id "entityId",
      case when r.entity_type='project' then (select coalesce(title,name) from pulse.project where id=r.entity_id) end "projectName",
      case when r.entity_type='person' then (select display_name from pulse.person where id=r.entity_id) end "personName",
      (select display_name from pulse.person m where m.id::text=r.proposed->>'managerId') "managerName"
      from pulse.review_item r where r.status='pending' and ($1::boolean or r.kind in ('manager','holiday','opening_balance'))`, [admin(v)])).rows;
    const today = (await c.query(`select (now() at time zone ${ORG_TZ})::date::text d`)).rows[0].d as string;
    const ranked = rankAttention(rows, today);
    const limit = Math.min(200, Math.max(10, Number((req.query as { limit?: string }).limit) || 60));
    const byKind: Record<string, number> = {}; for (const r of ranked) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
    return { items: ranked.slice(0, limit), total: ranked.length, byKind, canDecide: (admin(v) || v.role === 'hr') && !!v.person,
      pods: (await c.query("select name from pulse.unit where kind='pod' and valid_to is null order by name")).rows.map(r => r.name as string) };
  }));
  // Accept or dismiss one review group. The group is recomputed here, so the ids decided are the ones on screen now.
  app.post<{ Body: Row }>('/api/v0/review-data/decide-group', { schema: { body: { type: 'object' } } }, req => tx(req, async (c, v) => {
    if (!hr(v) || !v.person) fail(403, 'HR or an individual admin manages suggestions');
    const kind = s(req.body.kind), key = s(req.body.key), action = s(req.body.action), chosen = s(req.body.pod);
    if (!kind || kind.length > 40 || !key || key.length > 400 || !['accept', 'dismiss'].includes(action) || chosen.length > 40) fail(400, 'Choose a review group and accept or dismiss');
    const group = (await reviewGroups(c, v, kind)).find(g => g.key === key);
    if (!group) fail(409, 'This group has changed; refresh the page');
    const pod = chosen || group!.pod || null;
    if (action === 'accept' && !group!.canAccept && !(group!.kind === 'project_pod' && pod)) fail(400, group!.note);
    for (let i = 0; i < group!.ids.length; i += 600)
      await decideReview(c, v, group!.ids.slice(i, i + 600), { action, ...(group!.kind === 'project_pod' && pod ? { proposed: { pod } } : {}) });
    return { ok: true, count: group!.ids.length };
  }));
}
