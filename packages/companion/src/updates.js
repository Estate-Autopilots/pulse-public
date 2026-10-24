// One policy for the installed apps. Discovery never sends account or attendance data.
export const UPDATE_INTERVAL = 4 * 60 * 60 * 1000;
export const UPDATE_URL = 'https://pulse.estateautopilots.com/api/app-updates';
export function channel(value = 'test') {
  if (!['test', 'stable'].includes(value)) throw Error('Unknown update channel');
  return value;
}
export function newer(next, current) {
  const parse = v => { if (!/^\d+\.\d+\.\d+$/.test(v)) throw Error('Invalid update version'); return v.split('.').map(Number); };
  const a = parse(next), b = parse(current);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}
export function releaseURL(value) {
  const u = new URL(value);
  if (u.origin !== 'https://github.com' || !/^\/Estate-Autopilots\/pulse-companion\/releases\/download\/companion-v\d+\.\d+\.\d+-[a-f0-9]+\/[^/]+$/.test(u.pathname) || u.search || u.hash) throw Error('Untrusted update download');
  return u.href;
}
export function parseManifest(raw, expected = 'test') {
  channel(expected);
  if (!raw || raw.channel !== expected || !/^\d+\.\d+\.\d+$/.test(raw.version) || typeof raw.notes !== 'string' || !raw.notes.trim() || raw.notes.length > 2000 || !raw.platforms || !Array.isArray(raw.files)) throw Error('Invalid update manifest');
  for (const [target, p] of Object.entries(raw.platforms)) {
    if (!/^(darwin-(aarch64|x86_64)|windows-x86_64(-nsis|-msi)?)$/.test(target) || typeof p.signature !== 'string' || !p.signature || p.signature.length > 8192) throw Error('Invalid update target');
    releaseURL(p.url);
  }
  for (const f of raw.files) {
    if (!['windows', 'macos', 'android', 'chrome', 'ios'].includes(f.platform) || !/^[a-zA-Z0-9_.-]+$/.test(f.name) || !/^[a-f0-9]{64}$/.test(f.sha256) || !Number.isSafeInteger(f.size) || f.size < 1) throw Error('Invalid update file');
    releaseURL(f.url);
  }
  return raw;
}
export function canOfferUpdate({ signedIn, demo = false, busy = false, pending = false, payload, at = Date.now(), laterUntil = 0 }) {
  if (!signedIn || demo || busy || pending || payload?.pending || at < laterUntil || !payload) return false;
  const shift = Date.parse(payload.shiftStartsAt);
  const checked = Date.parse(payload.entry?.in);
  // Let people settle in, including a late check-in or an app opened just before the shift.
  if (Number.isFinite(shift) && at >= shift - 5 * 60000 && at < shift + 10 * 60000) return false;
  if (Number.isFinite(checked) && at >= checked && at < checked + 10 * 60000) return false;
  return true;
}
// Async work captures its generation. Logout/channel changes invalidate discovery/download completions.
export class UpdateController {
  constructor({ check, prepare = async () => {}, changed = () => {}, clock = Date.now }) {
    Object.assign(this, { check, prepare, changed, clock, generation: 0, running: false, candidate: null, status: '', laterUntil: 0, checkedAt: -Infinity });
  }
  reset() { this.generation++; this.candidate = null; this.status = ''; this.checkedAt = -Infinity; this.laterUntil = 0; this.changed(); }
  later() { this.laterUntil = this.clock() + UPDATE_INTERVAL; this.changed(); }
  async poll(context, force = false) {
    if (context.demo || this.running || (!force && this.clock() - this.checkedAt < UPDATE_INTERVAL)) return;
    const epoch = this.generation; this.running = true; this.status = 'Checking for updates…'; this.changed();
    try {
      const found = await this.check();
      if (epoch !== this.generation) return;
      this.checkedAt = this.clock();
      if (!context.signedIn) { this.candidate = null; this.status = found ? 'An update is available. Sign in to install it.' : 'Pulse is up to date'; return; }
      if (found) {
        this.status = 'Downloading the update…'; this.changed();
        await this.prepare(found);
        if (epoch !== this.generation) return;
        this.candidate = found; this.status = 'Update ready';
      } else { this.candidate = null; this.status = 'Pulse is up to date'; }
    } catch { if (epoch === this.generation) { this.status = 'Could not check or download. Try again when you’re online.'; this.checkedAt = this.clock(); } }
    finally { this.running = false; this.changed(); }
  }
  offer(context) { return this.candidate && canOfferUpdate({ ...context, at: this.clock(), laterUntil: this.laterUntil }) ? this.candidate : null; }
}
