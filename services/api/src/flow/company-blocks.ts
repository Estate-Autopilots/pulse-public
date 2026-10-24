/** FLOW-D: company blocks, a company's own named presets of a primitive (EA's "Deep Research section", a solar
 *  "Roof survey"): the step's title, kind (module), settings, checklist, quality test, write-up part, who and due rule.
 *  Shown under "Your company's blocks"; made with "Save as a block" from any step, or brought by a template. */
import type { PoolClient } from 'pg';
import { fail, type Viewer } from '../routes.js';
import { isBlock, blockOfModule } from './blocks.js';
import { normalizeFlow } from './model.js';
import type { CompanyBlock, FlowStep } from './types.js';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const str = (x: unknown, max = 200) => (typeof x === 'string' ? x.replace(/\s+/g, ' ').trim().slice(0, max) : '');
export const blockKey = (x: string) => x.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'block';

/** A step kept to what a preset holds (no id, place, stage, variant filter or uses: those belong to where it is put). */
export function presetOf(raw: unknown): CompanyBlock['step'] & { block: CompanyBlock['block'] } {
  const s = normalizeFlow({ version: 2, steps: [raw] }).steps[0] as FlowStep | undefined;
  if (!s) return fail(400, 'Say what the block does');
  const block = isBlock(s.block) ? s.block : blockOfModule(s.module);
  return { block, module: s.module, title: s.title, settings: s.settings, who: s.who, ...(s.checklist?.length ? { checklist: s.checklist } : {}), ...(s.qualityTest?.length ? { qualityTest: s.qualityTest } : {}),
    ...(s.due ? { due: s.due } : {}), ...(s.sop ? { sop: s.sop } : {}), ...(s.hours !== null && s.hours !== undefined ? { hours: s.hours } : {}), ...(s.note ? { note: s.note } : {}), ...(s.inputs?.length ? { inputs: s.inputs } : {}) };
}

const out = (r: Row): CompanyBlock => {
  const { block: _b, ...step } = r.preset as Row; void _b;
  return { id: r.id, key: r.key, name: r.name, summary: r.summary, block: r.block, source: r.source, step: step as CompanyBlock['step'], updatedAt: r.updated_at };
};

export async function companyBlocks(c: PoolClient): Promise<CompanyBlock[]> {
  return (await c.query('select id,key,name,summary,block,preset,source,updated_at from pulse.flow_block where archived_at is null order by source nulls first,name')).rows.map(out);
}

/** Save a block (a new key, or the same key again replaces it). */
export async function saveBlock(c: PoolClient, v: Viewer, b: { key?: string; name: unknown; summary?: unknown; step: unknown; source?: string | null }): Promise<CompanyBlock> {
  const name = str(b.name, 120) || fail(400, 'Name the block');
  const preset = presetOf(b.step); const key = blockKey(b.key ?? name);
  const r = (await c.query(`insert into pulse.flow_block(org_id,key,name,summary,block,preset,source,created_by,updated_by) values(pulse.current_org(),$1,$2,$3,$4,$5,$6,$7,$7)
    on conflict(org_id,key) where archived_at is null do update set name=excluded.name,summary=excluded.summary,block=excluded.block,preset=excluded.preset,updated_by=excluded.updated_by,updated_at=now()
    returning id,key,name,summary,block,preset,source,updated_at`, [key, name, str(b.summary, 500) || null, preset.block, JSON.stringify(preset), b.source ?? null, v.person])).rows[0];
  return out(r);
}

export async function updateBlock(c: PoolClient, v: Viewer, id: string, b: Row): Promise<CompanyBlock | { archived: true }> {
  const cur = (await c.query('select * from pulse.flow_block where id=$1 and archived_at is null for update', [id])).rows[0] ?? fail(404, 'Block not found');
  if (b.archive === true) { await c.query('update pulse.flow_block set archived_at=now(),updated_by=$2,updated_at=now() where id=$1', [id, v.person]); return { archived: true }; }
  const preset = b.step !== undefined ? presetOf(b.step) : cur.preset;
  const r = (await c.query(`update pulse.flow_block set name=coalesce(nullif($2,''),name),summary=case when $3::boolean then nullif($4,'') else summary end,block=$5,preset=$6,updated_by=$7,updated_at=now() where id=$1
    returning id,key,name,summary,block,preset,source,updated_at`, [id, str(b.name, 120), b.summary !== undefined, str(b.summary, 500), preset.block, JSON.stringify(preset), v.person])).rows[0];
  return out(r);
}

/** A template's blocks join the company's (the ones it does not have yet, by key). */
export async function seedBlocks(c: PoolClient, v: Viewer, blocks: { key: string; name: string; summary?: string; step: unknown }[], source: string) {
  const have = new Set((await c.query('select key from pulse.flow_block where archived_at is null')).rows.map((r) => r.key as string));
  let n = 0;
  for (const b of blocks) if (!have.has(blockKey(b.key))) { await saveBlock(c, v, { ...b, source }); n++; }
  return n;
}
