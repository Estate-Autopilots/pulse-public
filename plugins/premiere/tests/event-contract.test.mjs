import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { REGISTRY } from '../../../packages/schemas/generated/events.ts';

const envelopeSchema = JSON.parse(readFileSync(
  new URL('../../../packages/schemas/envelope.schema.json', import.meta.url),
  'utf8',
));

const PANEL_EVENT_CONTRACTS = Object.freeze({
  'app.project.opened': {
    required: ['app', 'project_name_hash', 'project_display_name'],
    optional: ['cid'],
  },
  'app.project.activated': {
    required: ['app', 'project_name_hash', 'project_display_name'],
    optional: ['cid'],
  },
  'app.project.dirty': {
    required: ['app', 'project_name_hash', 'project_display_name'],
    optional: ['cid'],
  },
  'app.project.closed': {
    required: ['app', 'project_name_hash', 'project_display_name'],
    optional: ['cid'],
  },
  'app.export.completed': {
    required: ['app', 'output_name'],
    optional: ['cid', 'sequence_name'],
  },
  'app.render.completed': {
    required: ['app', 'output_name'],
    optional: ['cid'],
  },
  'app.work.delta': {
    required: ['app', 'project_name_hash', 'from_save', 'to_save', 'counts', 'net_ewu', 'gross_ewu'],
    optional: ['cid', 'baseline', 'timeline_ms'],
  },
});

const FORBIDDEN_EXTRA_FIELDS = [
  'title',
  'url',
  'app_name',
  'window_title',
  'text',
  'raw_command',
  'command_text',
  'edit_history',
  'person_name',
  'person_email',
];

const SYNTHETIC_CID = 'PUL1234-TR12';

function assertSchemaValue(value, schema, path = 'value') {
  if (schema.const !== undefined) assert.equal(value, schema.const, `${path} must equal ${schema.const}`);
  if (schema.enum) assert.ok(schema.enum.includes(value), `${path} must be one of ${schema.enum.join(', ')}`);

  if (schema.type === 'object') {
    assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), `${path} must be an object`);
    for (const key of schema.required ?? []) {
      assert.ok(Object.hasOwn(value, key), `${path}.${key} is required`);
    }
    for (const key of Object.keys(value)) {
      if (schema.additionalProperties === false) {
        assert.ok(Object.hasOwn(schema.properties ?? {}, key), `${path}.${key} is not allowed`);
      }
      if (schema.propertyNames?.pattern) {
        assert.match(key, new RegExp(schema.propertyNames.pattern), `${path}.${key} is not an allowed key`);
      }
      if (Object.hasOwn(schema.properties ?? {}, key)) {
        assertSchemaValue(value[key], schema.properties[key], `${path}.${key}`);
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        assertSchemaValue(value[key], schema.additionalProperties, `${path}.${key}`);
      }
    }
    return;
  }

  if (schema.type === 'array') {
    assert.ok(Array.isArray(value), `${path} must be an array`);
    for (const [index, entry] of value.entries()) {
      if (schema.items) assertSchemaValue(entry, schema.items, `${path}[${index}]`);
    }
    return;
  }

  if (schema.type === 'string') {
    assert.equal(typeof value, 'string', `${path} must be a string`);
    if (schema.pattern) assert.match(value, new RegExp(schema.pattern), `${path} has an invalid format`);
    if (schema.format === 'date-time') {
      assert.ok(!Number.isNaN(Date.parse(value)), `${path} must be a date-time`);
    }
    return;
  }

  if (schema.type === 'integer') {
    assert.ok(Number.isInteger(value), `${path} must be an integer`);
  } else if (schema.type === 'number') {
    assert.equal(typeof value, 'number', `${path} must be a number`);
  } else if (schema.type === 'boolean') {
    assert.equal(typeof value, 'boolean', `${path} must be a boolean`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined) assert.ok(value >= schema.minimum, `${path} is below its minimum`);
    if (schema.maximum !== undefined) assert.ok(value <= schema.maximum, `${path} is above its maximum`);
  }
}

function assertRegisteredEvent(event) {
  const contract = PANEL_EVENT_CONTRACTS[event.type];
  assert.ok(contract, `event type ${event.type} is outside the closed Premiere allowlist`);
  assert.ok(REGISTRY[event.type], `event type ${event.type} is not registered`);

  const registered = REGISTRY[event.type];
  assert.deepEqual([...registered.required].sort(), [...contract.required].sort(), `${event.type} required fields drifted`);
  assert.deepEqual([...registered.optional].sort(), [...contract.optional].sort(), `${event.type} optional fields drifted`);

  assert.ok(event.data !== null && typeof event.data === 'object' && !Array.isArray(event.data), 'event data must be an object');
  for (const key of contract.required) {
    assert.ok(Object.hasOwn(event.data, key), `${event.type}.data.${key} is required`);
  }
  const allowed = new Set([...contract.required, ...contract.optional]);
  for (const key of Object.keys(event.data)) {
    assert.ok(allowed.has(key), `${event.type}.data.${key} is not allowed (additionalProperties: false)`);
  }
  if (Object.hasOwn(event.data, 'cid')) assert.match(event.data.cid, /^[A-Z]{2,4}\d{4,6}-[A-Z]{2}\d{2,3}$/);
  if (Object.hasOwn(event.data, 'app')) assert.equal(event.data.app, 'premiere_pro');
  if (Object.hasOwn(event.data, 'project_name_hash')) assert.match(event.data.project_name_hash, /^[0-9a-f]{64}$/);
  if (Object.hasOwn(event.data, 'project_display_name')) assert.equal(typeof event.data.project_display_name, 'string');
  if (Object.hasOwn(event.data, 'output_name')) assert.equal(typeof event.data.output_name, 'string');
  if (Object.hasOwn(event.data, 'sequence_name')) assert.equal(typeof event.data.sequence_name, 'string');
}

function assertEnvelope(event) {
  assertSchemaValue(event, { ...envelopeSchema, allOf: undefined }, 'event');

  for (const clause of envelopeSchema.allOf ?? []) {
    const expectedType = clause.if?.properties?.type?.const;
    if (expectedType !== event.type) continue;
    const thenProperties = clause.then?.properties ?? {};
    for (const [key, propertySchema] of Object.entries(thenProperties)) {
      if (Object.hasOwn(event, key)) assertSchemaValue(event[key], propertySchema, `event.${key}`);
    }
  }
}

function makeEvent(type, data) {
  const registered = REGISTRY[type];
  const subject = type.startsWith('app.export.') || type.startsWith('app.render.')
    ? 'file:local:synthetic-export.mp4'
    : 'device:pulse:synthetic-device';
  return {
    specversion: '1.0',
    id: '01J00000000000000000000000',
    source: '/agent/premiere',
    type,
    time: '2026-10-08T00:00:00Z',
    subject,
    orgid: '11111111-1111-4111-8111-111111111111',
    purpose: registered.purposes.join(','),
    sensitivity: registered.sensitivity,
    visibility: registered.visibility,
    data,
  };
}

function makeProjectEvent(type = 'app.project.opened') {
  return makeEvent(type, {
    app: 'premiere_pro',
    project_name_hash: 'a'.repeat(64),
    project_display_name: 'synthetic-project',
  });
}

function makeExportEvent(type = 'app.export.completed') {
  return makeEvent(type, {
    app: 'premiere_pro',
    output_name: 'synthetic-export.mp4',
    sequence_name: 'synthetic-sequence',
    cid: SYNTHETIC_CID,
  });
}

function workDeltaData() {
  return {
    app: 'premiere_pro',
    project_name_hash: 'b'.repeat(64),
    cid: SYNTHETIC_CID,
    from_save: '2026-10-08T00:00:00Z',
    to_save: '2026-10-08T00:01:00Z',
    baseline: false,
    counts: { clip_added: 1, cut: 2, trim: 0 },
    timeline_ms: 60_000,
    net_ewu: 1.5,
    gross_ewu: 2,
  };
}

function workDeltaSchema() {
  const clause = envelopeSchema.allOf.find(
    (entry) => entry.if?.properties?.type?.const === 'app.work.delta',
  );
  assert.ok(clause, 'registered envelope must define app.work.delta');
  const schema = clause.then.properties.data;
  assert.equal(schema.additionalProperties, false, 'work-delta data must be closed');
  assert.equal(schema.properties.counts.additionalProperties, false, 'work-delta counts must be closed');
  return schema;
}

test('pins the Premiere event allowlist to registered project, export, render, and work-delta shapes', () => {
  assert.deepEqual(
    Object.keys(PANEL_EVENT_CONTRACTS).sort(),
    Object.keys(REGISTRY).filter((type) => Object.hasOwn(PANEL_EVENT_CONTRACTS, type)).sort(),
  );

  for (const type of Object.keys(PANEL_EVENT_CONTRACTS)) {
    const event = type.startsWith('app.project.')
      ? makeProjectEvent(type)
      : type === 'app.work.delta'
        ? makeEvent(type, workDeltaData())
        : type === 'app.render.completed'
          ? makeEvent(type, { app: 'premiere_pro', output_name: 'synthetic-render.mp4' })
          : makeExportEvent(type);
    assertRegisteredEvent(event);
    assertEnvelope(event);
  }
});

test('validates work-delta identifiers, timestamps, and counts against the registered envelope schema', () => {
  const data = workDeltaData();
  assertSchemaValue(data, workDeltaSchema(), 'event.data');
  assertRegisteredEvent(makeEvent('app.work.delta', data));
});

test('keeps sequence context on the registered export event', () => {
  const event = makeExportEvent();
  assert.ok(PANEL_EVENT_CONTRACTS['app.export.completed'].optional.includes('sequence_name'));
  assertRegisteredEvent(event);
  assertEnvelope(event);
});

test('rejects event types outside the closed panel allowlist', () => {
  assert.throws(
    () => assertRegisteredEvent({ type: 'app.sequence.opened', data: {} }),
    /outside the closed Premiere allowlist/,
  );
});

for (const field of FORBIDDEN_EXTRA_FIELDS) {
  test(`rejects undeclared ${field} payloads`, () => {
    const event = makeProjectEvent();
    event.data[field] = 'synthetic-forbidden-value';
    assert.throws(() => assertRegisteredEvent(event), /additionalProperties: false/);
  });
}

test('rejects extra nested work-delta count properties', () => {
  const data = workDeltaData();
  data.counts.command_text = 1;
  assert.throws(() => assertSchemaValue(data, workDeltaSchema(), 'event.data'), /not allowed/);
});
