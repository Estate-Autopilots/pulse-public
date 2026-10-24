// One Android build input, applied before cap sync. Committed files retain the default build verbatim.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_ORIGIN = 'https://pulse.estateautopilots.com';
export function validateOrigin(value = '') {
  const origin = value || DEFAULT_ORIGIN;
  const host = origin.slice('https://'.length);
  if (!origin.startsWith('https://') || host.length > 253 || /[^a-z0-9.-]/.test(host) ||
      !host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
      !URL.canParse(origin) || new URL(origin).origin !== origin) {
    throw Error('origin must be https:// followed by a lowercase DNS host only (no port, path, query, fragment or userinfo)');
  }
  return origin;
}

export function configureOrigin(app, value = '') {
  const origin = validateOrigin(value), host = new URL(origin).hostname;
  const previous = JSON.parse(readFileSync(resolve(app, 'capacitor.config.json'), 'utf8')).server.url;
  const oldHost = new URL(validateOrigin(previous)).hostname;
  const paths = [
    ['capacitor.config.json', `"url": "${previous}"`, `"url": "${origin}"`],
    ['www/index.html', previous, origin], ['www/offline.html', previous, origin],
    ['android/app/src/main/java/com/pulse/work/mobile/MainActivity.java', `HOST = "${oldHost}"`, `HOST = "${host}"`],
    ['android/app/src/main/AndroidManifest.xml', `android:host="${oldHost}"`, `android:host="${host}"`],
  ];
  // Validate every target before writing any: a stale template must fail rather than build a mixed-host app.
  const changes = paths.map(([path, token, replacement]) => {
    const file = resolve(app, path), before = readFileSync(file, 'utf8');
    if (!before.includes(token)) throw Error(`Missing build host in ${path}`);
    // The manifest also names the assetlinks URL in its comment; the other targets contain only their own field.
    const source = path.endsWith('AndroidManifest.xml') ? before.replaceAll(previous, origin) : before;
    return { file, after: source.replaceAll(token, replacement) };
  });
  for (const { file, after } of changes) writeFileSync(file, after);
  return origin;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`Android origin: ${configureOrigin(resolve(dirname(fileURLToPath(import.meta.url)), '..'), process.env.PULSE_ORIGIN)}`);
}
