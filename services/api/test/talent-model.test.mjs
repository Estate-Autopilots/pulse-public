import assert from 'node:assert/strict';
import test from 'node:test';
import { cameBack, rankModels } from '../dist/talent-model.js';

// Synthetic models, clients and figures only.
const shoot = (personId, shootOn, clientId, o = {}) => ({ personId, shootOn, month: shootOn.slice(0, 8) + '01', projectId: clientId ? `p-${clientId}` : null, clientId,
  clientLabel: null, language: 'Hindi', segment: 'Lux Resd', deliverable: 'Model-Led Video Ads #1', status: 'Done', scripts: 1, sourceKey: `${personId}-${shootOn}-${clientId}`, ...o });

test('a client came back when they started a later engagement or shot again weeks later', () => {
  const eng = new Map([['c1', ['2026-01', '2026-05']], ['c2', ['2026-01']]]);
  const shoots = new Map([['c2', ['2026-01-10', '2026-03-01']], ['c3', ['2026-01-10', '2026-01-20']]]);
  assert.equal(cameBack('c1', '2026-01-10', eng, shoots), true);
  assert.equal(cameBack('c2', '2026-01-10', eng, shoots), true);
  assert.equal(cameBack('c3', '2026-01-10', eng, shoots), false);    // ten days later is the same campaign
});

test('ranking: clients coming back weigh most, small samples are pulled to the company rate, one shoot day is not ranked', () => {
  const people = [{ id: 'a', name: 'Asha', aliases: ['asha'], portfolio: 3 }, { id: 'b', name: 'Bina', aliases: [], portfolio: 0 },
    { id: 'n', name: 'Newcomer', aliases: [], portfolio: 1 }, { id: 'z', name: 'Zero', aliases: [], portfolio: 2 }];
  const shoots = [];
  // Asha: six clients early in 2026, four of them came back.
  for (let i = 1; i <= 6; i++) shoots.push(shoot('a', `2026-0${i}-0${i}`, `ca${i}`));
  // Bina: four clients, none came back.
  for (let i = 1; i <= 4; i++) shoots.push(shoot('b', `2026-0${i}-1${i}`, `cb${i}`, { language: 'Marathi' }));
  shoots.push(shoot('n', '2026-09-01', 'cn'));
  const engagements = [...[1, 2, 3, 4, 5, 6].map((i) => ({ clientId: `ca${i}`, month: `2026-0${i}-01` })), ...[1, 2, 3, 4].map((i) => ({ clientId: `ca${i}`, month: '2026-09-01' })),
    ...[1, 2, 3, 4].map((i) => ({ clientId: `cb${i}`, month: `2026-0${i}-01` }))];
  const media = [{ personId: 'a', kind: 'video', basis: 'shoot_date', files: 12, delivered: 8 }, { personId: 'b', kind: 'video', basis: 'shoot_project', files: 2, delivered: 0 },
    { personId: 'a', kind: 'image', basis: 'portfolio_folder', files: 3, delivered: 0 }];
  const out = rankModels({ people, shoots, engagements, media, today: '2026-10-11' });
  const [first, second] = out.models;
  assert.equal(first.id, 'a'); assert.equal(first.rank, 1); assert.equal(second.id, 'b'); assert.equal(second.rank, 2);
  assert.equal(first.clientsFollowed, 6); assert.equal(first.clientsBack, 4); assert.equal(first.videos, 12); assert.equal(first.videosPerDay, 2);
  assert.equal(out.baseline.clientsFollowed, 10); assert.equal(out.baseline.clientsBack, 4);
  // Shrinkage: (4 + 4×0.4) / (6 + 4) = 0.56, not 0.67.
  assert.ok(Math.abs(first.returnShrunk - 0.56) < 1e-9); assert.ok(first.lift > 0 && second.lift < 0);
  assert.equal(first.confidence, 'medium'); assert.equal(second.confidence, 'medium');
  assert.match(first.why, /4 of 6 clients came back \(company 40%\)/);
  const newcomer = out.models.find((m) => m.id === 'n');
  assert.equal(newcomer.rank, null); assert.equal(newcomer.confidence, 'too_new'); assert.match(newcomer.why, /too early/);
  assert.equal(out.models.find((m) => m.id === 'z').why, 'No shoot recorded in the coordinator\'s sheets.');
  assert.equal(first.cost, undefined); assert.equal(out.costVisible, false);         // no fees for this viewer
  // What works: languages read the same way, with their samples.
  const hindi = out.whatWorks.find((w) => w.dimension === 'language' && w.value === 'Hindi');
  assert.equal(hindi.clientsFollowed, 6); assert.equal(hindi.returnRate, 4 / 6);
});

test('cost (leadership): per shoot day and per script, and a cheaper model ranks higher when all else is equal', () => {
  const people = [{ id: 'a', name: 'Asha', aliases: [], portfolio: 0 }, { id: 'b', name: 'Bina', aliases: [], portfolio: 0 }];
  const shoots = [shoot('a', '2026-01-05', 'c1'), shoot('a', '2026-02-05', 'c2'), shoot('b', '2026-01-06', 'c3'), shoot('b', '2026-02-06', 'c4')];
  const fees = [{ personId: 'a', shootOn: '2026-01-05', total: 4000, charges: 3600, travel: 400, extra: null, shootKeys: [] }, { personId: 'a', shootOn: '2026-02-05', total: 4000, charges: 4000, travel: 0, extra: null, shootKeys: [] },
    { personId: 'b', shootOn: '2026-01-06', total: 9000, charges: 9000, travel: 0, extra: null, shootKeys: [] }, { personId: 'b', shootOn: '2026-02-06', total: 9000, charges: 9000, travel: 0, extra: null, shootKeys: [] }];
  const out = rankModels({ people, shoots, engagements: [], media: [], fees, today: '2026-10-11' });
  const a = out.models.find((m) => m.id === 'a');
  assert.deepEqual([a.cost.total, a.cost.perDay, a.cost.perScript, a.cost.travelShare], [8000, 4000, 4000, 0.05]);
  assert.equal(out.models[0].id, 'a'); assert.equal(out.costVisible, true);
  assert.match(a.why, /costs less per shoot day than the median/);
});

test('ad results count only for ads whose names carry the model', () => {
  const people = [{ id: 'a', name: 'Asha Rao', aliases: ['asha'], portfolio: 0 }];
  const out = rankModels({ people, shoots: [], engagements: [], media: [], ads: [{ name: 'Lakeview | Asha hook 2', spend: 1000, leads: 10, impressions: 5000, clicks: 50 }, { name: 'Lakeview | Dashavatar', spend: 500, leads: 1, impressions: 100, clicks: 1 }], today: '2026-10-11' });
  assert.deepEqual(out.models[0].ads, { spend: 1000, leads: 10, cpl: 100, ctr: 0.01 });
});
