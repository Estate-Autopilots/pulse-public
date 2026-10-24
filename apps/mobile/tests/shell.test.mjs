// Static checks of the Pulse phone app shell. Gradle and Xcode run only on hosted runners; these run everywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, cpSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configureOrigin, validateOrigin, DEFAULT_ORIGIN } from '../scripts/configure-origin.mjs';
import { parseManifest, releaseURL } from '../../../packages/companion/src/updates.js';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(app, '../..');
const read = p => readFileSync(resolve(app, p), 'utf8');
const config = JSON.parse(read('capacitor.config.json'));
const pkg = JSON.parse(read('package.json'));
const manifest = read('android/app/src/main/AndroidManifest.xml');
const gradle = read('android/app/build.gradle');
const java = read('android/app/src/main/java/com/pulse/work/mobile/PulseShellPlugin.java');
const swift = read('ios/App/App/PulseShellPlugin.swift');
// The published Expo 1.0.0 APK (companion-v1.0.0-8aec149), read from its binary manifest on 9 October 2026.
const PUBLISHED_EXPO_VERSION_CODE = 1000000;
const PULSE_SIGNING_SHA256 = '7fb7e080fe49b5f285cbd436c500167575d5f1e6f862e7fbbebb3bec6d0989e6';

test('the shell loads production Pulse and nothing else inside the app', () => {
  assert.equal(config.appId, 'com.pulse.work.mobile');
  assert.equal(config.server.url, 'https://pulse.estateautopilots.com');
  assert.deepEqual(config.server.allowNavigation, [], 'other sites open outside the app');
  assert.notEqual(config.server.cleartext, true);
  assert.equal(config.android.allowMixedContent, false);
  assert.equal(config.android.webContentsDebuggingEnabled, false);
  assert.equal(config.plugins.CapacitorHttp.enabled, false, 'the page keeps its own fetch and cookies');
  assert.ok(existsSync(resolve(app, 'www', config.server.errorPath)), 'the offline screen is bundled');
  assert.match(config.appendUserAgent, new RegExp(`^PulseShell/${pkg.version.replaceAll('.', '\\.')}$`));
});

test('the offline screen only ever reopens Pulse', () => {
  const html = read('www/offline.html');
  assert.match(html, /var ORIGIN = 'https:\/\/pulse\.estateautopilots\.com';/);
  assert.match(html, /from\.indexOf\(ORIGIN \+ '\/'\) === 0 \? from : ORIGIN \+ '\/'/);
  assert.doesNotMatch(html, /<script[^>]+src=|<link[^>]+href=|https?:\/\/(?!pulse\.estateautopilots\.com|www\.w3\.org)/, 'self-contained: works with no network');
  assert.match(html, />Retry</);
});

test('installs over the Expo app: same package, durable key, higher versionCode', () => {
  assert.match(gradle, /applicationId "com\.pulse\.work\.mobile"/);
  assert.match(gradle, new RegExp(`def pulseVersion = '${pkg.version.replaceAll('.', '\\.')}'`));
  const [a, b, c] = pkg.version.split('.').map(Number);
  assert.ok(a * 1000000 + b * 1000 + c > PUBLISHED_EXPO_VERSION_CODE);
  assert.equal(pkg.version, '1.1.4');
  assert.match(gradle, /storeType "PKCS12"[\s\S]*keyAlias "pulse"/, 'the Expo build used this key store and alias');
  const pbx = read('ios/App/App.xcodeproj/project.pbxproj');
  assert.equal((pbx.match(new RegExp(`MARKETING_VERSION = ${pkg.version.replaceAll('.', '\\.')};`, 'g')) ?? []).length, 2);
  assert.equal((pbx.match(/CURRENT_PROJECT_VERSION = 1001004;/g) ?? []).length, 2);
});

test('the Android manifest asks for no tracking and keeps credentials on the phone', () => {
  // CHAT-VOICE (22 Oct 2026): calls and voice messages need the microphone (asked when a call or a recording starts);
  // contacts are never read. READY: the test still forbade RECORD_AUDIO from before calls existed (intended change).
  assert.doesNotMatch(manifest, /READ_CONTACTS|FOREGROUND_SERVICE/);
  // PRESENCE-ONBOARD (owner, 10 Oct 2026): office arrival by geofence. Background location exists only for Android's
  // own geofences around the person's offices, after their consent and a separate "Allow all the time"; there is no
  // foreground service and no continuous location request anywhere in the shell (a position is read once, on a tap).
  assert.match(manifest, /ACCESS_BACKGROUND_LOCATION/);
  assert.match(manifest, /OfficeArrival\$Receiver" android:exported="false"/);
  for (const f of readdirSync(resolve(app, 'android/app/src/main/java/com/pulse/work/mobile')).filter((f) => f.endsWith('.java'))) {
    const src = read(`android/app/src/main/java/com/pulse/work/mobile/${f}`);
    assert.doesNotMatch(src, /requestLocationUpdates|LocationRequest\.Builder|FusedLocationProviderClient/, `${f} never asks for continuous location`);
    if (f !== 'PulseShellPlugin.java') assert.doesNotMatch(src, /getCurrentLocation|requestSingleUpdate/, `${f} reads no position (only the tap in PulseShellPlugin does)`);
  }
  assert.doesNotMatch(read('android/app/src/main/java/com/pulse/work/mobile/OfficeArrival.java'), /getLatitude|getLongitude|"lat"\s*,|put\("lng"/, 'arrival sends an office and a signal kind, never a position');
  // CHAT-VOICE (22 Oct 2026): video calls use the camera (asked when a video call starts); photos still come from the
  // camera app. READY: the test forbade CAMERA from before calls existed (intended change).
  assert.match(manifest, /android\.permission\.CAMERA/);
  // PEOPLE-CONTACTS: "Take a photo" (an image field with capture) opens the camera in WKWebView, which iOS allows only
  // with a camera usage description; Photo Library needs none (the system picker runs outside the app).
  assert.match(read('ios/App/App/Info.plist'), /<key>NSCameraUsageDescription<\/key>\s*<string>[^<]{20,}<\/string>/, 'the iPhone app says why it may use the camera');
  assert.doesNotMatch(read('ios/App/App/Info.plist'), /NSPhotoLibraryUsageDescription/, 'no photo-library access: the system picker hands over one picture');
  assert.match(manifest, /android:allowBackup="false"/);
  assert.match(manifest, /android:dataExtractionRules="@xml\/data_extraction_rules"/);
  assert.equal((manifest.match(/android:exported="true"/g) ?? []).length, 1, 'only the main activity is exported');
});

test('all production Pulse routes open in the app, including future web routes', () => {
  assert.match(manifest, /android:autoVerify="true"/);
  assert.match(manifest, /android:host="pulse\.estateautopilots\.com"/);
  assert.doesNotMatch(manifest, /android:path(?:Prefix|Pattern)?=/, 'App Links cover every production route');
  const hosts = [...manifest.matchAll(/android:host="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(hosts, ['pulse.estateautopilots.com'], 'external domains stay outside the app');
  const links = resolve(repo, 'apps/web/app/lib/assetlinks.json');
  if (existsSync(links)) {
    const target = JSON.parse(readFileSync(links, 'utf8'))[0].target;
    assert.equal(target.package_name, 'com.pulse.work.mobile');
    assert.deepEqual(target.sha256_cert_fingerprints, [PULSE_SIGNING_SHA256.match(/../g).join(':').toUpperCase()]);
  }
});

test('the bridge has the same methods on Android, iPhone and in the web app', () => {
  const androidMethods = [...java.matchAll(/@PluginMethod[^\n]*\n(?:\s*@[^\n]+\n)*\s*public void (\w+)\(PluginCall/g)].map(m => m[1]).sort();
  // Capacitor's own checkPermissions/requestPermissions are inherited on Android; iOS must list them (POLISH-1).
  const builtIn = ['checkPermissions', 'requestPermissions'];
  const iosMethods = [...swift.matchAll(/CAPPluginMethod\(name: "(\w+)"/g)].map(m => m[1]).filter(m => !builtIn.includes(m)).sort();
  for (const m of builtIn) assert.match(swift, new RegExp(`CAPPluginMethod\\(name: "${m}"[\\s\\S]*override public func ${m}\\(_ call: CAPPluginCall\\)`), `iOS dispatches and answers ${m}`);
  assert.deepEqual(iosMethods, androidMethods);
  const web = resolve(repo, 'apps/web/app/lib/native-shell.ts');
  if (existsSync(web)) {
    const body = readFileSync(web, 'utf8').split('export interface PulseShell {')[1].split('\n}')[0];
    // A method an older installed app may lack is optional in the web's type (setSpeaker?): it still counts.
    const webMethods = [...body.matchAll(/^\s+(\w+)\??\(/gm)].map(m => m[1]).filter(m => !['checkPermissions', 'requestPermissions'].includes(m)).sort();
    assert.deepEqual(webMethods, androidMethods);
  }
});

test('updates only come from Pulse release downloads and are verified before the installer opens', () => {
  const updater = read('android/app/src/main/java/com/pulse/work/mobile/Updater.java');
  assert.match(updater, /\^\/Estate-Autopilots\/pulse-companion\/releases\/download\/companion-v/);
  assert.match(updater, /bytes != size \|\| !hex\(digest\.digest\(\)\)\.equals\(sha256\)/);
  assert.match(updater, /newCode <= oldCode \|\| oldSigners\.isEmpty\(\) \|\| !oldSigners\.equals\(signers\(candidate\)\)/);
  assert.match(updater, /api\/app-updates\/test\/latest\.json/);
});

// Evaluate the Android pattern itself, including the suffix selected for this build.
function androidReleasePattern(origin) {
  const updater = read('android/app/src/main/java/com/pulse/work/mobile/Updater.java');
  const expression = updater.match(/Pattern RELEASE = Pattern\.compile\(([^\n]+)\);/)[1];
  const suffix = origin === DEFAULT_ORIGIN ? '' : createHash('sha256').update(origin).digest('hex').slice(0, 8);
  return new RegExp(runInNewContext(expression, { releaseSuffix: () => suffix }));
}
const androidReleasePath = suffix => `/Estate-Autopilots/pulse-companion/releases/download/companion-v1.2.3-${suffix}/Pulse-1.2.3-android.apk`;

test('default Android builds refuse host-suffixed releases and require exactly seven SHA characters', () => {
  const pattern = androidReleasePattern(DEFAULT_ORIGIN);
  assert.ok(pattern.test(androidReleasePath('abcdef0')));
  const hostSuffix = createHash('sha256').update('https://pulse.example.com').digest('hex').slice(0, 8);
  for (const suffix of ['abcdef0' + hostSuffix, 'abcdef', 'abcdef01', 'ABCDEF0', 'abcdefg', '']) {
    assert.ok(!pattern.test(androidReleasePath(suffix)), `default build refuses ${suffix}`);
  }
});

test('origin Android builds refuse EA releases, other origins and malformed suffixes', () => {
  const origins = ['https://pulse.example.com', 'https://another.example.com'];
  for (const origin of origins) {
    const pattern = androidReleasePattern(origin);
    const suffix = createHash('sha256').update(origin).digest('hex').slice(0, 8);
    const otherSuffix = createHash('sha256').update(origins.find(value => value !== origin)).digest('hex').slice(0, 8);
    assert.ok(pattern.test(androidReleasePath('abcdef0' + suffix)));
    for (const value of ['abcdef0', 'abcdef0' + otherSuffix, 'abcdef' + suffix, 'abcdef01' + suffix, 'abcdef0' + suffix + '0']) {
      assert.ok(!pattern.test(androidReleasePath(value)), `${origin} refuses ${value}`);
    }
  }
});

test('Android availability and download share the origin guard before any download connection', () => {
  const updater = read('android/app/src/main/java/com/pulse/work/mobile/Updater.java');
  assert.match(updater, /if \("https:\/\/pulse\.estateautopilots\.com"\.equals\(MainActivity\.ORIGIN\)\) return "";/);
  assert.match(updater, /hex\(MessageDigest\.getInstance\("SHA-256"\)\.digest\(MainActivity\.ORIGIN\.getBytes\(StandardCharsets\.UTF_8\)\)\)\.substring\(0, 8\)/);
  assert.match(updater, /out\.put\("available", code > Shell\.code\(\) && trustedRelease\(f\.getString\("url"\)\)\)/);
  const guard = updater.split('boolean trustedRelease(String value)')[1].split('static long codeOf')[0];
  assert.match(guard, /"https"\.equals\(url\.getProtocol\(\)\) && "github.com"\.equals\(url\.getHost\(\)\) && RELEASE\.matcher\(url\.getPath\(\)\)\.matches\(\)/);
  assert.match(guard, /catch \(MalformedURLException e\) \{\s*return false;/);
  const download = updater.split('static String download(')[1];
  assert.match(download, /if \(!trustedRelease\(url\)\) throw new SecurityException\("Untrusted update download"\)/);
  assert.ok(download.indexOf('!trustedRelease(url)') < download.indexOf('next.openConnection()'));
});

test('the device credential never reaches the page', () => {
  for (const method of ['finishEnrollment', 'info']) {
    const body = java.split(`public void ${method}(PluginCall call)`)[1].split('@PluginMethod')[0];
    assert.doesNotMatch(body, /out\.put\("(accessToken|refreshToken|pollSecret)"|r\.put\("(accessToken|refreshToken|pollSecret)"/);
  }
  assert.match(read('android/app/src/main/java/com/pulse/work/mobile/ShellStore.java'), /AndroidKeyStore[\s\S]*AES\/GCM\/NoPadding/);
  assert.match(swift, /kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly/);
});

test('a file the page made saves without the page bridge, and a failure is said (EST-1742)', async () => {
  const downloads = read('android/app/src/main/java/com/pulse/work/mobile/ShellDownloads.java');
  const data = downloads.split('if ("data".equals(scheme))')[1].split('if ("blob".equals(scheme))')[0];
  assert.doesNotMatch(data, /Capacitor\.Plugins|PulseShell/);
  // 50 MB in either encoding: a Base64 length guard before decoding, the exact byte count after it.
  const save = downloads.split('private void saveData(')[1].split('static void failed(')[0];
  assert.match(save, /body\.length\(\) > \(MAX \+ 2\) \/ 3 \* 4\) throw[\s\S]*Base64\.decode\(body, Base64\.DEFAULT\) : body\.getBytes\(StandardCharsets\.UTF_8\);\s*if \(bytes\.length > MAX\) throw[\s\S]*catch \(Exception e\) \{\s*failed\(activity,/);
  assert.equal((50 * 1024 * 1024 + 2 - (50 * 1024 * 1024 + 2) % 3) / 3 * 4, Buffer.alloc(50 * 1024 * 1024).toString('base64').length);
  assert.doesNotMatch(downloads, /catch\(e\)\{\}/);
  assert.match(java.split('public void saveFile(PluginCall call)')[1].split('String name')[0], /call\.getBoolean\("failed", false\)[\s\S]*ShellDownloads\.failed\(getActivity\(\)/);
  // The blob script the shell injects, evaluated from its Java expression: every failure ends in saveFile({failed}).
  const blob = downloads.split('if ("blob".equals(scheme))')[1].split('return;')[0];
  const expr = blob.split('web.evaluateJavascript(')[1].split(',\n                ok ->')[0];
  const linkExpr = downloads.match(/String link = (.*);\n/)[1];
  const url = 'blob:https://pulse.example.com/1', name = 'Pulse file.pdf', mimetype = 'application/pdf', quote = JSON.stringify;
  const link = runInNewContext(linkExpr, { quote, url });
  const script = runInNewContext(expr, { quote, url, name, mimetype, link });
  const run = async ({ bridge = true, fetchFails = false, readFails = false, saveFails = false } = {}) => {
    const calls = [];
    const PulseShell = { saveFile: o => { calls.push(o); return !o.failed && saveFails ? Promise.reject(new Error('disk')) : Promise.resolve(); } };
    const Capacitor = bridge ? { Plugins: { PulseShell } } : undefined;
    class FileReader { readAsDataURL() { setTimeout(() => readFails ? this.onerror() : (this.result = 'data:application/pdf;base64,QUJD', this.onload())); } }
    const fetch = async () => { if (fetchFails) throw new TypeError('revoked'); return { blob: async () => ({ type: 'application/pdf' }) }; };
    const answer = runInNewContext(script, { window: { Capacitor }, Capacitor, FileReader, fetch, setTimeout, console: { error() {} },
      document: { querySelectorAll: () => [] } });
    await new Promise(done => setTimeout(done, 20));
    return JSON.parse(JSON.stringify({ answer, calls }));
  };
  assert.deepEqual(await run({ bridge: false }), { answer: false, calls: [] });
  assert.deepEqual((await run()).calls, [{ name, mime: 'application/pdf', base64: 'QUJD' }]);
  for (const failure of [{ fetchFails: true }, { readFails: true }]) assert.deepEqual((await run(failure)).calls, [{ failed: true }], JSON.stringify(failure));
  assert.deepEqual((await run({ saveFails: true })).calls.at(-1), { failed: true });
  // The emulator harness: Android asks for notifications only from 13 (API 33) on.
  const qa = read('scripts/android-qa.sh');
  assert.match(qa, /if phase permissions && \(\( SDK < 33 \)\); then[\s\S]*result notification_prompt pass[\s\S]*elif phase permissions; then/);
  assert.match(qa, /if \(\( SDK < 33 \)\); then result notifications_on_by_default/);
});

test('no Expo or React Native code remains', () => {
  assert.ok(!Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).some(d => /^(expo|react-native|@expo\/|react$)/.test(d)));
  assert.equal(createHash('sha256').update(PULSE_SIGNING_SHA256).digest('hex').length, 64);
});

const scratch = () => mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || tmpdir(), 'pulse-origin-'));
const originFiles = ['capacitor.config.json', 'www/index.html', 'www/offline.html',
  'android/app/src/main/java/com/pulse/work/mobile/MainActivity.java', 'android/app/src/main/AndroidManifest.xml'];

test('one origin configures the complete Android shell; omitted input restores the exact default', () => {
  const dir = scratch();
  try {
    for (const path of ['capacitor.config.json', 'www', 'android/app/src/main']) {
      cpSync(resolve(app, path), resolve(dir, path), { recursive: true });
    }
    const contents = path => readFileSync(resolve(dir, path), 'utf8');
    configureOrigin(dir);
    for (const path of originFiles) assert.equal(contents(path), read(path), `default ${path} unchanged`);
    const origin = 'https://pulse.example.com', host = new URL(origin).hostname;
    configureOrigin(dir, origin);
    configureOrigin(dir, origin); // Repeated syncs are safe.
    configureOrigin(dir, 'https://com');
    configureOrigin(dir, 'https://company.example');
    assert.equal(JSON.parse(contents('capacitor.config.json')).server.url, 'https://company.example');
    configureOrigin(dir, origin); // A short previous host must not rewrite Java packages or identifiers.
    assert.match(contents(originFiles[3]), /^package com\.pulse\.work\.mobile;/);
    for (const path of originFiles) assert.doesNotMatch(contents(path), /estateautopilots/i, path);
    for (const file of readdirSync(resolve(dir, 'android/app/src/main/java/com/pulse/work/mobile'))) {
      const source = contents(`android/app/src/main/java/com/pulse/work/mobile/${file}`);
      // Only the default-build comparison may name EA; no configured destination may retain it.
      const destinations = file === 'Updater.java' ? source.replace(`"${DEFAULT_ORIGIN}".equals(MainActivity.ORIGIN)`, 'false') : source;
      assert.doesNotMatch(destinations, /estateautopilots/i, file);
    }
    const built = JSON.parse(contents('capacitor.config.json'));
    assert.equal(built.server.url, origin);
    assert.deepEqual(built.server.allowNavigation, []);
    assert.equal(built.appId, config.appId);
    assert.ok(contents(originFiles[3]).includes(`static final String HOST = "${host}";`));
    assert.deepEqual([...contents(originFiles[4]).matchAll(/android:host="([^"]+)"/g)].map(m => m[1]), [host]);
    assert.ok(contents('www/index.html').includes(`location.replace('${origin}/dashboard')`));
    // Retry never follows an attacker-controlled external URL (including lookalike hosts and userinfo).
    const code = contents('www/offline.html').match(/<script>([\s\S]*?)<\/script>/)[1];
    for (const from of [origin + '/notes', 'https://external.example/', origin + '.evil/notes', origin + '@evil/']) {
      const context = { URLSearchParams, location: { search: '?from=' + encodeURIComponent(from) },
        document: { getElementById: () => ({ addEventListener() {} }) }, window: { addEventListener() {} }, setInterval() {} };
      runInNewContext(code, context);
      assert.equal(context.target, from === origin + '/notes' ? from : origin + '/');
    }
    for (const file of ['ShellWebViewClient', 'ShellDownloads', 'PulseShellPlugin']) {
      assert.match(contents(`android/app/src/main/java/com/pulse/work/mobile/${file}.java`), /MainActivity\.HOST\.equals\(/);
    }
    assert.match(contents('android/app/src/main/java/com/pulse/work/mobile/Gateway.java'), /BASE = MainActivity\.ORIGIN/);
    assert.match(contents('android/app/src/main/java/com/pulse/work/mobile/Updater.java'), /MANIFEST = MainActivity\.ORIGIN/);
    configureOrigin(dir);
    for (const path of originFiles) assert.equal(contents(path), read(path), `restored ${path}`);
    assert.equal(validateOrigin(), DEFAULT_ORIGIN);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('origin rejects ambiguous URLs before changing files', () => {
  for (const value of ['http://pulse.example.com', 'https://pulse.example.com/', 'https://pulse.example.com/path',
    'https://pulse.example.com?x=1', 'https://pulse.example.com#x', 'https://user@pulse.example.com',
    'https://pulse.example.com:443', 'https://pulse.example.com\\evil', 'https://pulse.example.com\n',
    'https://-invalid.example', 'https://pulse..example', 'https://', ' https://pulse.example.com']) {
    assert.throws(() => configureOrigin('/does-not-exist', value), /origin must be/, value);
  }
});

test('host releases keep trusted URLs and publish only their own download entry; default publication is unchanged', () => {
  const tags = [];
  for (const suppliedOrigin of ['', DEFAULT_ORIGIN, 'https://pulse.example.com', 'https://another.example.com']) {
    const origin = suppliedOrigin === DEFAULT_ORIGIN ? '' : suppliedOrigin;
    const dir = scratch();
    try {
      mkdirSync(join(dir, 'artifacts'));
      mkdirSync(join(dir, 'bin'));
      writeFileSync(join(dir, 'artifacts', `Pulse-${pkg.version}-android.apk`), 'synthetic-apk');
      if (!origin) writeFileSync(join(dir, 'artifacts', `Pulse-${pkg.version}-ios-simulator.zip`), 'synthetic-ios');
      writeFileSync(join(dir, 'bin/gh'), `#!/usr/bin/env node\nrequire('node:fs').appendFileSync('calls.jsonl', JSON.stringify(process.argv.slice(2))+'\\n');\nif (process.argv[3] === 'view') process.exit(1);\n`, { mode: 0o755 });
      const sha = 'a'.repeat(40);
      const result = JSON.parse(execFileSync(process.execPath, [resolve(app, 'scripts/publish-prerelease.mjs')], {
        cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: join(dir, 'bin') + ':' + process.env.PATH,
          RELEASE_VERSION: pkg.version, GITHUB_SHA: sha, GITHUB_RUN_ID: '123', GITHUB_REF: 'refs/heads/main',
          GITHUB_REPOSITORY: 'Estate-Autopilots/pulse-companion', PULSE_ORIGIN: suppliedOrigin },
      }));
      const suffix = origin ? createHash('sha256').update(origin).digest('hex').slice(0, 8) : '';
      assert.equal(result.tag, `companion-v${pkg.version}-${sha.slice(0, 7)}${suffix}`);
      tags.push(result.tag);
      const entryName = origin ? `android-${new URL(origin).hostname}-entry.json` : 'android-channel-entry.json';
      const entry = JSON.parse(readFileSync(join(dir, 'release', entryName)));
      assert.equal(entry.origin, origin || undefined);
      assert.equal(entry.versionCode, 1001004);
      assert.equal(entry.size, Buffer.byteLength('synthetic-apk'));
      assert.equal(entry.sha256, createHash('sha256').update('synthetic-apk').digest('hex'));
      assert.equal(entry.url, `https://github.com/Estate-Autopilots/pulse-companion/releases/download/${result.tag}/${entry.name}`);
      assert.ok(releaseURL(entry.url)); // Installed app release trust rule accepts the host-suffixed tag.
      assert.ok(androidReleasePattern(origin || DEFAULT_ORIGIN).test(new URL(entry.url).pathname));
      const calls = readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
      const versioned = calls.find(args => args[1] === 'create' && args[2] === result.tag);
      assert.equal(versioned[versioned.indexOf('--title') + 1], `Pulse for Android ${pkg.version} (${origin ? new URL(origin).hostname : 'phone app'})`);
      assert.ok(!versioned.includes('--prerelease'));
      assert.equal(versioned.includes('--latest=false'), Boolean(origin), 'tenant builds must never become Latest');
      const pointer = calls.find(args => args[1] === 'create' && args[2] === 'companion-phone');
      assert.ok(pointer.includes('--prerelease'), 'the download pointer stays a prerelease');
      assert.doesNotMatch(readFileSync(join(dir, 'release-notes.md'), 'utf8'), /pre-release/);
      const upload = calls.find(args => args[1] === 'upload');
      assert.equal(upload[2], 'companion-phone');
      assert.ok(upload.includes('--clobber'));
      assert.deepEqual(upload.slice(3, -3), [`release/${entryName}`, ...(!origin ? ['release/ios-simulator-entry.json'] : [])]);
      assert.ok(!calls.flat().includes('companion-test'));
      if (origin) {
        assert.doesNotMatch(calls.flat().join(' '), /android-channel-entry|ios-simulator-entry/);
        assert.ok(!existsSync(join(dir, 'release/ios-simulator-entry.json')));
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  assert.equal(tags[0], tags[1], 'explicit and implicit default origins publish the same tag');
  assert.equal(new Set(tags).size, tags.length - 1);
});

test('each address promotes only its own release into its own manifest; EA latest.json and desktops stay unchanged', () => {
  const sha = 'b'.repeat(40), apk = 'Pulse-1.1.4-android.apk', bytes = 'synthetic-apk', wl = 'https://pulse.example.com', other = 'https://another.example.com';
  const download = 'https://github.com/Estate-Autopilots/pulse-companion/releases/download/';
  const release = (origin, change = {}) => {
    const suffix = origin ? createHash('sha256').update(origin).digest('hex').slice(0, 8) : '';
    const tag = `companion-v1.1.4-${sha.slice(0, 7)}${suffix}`;
    const entryName = origin ? `android-${new URL(origin).hostname}-entry.json` : 'android-channel-entry.json';
    const entry = { name: apk, platform: 'android', kind: 'apk', size: Buffer.byteLength(bytes), sha256: createHash('sha256').update(bytes).digest('hex'),
      url: `${download}${tag}/${apk}`, versionCode: 1001004, ...(origin ? { origin } : {}), ...change.entry };
    return { tag, entry, assets: { [entryName]: JSON.stringify(entry), [apk]: change.apk ?? bytes },
      view: { targetCommitish: change.commit ?? sha, createdAt: '2026-10-20T05:00:00Z', body: 'Pulse for Android 1.1.4\n\nBuild: https://github.com/Estate-Autopilots/pulse-companion/actions/runs/456\n' } };
  };
  const desktop = JSON.stringify({ version: '1.0.2', channel: 'test', notes: 'Desktop', platforms: {}, files: [] });
  const shared = { version: '1.1.3', channel: 'test', notes: 'Earlier', commit: '8aec1499fd6ac2704e8154bf3cd9f23dfcdfd162', runId: '37909906067', builtAt: '2026-10-09T09:47:11.355Z', platforms: {},
    files: [{ platform: 'windows', name: 'Pulse-1.0.0-windows.msi', size: 1, sha256: 'c'.repeat(64), url: `${download}companion-v1.0.0-8aec149/Pulse-1.0.0-windows.msi` },
      { platform: 'android', name: 'Pulse-1.1.3-android.apk', size: 1, sha256: 'd'.repeat(64), url: `${download}companion-v1.1.3-9a58d81/Pulse-1.1.3-android.apk` }] };
  // A fake gh over a synthetic public repository: release assets by tag, `release view` JSON, and recorded uploads.
  const gh = `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path'), args = process.argv.slice(2), opt = n => args[args.indexOf(n) + 1];
fs.appendFileSync('calls.jsonl', JSON.stringify(args) + '\\n');
const release = JSON.parse(fs.readFileSync('remote.json', 'utf8'))[args[2]];
if (!release) process.exit(1);
if (args[1] === 'view') process.stdout.write(JSON.stringify(release.view));
else if (args[1] === 'upload') fs.copyFileSync(args[3], 'uploaded-' + path.basename(args[3]));
else {
  const patterns = args.flatMap((a, i) => a === '-p' ? [args[i + 1]] : []);
  const found = Object.keys(release.assets).filter(n => patterns.some(p => p.startsWith('*') ? n.endsWith(p.slice(1)) : n === p));
  if (!found.length) process.exit(1);
  if (opt('-O') === '-') process.stdout.write(release.assets[found[0]]);
  else for (const n of found) fs.writeFileSync(path.join(opt('-D'), n), release.assets[n]);
}
`;
  const promote = (origin, chosen, replaced) => {
    const dir = scratch();
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'bin/gh'), gh, { mode: 0o755 });
    const remote = { 'companion-test': { assets: { 'latest.json': JSON.stringify(shared), 'latest-desktop.json': desktop } } };
    for (const r of [release(''), release(wl), release(other), ...(replaced ? [replaced] : [])]) remote[r.tag] = { assets: r.assets, view: r.view };
    writeFileSync(join(dir, 'remote.json'), JSON.stringify(remote));
    try {
      const out = execFileSync(process.execPath, [resolve(app, 'scripts/promote-android.mjs')], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PATH: join(dir, 'bin') + ':' + process.env.PATH, TMPDIR: dir, GITHUB_REF: 'refs/heads/main',
          GITHUB_REPOSITORY: 'Estate-Autopilots/pulse-companion', PULSE_ORIGIN: origin, PROMOTE_TAG: chosen } });
      const uploads = readdirSync(dir).filter(n => n.startsWith('uploaded-'));
      const files = Object.fromEntries(uploads.map(n => [n.slice('uploaded-'.length), JSON.parse(readFileSync(join(dir, n), 'utf8'))]));
      return { result: JSON.parse(out), uploads, read: n => files[n],
        calls: readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) };
    } catch (error) {
      assert.deepEqual(readdirSync(dir).filter(n => n.startsWith('uploaded-')), [], 'a refused promote uploads nothing');
      throw error;
    } finally { rmSync(dir, { recursive: true, force: true }); }
  };

  for (const origin of ['', DEFAULT_ORIGIN]) {
    const { uploads, read: uploaded, calls } = promote(origin, release('').tag);
    assert.deepEqual(uploads, ['uploaded-latest.json'], 'EA promotes only the shared phone manifest');
    const manifest = uploaded('latest.json');
    assert.equal(manifest.version, '1.1.4');
    assert.deepEqual(manifest.files.filter(f => f.platform !== 'android'), shared.files.filter(f => f.platform !== 'android'), 'desktop files unchanged');
    assert.deepEqual(manifest.files.filter(f => f.platform === 'android'), [release('').entry]);
    assert.doesNotMatch(calls.flat().join(' '), /example\.com/, 'EA never touches another address\'s files');
  }

  const { result, uploads, read: uploaded, calls } = promote(wl, release(wl).tag);
  const name = 'latest-pulse.example.com.json';
  assert.deepEqual(uploads, [`uploaded-${name}`], 'another address writes only its own manifest');
  assert.equal(result.manifest, name);
  for (const args of calls.filter(a => a[2] === 'companion-test')) assert.equal(args[1], 'upload', 'EA latest.json and latest-desktop.json are never read');
  const own = uploaded(name);
  assert.ok(parseManifest(own, 'test'));
  assert.deepEqual(own.files, [release(wl).entry]);
  assert.deepEqual(own.platforms, {});
  assert.deepEqual([own.version, own.commit, own.runId, own.builtAt], ['1.1.4', sha, '456', '2026-10-20T05:00:00Z']);
  // The installed apps' own guard: this address's build accepts the promoted APK, EA's and another address's refuse it.
  const path = new URL(own.files[0].url).pathname;
  assert.ok(androidReleasePattern(wl).test(path));
  assert.ok(!androidReleasePattern(DEFAULT_ORIGIN).test(path));
  assert.ok(!androidReleasePattern(other).test(path));

  const refusals = [
    ['EA tag on another address', /built for https:\/\/pulse\.example\.com/, wl, release('').tag],
    ['another address on EA', /built for https:\/\/pulse\.estateautopilots\.com/, '', release(wl).tag],
    ['a third address', /built for https:\/\/another\.example\.com/, other, release(wl).tag],
    ['entry without its address', /built for another address/, wl, release(wl).tag, release(wl, { entry: { origin: undefined } })],
    ['EA entry naming an address', /built for another address/, '', release('').tag, release('', { entry: { origin: wl } })],
    ['entry for another address', /built for another address/, wl, release(wl).tag, release(wl, { entry: { origin: other } })],
    ['commit not matching the tag', /Missing release provenance/, wl, release(wl).tag, release(wl, { commit: 'e'.repeat(40) })],
    ['APK not matching its entry', /does not match its channel entry/, wl, release(wl).tag, release(wl, { apk: 'tampered' })],
    ['an invalid address', /origin must be/, 'http://pulse.example.com', release(wl).tag],
  ];
  // The script itself refuses (exit 1 with the reason), not this test's own upload check.
  for (const [label, reason, origin, chosen, replaced] of refusals) assert.throws(() => promote(origin, chosen, replaced), { status: 1, stderr: reason }, label);
});
