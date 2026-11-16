// PHONE-QA: a side-by-side QA copy of the Android shell that opens a loopback Pulse (adb reverse) instead of production.
// Never committed output and never published: it writes a patched copy of apps/mobile into OUT, with
//   - package com.pulse.work.mobile.qa and the label "Pulse QA", so it installs next to a tester's real Pulse app
//     (debug key; the real app and its data are untouched);
//   - the start page, the shell's own host checks and the native gateway on ORIGIN (http://localhost:<port> only),
//     plain HTTP allowed for that loopback address, and WebView debugging on for chrome://inspect.
// Every patch must find its token, so a changed shell fails here instead of building a half-pointed app.
//
//   node tools/qa/phone-qa/make-qa-shell.mjs <out dir> [http://localhost:4610]
//   cd <out dir> && npx cap sync android     (then gradle assembleDebug in <out dir>/android)
import { cpSync, existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROD = 'https://pulse.estateautopilots.com', PROD_HOST = 'pulse.estateautopilots.com', PACKAGE = 'com.pulse.work.mobile';
export const QA_PACKAGE = `${PACKAGE}.qa`;

export function qaOrigin(value = 'http://localhost:4610') {
  const m = /^http:\/\/localhost:(\d{2,5})$/.exec(value);
  if (!m || Number(m[1]) < 1024 || Number(m[1]) > 65535) throw Error('origin must be http://localhost:<port 1024-65535> (a loopback reached through adb reverse)');
  return value;
}

/** [file, token, replacement]; each token must occur in its file. */
export function patches(origin) {
  const java = 'android/app/src/main/java/com/pulse/work/mobile';
  return [
    ['www/index.html', PROD, origin],
    ['www/offline.html', PROD, origin],
    [`${java}/MainActivity.java`, `static final String HOST = "${PROD_HOST}";`, 'static final String HOST = "localhost";'],
    [`${java}/MainActivity.java`, 'static final String ORIGIN = "https://" + HOST;', `static final String ORIGIN = "${origin}";`],
    [`${java}/ShellWebViewClient.java`, '"https".equals(url.getScheme()) && MainActivity.HOST.equals(url.getHost())',
      'MainActivity.ORIGIN.startsWith(url.getScheme() + "://") && MainActivity.HOST.equals(url.getHost()) && url.getPort() == Uri.parse(MainActivity.ORIGIN).getPort()'],
    [`${java}/ShellDownloads.java`, '!"https".equals(scheme) || !MainActivity.HOST.equals(uri.getHost())',
      '!MainActivity.ORIGIN.startsWith(scheme + "://") || !MainActivity.HOST.equals(uri.getHost())'],
    ['android/app/src/main/AndroidManifest.xml', 'android:enableOnBackInvokedCallback="true">', 'android:enableOnBackInvokedCallback="true"\n        android:usesCleartextTraffic="true">'],
    ['android/app/src/main/AndroidManifest.xml', `android:taskAffinity="${PACKAGE}.ring"`, `android:taskAffinity="${QA_PACKAGE}.ring"`],
    ['android/app/src/main/AndroidManifest.xml', `android:host="${PROD_HOST}"`, 'android:host="localhost"'],
    ['android/app/src/main/res/values/strings.xml', '<string name="app_name">Pulse</string>', '<string name="app_name">Pulse QA</string>'],
    ['android/app/src/main/res/values/strings.xml', '<string name="title_activity_main">Pulse</string>', '<string name="title_activity_main">Pulse QA</string>'],
    ['android/app/build.gradle', `applicationId "${PACKAGE}"`, `applicationId "${QA_PACKAGE}"`],
  ];
}

export function makeQaShell(app, out, value) {
  const origin = qaOrigin(value);
  if (existsSync(out)) rmSync(out, { recursive: true, force: true });
  cpSync(app, out, { recursive: true, filter: (src) => !/[\\/](node_modules|ios|build|\.gradle)([\\/]|$)/.test(src.slice(app.length)) });
  // The workspace's own packages (pnpm links resolve from the real apps/mobile directory).
  if (existsSync(join(app, 'node_modules'))) symlinkSync(resolve(app, 'node_modules'), join(out, 'node_modules'), 'junction');
  const edits = new Map();
  for (const [path, token, replacement] of patches(origin)) {
    const before = edits.get(path) ?? readFileSync(join(out, path), 'utf8');
    if (!before.includes(token)) throw Error(`QA shell: token not found in ${path}: ${token}`);
    edits.set(path, before.replaceAll(token, replacement));
  }
  for (const [path, after] of edits) writeFileSync(join(out, path), after);
  const config = JSON.parse(readFileSync(join(out, 'capacitor.config.json'), 'utf8'));
  if (config.server?.url !== PROD || config.appId !== PACKAGE) throw Error('QA shell: capacitor.config.json is not the default build');
  Object.assign(config, { appId: QA_PACKAGE, appName: 'Pulse QA' });
  Object.assign(config.server, { url: origin, cleartext: true });
  Object.assign(config.android, { webContentsDebuggingEnabled: true });
  writeFileSync(join(out, 'capacitor.config.json'), `${JSON.stringify(config, null, 2)}\n`);
  return { origin, package: QA_PACKAGE };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [out, origin] = process.argv.slice(2);
  if (!out) { console.error('usage: make-qa-shell.mjs <out dir> [http://localhost:<port>]'); process.exit(2); }
  const app = resolve(dirname(fileURLToPath(import.meta.url)), '../../../apps/mobile');
  console.log(JSON.stringify(makeQaShell(app, resolve(out), origin)));
}
