/** FLOW-A: the templates a new process can start from (POST /api/v1/flow/processes { template }). Same engine, the
 *  company's own words. The EA template's write-up (the SOP corpus) is filled by the seed from the Drive export. */
import { blockOfModule, toBlocks } from '../blocks.js';
import { normalizeFlow } from '../model.js';
import type { FlowDef, FlowStep, WriteupSection } from '../types.js';
import { EA_BLOCKS, EA_CREATIVE, EA_WRITEUP } from './ea-creative.js';
import { SOLAR, SOLAR_BLOCKS } from './solar.js';
import { STARTERS } from './starters.js';

type Preset = { key: string; name: string; summary: string; step: FlowStep };
export type Template = { key: string; name: string; summary: string; definition: FlowDef; writeup?: WriteupSection[]; blocks?: Preset[] };
/** FLOW-D: a template is rebuilt from the primitives (each step under the primitive its module belongs to, the steps
 *  before it as "Starts after"), its steps naming the company block they come from. */
function rebuild(def: FlowDef, blocks: Preset[]): { definition: FlowDef; blocks: Preset[] } {
  const from = new Map(blocks.map((b) => [b.step.id, b.key]));
  const d = toBlocks(normalizeFlow(def));
  return { definition: normalizeFlow({ ...d, steps: d.steps.map((s) => (from.has(s.id) ? { ...s, preset: from.get(s.id) } : s)) }),
    blocks: blocks.map((b) => ({ ...b, step: { ...b.step, block: blockOfModule(b.step.module) } })) };
}
const BLANK: Template = { key: 'blank', name: 'Blank', summary: 'Start empty: add the first step.', definition: normalizeFlow({ version: 2 }) };
export const TEMPLATES: Template[] = [
  { ...EA_CREATIVE, ...rebuild(EA_CREATIVE.definition, EA_BLOCKS), writeup: EA_WRITEUP.map((s) => ({ key: s.key, title: s.title, body: '', ...(s.parent ? { parent: s.parent } : {}), source: { label: 'Drive · EA Creative Strategist SOPs' } })) },
  { ...SOLAR, ...rebuild(SOLAR.definition, SOLAR_BLOCKS) },
  // FLOW-E: the industry packs' starters, already made of primitives.
  ...STARTERS.map((t) => ({ ...t, definition: normalizeFlow(t.definition) })),
  BLANK,
];
export const template = (key: string) => TEMPLATES.find((t) => t.key === key);
