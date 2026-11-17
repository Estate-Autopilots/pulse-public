// QA-E2E backend scenario driver: the real API on a local port, synthetic personas acting through it, every request
// recorded with its response time. Run by tests/core/test_qa_e2e.py (which seeds the synthetic agency); env:
//   TEST_API_CONFIG / TEST_WORKER_CONFIG  pg configs for the api and worker logins of a disposable pulse_ci_* database
//   TEST_SEED                              the seed (personas, office, ids) as JSON
//   PULSE_QA_E2E_OUT                       where report.json, report.md and requests.jsonl go
//   QA_ONLY=chats,tasks                    run some scenarios only
import { Persona, Recorder, startStack, tick } from './lib/harness.mjs';
import { attendance } from './attendance.mjs';
import { presence } from './presence.mjs';
import { chats } from './chats.mjs';
import { tasks } from './tasks.mjs';
import { notify, auth } from './notify.mjs';

const seed = JSON.parse(process.env.TEST_SEED);
const rec = new Recorder(process.env.PULSE_QA_E2E_OUT ?? 'qa-e2e-out', 'QA-E2E backend scenarios');
const stack = await startStack();
const h = { rec, stack, password: seed.password };
const names = { kabir: 'Kabir Shah', ahoro: 'Ahoro Rao', meera: 'Meera Iyer', neha: 'Neha Jivop', rila: 'Rila Kapoor', dev: 'Dev Panab', sana: 'Sana Khan', ishaan: 'Ishaan Vivim', tara: 'Tara Nair', vikram: 'Vikram Seduh', zoya: 'Zoya Sheikh', rifob: 'Rifob Desai' };
const P = Object.fromEntries(Object.entries(seed.personas).map(([k, v]) => [k, new Persona(h, k, { ...v, name: names[k] })]));
const only = process.env.QA_ONLY ? new Set(process.env.QA_ONLY.split(',')) : null;
let crashed = null;
try {
  rec.section('sign-in');
  for (const p of Object.values(P)) {
    const t0 = performance.now(); await p.signIn(); rec.timing(`${p.key}: first sign-in incl. choosing a password`, performance.now() - t0);
  }
  await tick(stack, rec);
  const ctx = { rec, P, stack, seed };
  for (const [name, run] of [['auth', auth], ['attendance', attendance], ['chats', chats], ['tasks', tasks], ['notify', notify], ['presence', presence]]) {
    if (only && !only.has(name)) continue;
    try { await run(ctx); } catch (e) { rec.check(false, `${name} scenario ran to the end`, String(e?.stack ?? e).slice(0, 1500)); }
  }
} catch (e) { crashed = e; rec.check(false, 'driver ran', String(e?.stack ?? e)); }
const report = rec.finish({ base: stack.base });
await stack.close();
process.exit(crashed || report.failed ? 1 : 0);
