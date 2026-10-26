import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url));

async function typescriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return typescriptFiles(path);
    return entry.isFile() && path.endsWith('.ts') ? [path] : [];
  }));
  return nested.flat();
}

test('API source has no tenant UUID literals or PULSE_ORG_ID fallback', async () => {
  const uuidLiteral = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
  const orgFallback = /\bPULSE_ORG_ID\s*\?\?/;

  for (const path of await typescriptFiles(sourceRoot)) {
    const source = await readFile(path, 'utf8');
    const filename = relative(sourceRoot, path);
    assert.doesNotMatch(source, uuidLiteral, `${filename} contains a UUID literal`);
    assert.doesNotMatch(source, orgFallback, `${filename} falls back from PULSE_ORG_ID`);
  }
});
