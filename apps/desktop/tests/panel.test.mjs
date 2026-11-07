import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import test from 'node:test';

const read = (p) => readFile(new URL(p, import.meta.url), 'utf8');

test('the panel page loads only local modules and styles (CSP: no inline script or style)', async () => {
  const html = await read('../src/index.html');
  assert.match(html, /<script type="module" src="panel.js"><\/script>/);
  assert.doesNotMatch(html, /<script>(?!<\/script>)|style="/);
  for (const css of ['companion/pip.css', 'companion/panel.css', 'panel-window.css']) assert.match(html, new RegExp(`href="${css}"`));
  const js = await read('../src/panel.js');
  for (const m of js.matchAll(/from '\.\/companion\/([a-z]+)\.js'/g)) await stat(new URL(`../../../packages/companion/src/${m[1]}.js`, import.meta.url));
  assert.doesNotMatch(js, /innerHTML\s*=\s*[^;]*(state|session|payload|message)/, 'no server text through innerHTML');
});

test('the shell opens no window until it decides; versions agree; tray icons exist', async () => {
  const conf = JSON.parse(await read('../src-tauri/tauri.conf.json'));
  const pkg = JSON.parse(await read('../package.json'));
  const cargo = await read('../src-tauri/Cargo.toml');
  assert.deepEqual(conf.app.windows, []);
  assert.equal(conf.version, pkg.version);
  assert.match(cargo, new RegExp(`^version = "${pkg.version}"`, 'm'));
  assert.match(conf.app.security.csp, /script-src 'self'/);
  for (const f of ['tray.png', 'tray-in.png', 'tray-break.png', 'tray-alert.png', 'tray-template.png', 'icon.ico', 'icon.icns', '32x32.png', '128x128.png']) {
    assert.ok((await stat(new URL(`../src-tauri/icons/${f}`, import.meta.url))).size > 200, f);
  }
});

test('every command the panel calls is registered in the shell', async () => {
  const js = await read('../src/panel.js');
  const rust = await read('../src-tauri/src/lib.rs');
  const handler = rust.slice(rust.indexOf('generate_handler!['));
  for (const [, cmd] of js.matchAll(/invoke\('([a-z_]+)'/g)) assert.match(handler, new RegExp(`\\b${cmd}\\b`), cmd);
});

test('Settings and the Pulse window screens call only registered commands and load only local modules', async () => {
  const rust = await read('../src-tauri/src/lib.rs');
  const handler = rust.slice(rust.indexOf('generate_handler!['));
  for (const [page, script] of [['settings.html', 'settings.js'], ['app.html', 'app.js']]) {
    const html = await read(`../src/${page}`);
    assert.match(html, new RegExp(`<script type="module" src="${script}"></script>`));
    assert.doesNotMatch(html, /<script>(?!<\/script>)|style="/);
    const js = await read(`../src/${script}`);
    for (const [, cmd] of js.matchAll(/invoke\('([a-z_]+)'/g)) assert.match(handler, new RegExp(`\\b${cmd}\\b`), `${script}: ${cmd}`);
    for (const m of js.matchAll(/from '\.\/companion\/([a-z-]+)\.js'/g)) await stat(new URL(`../../../packages/companion/src/${m[1]}.js`, import.meta.url));
    assert.doesNotMatch(js, /innerHTML\s*=\s*[^;]*(state|session|payload|message|notice)/, `${script}: no server text through innerHTML`);
  }
});

test('the old Settings & privacy window is gone and remote Pulse pages get no native commands', async () => {
  const rust = await read('../src-tauri/src/lib.rs');
  assert.doesNotMatch(rust, /privacy\.html/);
  await assert.rejects(stat(new URL('../src/privacy.html', import.meta.url)));
  const capability = JSON.parse(await read('../src-tauri/capabilities/local.json'));
  assert.equal(capability.remote, undefined, 'no capability may name a remote origin');
  assert.deepEqual(capability.permissions, ['core:event:default']);
});

test('optional activity metadata stays off: the shell starts the tracker paused', async () => {
  const rust = await read('../src-tauri/src/lib.rs');
  assert.match(rust, /if tracker\.status\(&core\)\.paused \{ core\.set_pause\("until-resumed"\)/);
});
