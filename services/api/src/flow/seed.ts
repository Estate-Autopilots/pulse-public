/** FLOW-A seed for a dev install: the EA client-project process (its write-up = the SOP corpus, read-only from the Drive
 *  export) and the Solar install process, published; then one demo run of each, part-way through, on synthetic names
 *  (demo runs make no Work task and send nothing). Everything goes through the shipped API as the person named, so the
 *  same rules apply as on screen. Re-running it updates the two processes and replaces the earlier demo runs.
 *
 *    node dist/flow/seed.js --api http://127.0.0.1:3203 --as user-668d21b6@estateautopilots.com --sops ~/ea-research/data/cs-workflow
 *
 *  Dev only: it refuses an API address that is not on this machine. */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EA_WRITEUP } from './templates/ea-creative.js';
import { template } from './templates/index.js';

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const arg = (k: string, d = '') => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const API = arg('api', 'http://127.0.0.1:3203'); const AS = arg('as', 'user-668d21b6@estateautopilots.com'); const SOPS = arg('sops', `${process.env.HOME}/ea-research/data/cs-workflow`);
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(API)) throw new Error('The seed runs against a dev API on this machine only');

async function call(path: string, body?: unknown): Promise<J> {
  const r = await fetch(`${API}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'cf-access-authenticated-user-email': AS, 'content-type': 'application/json', 'x-pulse-client-ip': 'flow-seed' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const d = await r.json().catch(() => ({})) as J;
  if (!r.ok) throw new Error(`${path}: ${r.status} ${d.error ?? JSON.stringify(d)}`);
  return d;
}
const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

async function process_(key: string, name: string, writeup?: J[]): Promise<string> {
  const t = template(key)!;
  const found = ((await call('/v1/flow/processes')).processes as J[]).find((p) => p.source === 'flow' && p.template === key);
  const id = found?.id ?? (await call('/v1/flow/processes', { template: key, keepTemplateKey: true, name })).id;
  // An existing seeded process is brought to the template as it is in this build.
  await call(`/v1/flow/processes/${id}`, { name, summary: t.summary, definition: t.definition, ...(writeup ? { writeup } : {}) });
  // FLOW-D: the template's own blocks join the company's ("Your company's blocks"), the ones it does not have yet.
  const have = new Set(((await call('/v1/flow/blocks')).blocks as J[]).map((b) => b.key));
  for (const b of t.blocks ?? []) if (!have.has(b.key)) await call('/v1/flow/blocks', { key: b.key, name: b.name, summary: b.summary, step: b.step });
  const pub = await call(`/v1/flow/processes/${id}/publish`, {});
  console.log(`${name}: ${id} version ${pub.version}`);
  return id;
}

async function eaWriteup(): Promise<J[]> {
  const out: J[] = [];
  for (const s of EA_WRITEUP) {
    let body = '';
    try { body = (await readFile(join(SOPS, `${s.file}.txt`), 'utf8')).replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim(); } catch { body = ''; }
    out.push({ key: s.key, title: s.title, body: body || '(This document is empty in Drive.)', ...(s.parent ? { parent: s.parent } : {}), source: { label: 'Drive · EA Creative Strategist SOPs (read-only copy)' } });
  }
  return out;
}

const stepOf = (run: J, key: string) => (run.steps as J[]).find((s) => s.key === key)!;
const finish = (run: J, key: string, outputs?: J) => call(`/v1/flow/steps/${stepOf(run, key).id}/finish`, outputs ? { outputs } : {});
const act = (run: J, key: string, action: string, body: J = {}) => call(`/v1/flow/steps/${stepOf(run, key).id}/actions/${action}`, body);
const rec = (runId: string, step: string, type: string, data: J, status?: string) => call('/v1/flow/records', { type, runId, stepKey: step, data, ...(status ? { status } : {}) });

async function cancelDemos(pid: string) {
  for (const r of ((await call(`/v1/flow/runs?processId=${pid}&status=running&mode=demo`)).runs as J[])) await call(`/v1/flow/runs/${r.id}/cancel`, { note: 'Replaced by a fresh demo' });
}

async function eaDemo(pid: string, me: string) {
  await cancelDemos(pid);
  const demo = (n: string) => ({ name: `${n} (demo)` });
  const rid = (await call(`/v1/flow/processes/${pid}/runs`, { mode: 'demo', name: 'Demo · Skyline Residences, Baner',
    fields: { package: 'sellout', segment: 'premium', prelaunch: false, research_meet: daysAgo(9), approver: 'Mr Mifos (demo)', project_code: 'SKY' },
    people: { gs_head: me, gs: demo('Asohiv Rao'), cs: demo('Rila Kireteso'), ve: demo('Sadafu Shaikh'), gd: demo('Porom Nair'), ac: demo('Kavya Iyer'), pc: demo('Neel Jivop'), vg: demo('Farhan Ali'), sme: demo('Isha Menon') } })).id as string;
  let run = await call(`/v1/flow/runs/${rid}`);
  await finish(run, '0.1'); run = await call(`/v1/flow/runs/${rid}`);
  // Stage 0: the critical inputs came in over three days (the last one is Day 1); the folder and the slot.
  const items = (run.intake as J[]).filter((i) => i.step === '0.2');
  for (const [n, i] of items.entries()) await act(run, '0.2', 'receive', { item: i.key, on: daysAgo(n < items.length - 1 ? 12 : 9), note: n === 1 ? 'Offer end dates still to confirm' : undefined });
  await finish(run, '0.3', { workspace: { url: 'https://drive.google.com/drive/folders/demo', note: 'Demo folder' } });
  await act(run, '0.4', 'slot', { on: daysAgo(9), time: '11:00', place: 'https://meet.google.com/demo-skyl-ine', people: ['Asohiv (GS)', 'Rila (CS)', 'Mr Mifos (client)'] });
  run = await call(`/v1/flow/runs/${rid}`);
  // Stage 1: the Blueprint doc, the initial study, the research meet with its transcript, follow-ups.
  await call(`/v1/flow/steps/${stepOf(run, '1.1').id}/open`, {}); await finish(run, '1.1'); run = await call(`/v1/flow/runs/${rid}`);
  await act(run, '1.2', 'section', { text: 'Initial Observations\n• 2 towers, 220 homes, 3 and 4 BHK; possession Dec 2028 (RERA).\n• Baner–Balewadi high street 5 minutes away; metro line 3 station under construction.\n• Reviews praise the developer\'s past delivery; complaints about parking at their last project.\n\nExtra questions\n• Is the clubhouse ready by possession?\n• Which offer is approved for ads?', final: true });
  const s13 = stepOf(run, '1.3');
  await act(run, '1.3', 'transcript', { recordingUrl: 'https://drive.google.com/file/d/demo-recording', transcript: [
    'Mr Mifos: Skyline has 2 towers with 220 homes, 3 and 4 BHK. Prices start at ₹ 1.9 Cr for the 3 BHK.',
    'Rila: Who buys here today?', 'Mr Mifos: Mostly IT couples upgrading from 2 BHK in Wakad, and a few NRIs from the US.',
    'Rila: What do they compare you with?', 'Mr Mifos: Konih Putig 24K and Godrej River Royale, both about 3 km away.',
    'Mr Mifos: The high street is 5 min away as per the brochure.', 'PENDING: the clubhouse completion date; the architect will confirm.',
    'ARCHITECT / DEVELOPER FOLLOW-UP REQUIRED: the exact carpet area of the 4 BHK corner unit.', 'We will send the revised price sheet by Monday.',
    'CONFLICT: the brochure says 40 amenities, the sales team says 32.'].join('\n') });
  await act(run, '1.3', 'summarise', { keep: true });
  await call(`/v1/flow/steps/${s13.id}/finish`, {}); run = await call(`/v1/flow/runs/${rid}`);
  await act(run, '1.4', 'transcript', { transcript: 'Saved as Client Research Meet Details (Research & Scripting).' });
  await act(run, '1.4', 'score', { info: 4, behaviour: 5, note: 'Prepared, answers fast; the price sheet is late.' });
  await finish(run, '1.4'); run = await call(`/v1/flow/runs/${rid}`);
  await finish(run, '1.5'); run = await call(`/v1/flow/runs/${rid}`);
  // Stage 2: the Blueprint, with its records.
  for (const f of [{ statement: '2 towers, 220 homes, 3 and 4 BHK', source: 'RERA', operational: 'Under Construction' }, { statement: 'Prices start at ₹ 1.9 Cr for the 3 BHK', source: 'Client — Meeting' },
    { statement: 'The high street is 5 min away', source: 'Client — Document', kpc: false }, { statement: 'No visitor parking in tower B', source: 'Client — Meeting', kpc: true }]) await rec(rid, '2.1', 'fact', f);
  await rec(rid, '2.1', 'offer', { name: 'Diwali stamp duty waiver', mechanism: 'Developer pays stamp duty', cost_bearer: 'Developer', valid_until: daysAgo(-20) });
  await act(run, '2.1', 'section', { text: 'Deep Research\n1.1 Overview: two towers, 220 homes, possession Dec 2028.\n1.2 Intelligence: buyers upgrade from 2 BHK in Wakad and Hinjewadi.\n1.3 Location: Baner high street, schools within 2 km.\n1.4 Sales / CP: most walk-ins on weekends.\n1.5 Known Product Constraints: no visitor parking in tower B.', final: true });
  for (const c of ['Konih Putig 24K Glamore', 'Godrej River Royale']) await rec(rid, '2.2', 'competitor', { name: c, distance: '3 km', ticket: '₹ 1.8–2.6 Cr', checked_on: daysAgo(8) }, 'checked');
  await act(run, '2.2', 'section', { text: 'Competitor Philosophy: two direct competitors within 3 km in the same ticket band.', final: true });
  for (const [i, u] of [['Corner 4 BHK with three sides open', 'Light and privacy', 'Floor plan, tower A'], ['High street in 5 minutes', 'Walk to everything', 'Brochure (to verify)']].entries())
    await rec(rid, '2.3', 'usp', { strength: u[0], meaning: u[1], proof: u[2], rank: i + 1 });
  await act(run, '2.3', 'section', { text: 'USP Map: 1. Corner 4 BHK → light and privacy → floor plan. 2. High street → walk to everything → brochure (to verify).', final: true });
  await rec(rid, '2.4', 'persona', { name: 'The upgrading IT couple', who: 'Two incomes, 32–40, one child', situation: 'Outgrew a 2 BHK in Wakad', wants: 'Space and a school nearby', fears: 'Possession delay', priority: 'P1' }, 'checked');
  await rec(rid, '2.4', 'persona', { name: 'The NRI investor', who: 'Puneri in the US, 40–50', situation: 'Buying for parents now, for self later', wants: 'Trust in delivery', fears: 'Managing from far', priority: 'P2' });
  await act(run, '2.4', 'section', { text: 'Persona Strategy: P1 the upgrading IT couple; P2 the NRI investor.', final: true });
  await rec(rid, '2.5', 'positioning', { line: 'The corner home Baner families grow into, five minutes from everything.' }, 'locked');
  await act(run, '2.5', 'section', { text: 'Positioning: The corner home Baner families grow into, five minutes from everything.\nWhy now: last corner units before the tower B launch price.', final: true });
  for (const w of [{ use: 'homes', avoid: 'flats', scope: 'All', why: 'Premium buyers' }, { use: 'EOI', avoid: 'booking', scope: 'All', why: 'Never call an EOI a booking' }, { use: 'possession Dec 2028', avoid: 'ready soon', scope: 'Ads', why: 'Only what RERA says' }])
    await rec(rid, '2.6', 'word', w, 'approved');
  run = await call(`/v1/flow/runs/${rid}`); await finish(run, '2.6'); run = await call(`/v1/flow/runs/${rid}`);
  // Sell-Out: the CS explains the Blueprint one-on-one; the client approved it.
  await act(run, '2.7', 'send', { message: 'Blueprint call held with Mr Mifos: positioning, Word Library and personas walked through.', links: ['https://docs.google.com/document/d/demo-blueprint'] });
  await act(run, '2.7', 'confirm', { note: 'Approved on the call' }); run = await call(`/v1/flow/runs/${rid}`);
  // Stage 3, part-way: Big Ideas chosen, the Model Video and VOV drafted; the image set is in progress.
  await rec(rid, '3.1', 'big_idea', { idea: 'Light you can walk into', why: 'Corner homes are the only three-side-open units', hooks: ['Morning light in the living room', 'The walk to the high street'] }, 'chosen');
  await finish(run, '3.1'); run = await call(`/v1/flow/runs/${rid}`);
  await call(`/v1/flow/steps/${stepOf(run, '3.2').id}/open`, {});
  await act(run, '3.2', 'tab', { tab: 'Script', text: 'Hook 1: Morning light, three sides open.\nBody: The corner homes of Skyline, five minutes from the Baner high street.\nCTA: Book a visit on WhatsApp.' });
  await finish(run, '3.2'); run = await call(`/v1/flow/runs/${rid}`);
  await call(`/v1/flow/steps/${stepOf(run, '3.3').id}/open`, {});
  await act(run, '3.3', 'tab', { tab: 'Script', text: 'VOV: "We moved for the light." 25 seconds, voice over the morning walk-through.' });
  await finish(run, '3.3'); run = await call(`/v1/flow/runs/${rid}`);
  await call(`/v1/flow/steps/${stepOf(run, '3.4').id}/open`, {});
  await act(run, '3.4', 'tab', { tab: 'Copy', text: 'Headline: Three sides open. One corner home.\nSub-head: Skyline, Baner. Possession Dec 2028.' });
  // The Landing page brief and the open items stay with their owners; the image set is still being written.
  console.log(`EA demo run: ${rid}`);
  return rid;
}

async function solarDemo(pid: string) {
  await cancelDemos(pid);
  const rid = (await call(`/v1/flow/processes/${pid}/runs`, { mode: 'demo', name: 'Demo · Putig residence, 5 kW rooftop',
    fields: { system_kw: 5, roof: 'rcc', subsidy: true }, people: { sales: { name: 'Ruvin (demo)' }, surveyor: { name: 'Vinod (demo)' }, installer: { name: 'Sinivid (demo)' }, accounts: { name: 'Meena (demo)' }, owner: { name: 'Owner (demo)' } } })).id as string;
  let run = await call(`/v1/flow/runs/${rid}`);
  await act(run, 's2', 'transcript', { transcript: 'Customer wants 5 kW for a 2-storey house; bill ₹ 4,200 a month. Asked for the subsidy. Prefers Waaree panels.' });
  await finish(run, 's2', { items: { items: ['5 kW system', 'Waaree panels', 'Net meter'] } }); run = await call(`/v1/flow/runs/${rid}`);
  console.log(`Solar demo run: ${rid}`);
  return rid;
}

const me = (await call('/api/v0/me')) as J;
const meId = String(me.person);
const ea = await process_('ea_creative', 'EA · Client project (Creative Strategy)', await eaWriteup());
const solar = await process_('solar_install', 'Solar install');
await eaDemo(ea, meId);
await solarDemo(solar);
