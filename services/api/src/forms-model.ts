/** SOP-WORKFLOW part 3: field forms. A field is a photo (camera only, with geotag and time stamped when asked), a number,
 *  text, a choice, several choices, a checklist, a signature, a location, a date or yes/no. `normalizeFields` keeps a
 *  form within limits; `checkAnswers` checks what someone sent against the form as it was. Templates ship ready-made
 *  forms, and one ready-made workflow (a solar installation). Pure. */

export const FIELD_TYPES = ['photo', 'number', 'text', 'longtext', 'select', 'multi', 'checklist', 'signature', 'location', 'date', 'yesno'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];
export type Field = { key: string; label: string; type: FieldType; required: boolean; help: string | null;
  options?: string[]; unit?: string | null; min?: number | null; max?: number | null; decimals?: number;
  geotag?: boolean; stamp?: boolean; lines?: boolean };
export const TYPE_LABEL: Record<FieldType, string> = { photo: 'Photo', number: 'Number', text: 'Short text', longtext: 'Long text', select: 'One choice', multi: 'Several choices',
  checklist: 'Checklist', signature: 'Signature', location: 'Location', date: 'Date', yesno: 'Yes or no' };

type Raw = Record<string, unknown>;
const text = (x: unknown, max: number) => typeof x === 'string' ? x.replace(/\s+/g, ' ').trim().slice(0, max) : '';
const num = (x: unknown) => { const n = Number(x); return x !== null && x !== '' && x !== undefined && Number.isFinite(n) ? n : null; };
export const keyOf = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'field';

export function normalizeFields(input: unknown): { fields: Field[] } | { error: string } {
  const raw = Array.isArray(input) ? input as Raw[] : [];
  if (raw.length > 60) return { error: 'Keep a form to 60 fields' };
  const seen = new Set<string>(); const out: Field[] = [];
  for (const [i, r0] of raw.entries()) {
    const r = (r0 && typeof r0 === 'object' ? r0 : {}) as Raw;
    const label = text(r.label, 120); if (!label) return { error: `Field ${i + 1} needs a label` };
    const type = (FIELD_TYPES as readonly string[]).includes(String(r.type)) ? r.type as FieldType : 'text';
    let key = (text(r.key, 40) || keyOf(label)).toLowerCase().replace(/[^a-z0-9_]/g, '_');
    for (let n = 2; seen.has(key); n++) key = `${keyOf(label).slice(0, 36)}_${n}`;
    seen.add(key);
    const f: Field = { key, label, type, required: r.required === true, help: text(r.help, 300) || null };
    if (['select', 'multi', 'checklist'].includes(type)) {
      f.options = Array.isArray(r.options) ? [...new Set((r.options as unknown[]).map((o) => text(o, 80)).filter(Boolean))].slice(0, 30) : [];
      if (!f.options.length) return { error: `“${label}” needs its choices` };
    }
    if (type === 'number') { f.unit = text(r.unit, 20) || null; f.min = num(r.min); f.max = num(r.max); f.decimals = Math.min(4, Math.max(0, num(r.decimals) ?? 0)); }
    if (type === 'photo') { f.min = Math.min(10, Math.max(f.required ? 1 : 0, num(r.min) ?? (f.required ? 1 : 0))); f.max = Math.min(10, Math.max(f.min || 1, num(r.max) ?? 4)); f.geotag = r.geotag !== false; f.stamp = r.stamp !== false; }
    if (type === 'text' || type === 'longtext') { f.lines = type === 'longtext' && r.lines === true; f.max = num(r.max) ?? null; }
    out.push(f);
  }
  return { fields: out };
}

/** The answers checked and tidied, or what is wrong, in the form's own words. Photos and signatures come as files. */
export function checkAnswers(fields: Field[], input: unknown): { answers: Record<string, unknown> } | { error: string } {
  const a = (input && typeof input === 'object' && !Array.isArray(input) ? input : {}) as Raw; const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.type === 'photo' || f.type === 'signature') continue;
    const v = a[f.key];
    const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);
    if (empty) { if (f.required && f.type !== 'checklist') return { error: `Fill in “${f.label}”` }; if (f.required && f.type === 'checklist') return { error: `Tick everything in “${f.label}”` }; continue; }
    switch (f.type) {
      case 'number': { const n = num(v); if (n === null) return { error: `“${f.label}” takes a number` };
        if (f.min != null && n < f.min) return { error: `“${f.label}” is at least ${f.min}` }; if (f.max != null && n > f.max) return { error: `“${f.label}” is at most ${f.max}` };
        const d = 10 ** (f.decimals ?? 0); out[f.key] = Math.round(n * d) / d; break; }
      case 'text': case 'longtext': { const s = (Array.isArray(v) ? v.map(String).join('\n') : typeof v === 'string' ? v : '').trim().slice(0, f.type === 'text' ? 300 : 4000); if (!s && f.required) return { error: `Fill in “${f.label}”` };
        if (f.lines) out[f.key] = s.split(/\n+/).map((x) => x.trim()).filter(Boolean).slice(0, 200); else out[f.key] = s; break; }
      case 'select': if (!f.options!.includes(String(v))) return { error: `Choose one of the choices in “${f.label}”` }; out[f.key] = String(v); break;
      case 'multi': case 'checklist': { const list = Array.isArray(v) ? [...new Set(v.map(String))] : []; if (list.some((x) => !f.options!.includes(x))) return { error: `Choose from the list in “${f.label}”` };
        if (f.type === 'checklist' && f.required && list.length < f.options!.length) return { error: `Tick everything in “${f.label}”` }; out[f.key] = list; break; }
      case 'location': { const l = v as Raw; const lat = num(l?.lat), lng = num(l?.lng);
        if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) return { error: `“${f.label}” needs a place` };
        out[f.key] = { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6, accuracy: num(l?.accuracy) }; break; }
      case 'date': if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || !Number.isFinite(Date.parse(`${v}T00:00:00Z`))) return { error: `“${f.label}” takes a date` }; out[f.key] = v; break;
      case 'yesno': if (typeof v !== 'boolean') return { error: `Answer yes or no to “${f.label}”` }; out[f.key] = v; break;
    }
  }
  return { answers: out };
}

/** How many photos (or a signature) each file field needs and allows. */
export function fileNeeds(fields: Field[]) {
  return fields.filter((f) => f.type === 'photo' || f.type === 'signature').map((f) => ({ key: f.key, label: f.label, type: f.type,
    min: f.type === 'signature' ? (f.required ? 1 : 0) : Math.max(f.required ? 1 : 0, f.min ?? 0), max: f.type === 'signature' ? 1 : f.max ?? 4 }));
}

const F = (label: string, type: FieldType, extra: Partial<Field> = {}): Field => ({ key: keyOf(label), label, type, required: true, help: null, ...extra });
export type FormTemplate = { key: string; name: string; purpose: string; forms: { ref: string; name: string; purpose: string; fields: Field[] }[];
  workflow?: { name: string; purpose: string; trigger: { kind: 'manual' }; steps: Raw[] } };
/** Ready-made forms. "solar_install" is a solar installer's field workflow: site entry, the pickup of panels and
 *  inverter, and the installation report with photos, serial numbers and the customer's signature. */
export const TEMPLATES: FormTemplate[] = [
  { key: 'solar_install', name: 'Solar installation', purpose: 'A technician records the site entry, the pickup of panels and inverter, and the installation with photos, serial numbers and the customer\'s signature; bigger jobs are checked by a supervisor.',
    forms: [
      { ref: 'entry', name: 'Site entry', purpose: 'On arrival at the customer\'s site.', fields: [
        F('Photo at the site on arrival', 'photo', { min: 1, max: 2, geotag: true, stamp: true, help: 'From the gate or the roof access, so the place is clear' }),
        F('Where you are', 'location', { help: 'Pulse fills it from the phone' }),
        F('Panels planned for this job', 'number', { min: 1, max: 500, unit: 'panels' }),
        F('Roof type', 'select', { options: ['RCC flat', 'Sheet / tin', 'Tiled', 'Ground mount'] }),
        F('Anything that stops the work today?', 'longtext', { required: false, help: 'Access, weather, the customer is not there…' })] },
      { ref: 'pickup', name: 'Material pickup', purpose: 'At the store, before leaving for the site.', fields: [
        F('Store', 'select', { options: ['Main warehouse', 'Branch store', 'Supplier direct'] }),
        F('Panel serial numbers', 'longtext', { lines: true, help: 'One per line, as printed on each panel' }),
        F('Inverter serial number', 'text'),
        F('Panels picked up', 'number', { min: 1, max: 500, unit: 'panels' }),
        F('Photo of the loaded material', 'photo', { min: 1, max: 3, geotag: true, stamp: true }),
        F('Storekeeper\'s signature', 'signature')] },
      { ref: 'install', name: 'Installation report', purpose: 'When the panels are installed and the system is on.', fields: [
        F('Photos of the installed panels', 'photo', { min: 2, max: 8, geotag: true, stamp: true, help: 'The whole array, then the mounting and the wiring close up' }),
        F('Panels installed', 'number', { min: 1, max: 500, unit: 'panels' }),
        F('System size', 'number', { min: 0.1, max: 1000, unit: 'kW', decimals: 2 }),
        F('Panel serial numbers installed', 'longtext', { lines: true, help: 'One per line' }),
        F('Inverter serial number', 'text'),
        F('Checks done', 'checklist', { options: ['Earthing done', 'DC wiring checked', 'Inverter powered on', 'Generation showing on the app', 'Customer shown how it works'] }),
        F('Customer\'s signature', 'signature'),
        F('Where you are', 'location')] }],
    workflow: { name: 'Solar installation', purpose: 'From the store to a working system the customer has signed for.', trigger: { kind: 'manual' }, steps: [
      { id: 'pickup', title: 'Pick up the panels and inverter', role: 'Field Technician', category: 'operations', slaHours: 4, form: 'pickup' },
      { id: 'entry', title: 'Record the site entry', role: 'Field Technician', category: 'operations', slaHours: 4, form: 'entry' },
      { id: 'install', title: 'Install and photograph the panels', role: 'Field Technician', category: 'operations', slaHours: 10, form: 'install' },
      { id: 'big', title: 'More than 10 panels?', kind: 'decision', next: [{ to: 'check', label: 'Yes', when: { field: 'install.panels_installed', op: 'gt', value: 10 } }, { to: 'handover', label: 'No' }] },
      { id: 'check', title: 'Supervisor approves the installation', kind: 'approval', role: 'Supervisor', slaHours: 24, next: [{ to: 'handover', label: 'Approved' }, { to: 'install', label: 'Send back' }] },
      { id: 'handover', title: 'Hand over to the customer', role: 'Field Technician', slaHours: 24, outputs: ['Signed installation report'] }] } },
  { key: 'site_visit', name: 'Site visit', purpose: 'A visit to a client\'s site or project: photos, who was met, what was agreed.', forms: [{ ref: 'visit', name: 'Site visit', purpose: 'At the end of a visit.', fields: [
    F('Photos of the site', 'photo', { min: 1, max: 6, geotag: true, stamp: true }), F('Where you are', 'location'), F('Who you met', 'text'),
    F('What was agreed', 'longtext'), F('Follow-up needed?', 'yesno')] }] },
  { key: 'delivery_handover', name: 'Delivery and handover', purpose: 'Goods or work handed over to a customer, signed for.', forms: [{ ref: 'handover', name: 'Delivery handover', purpose: 'When the customer receives it.', fields: [
    F('Photo of what was delivered', 'photo', { min: 1, max: 4, geotag: true, stamp: true }), F('Items delivered', 'number', { min: 1, max: 10000 }),
    F('Condition', 'select', { options: ['Good', 'Damaged: noted below'] }), F('Notes', 'longtext', { required: false }), F('Customer\'s signature', 'signature')] }] },
];
