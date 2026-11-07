import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
// PULSE_DESKTOP_DIST builds elsewhere: the QA-E2E browser run builds into a temporary directory so a CI checkout keeps
// no build output (the release train's checkout retention refuses unknown files and kept every checkout since 12 Oct).
const out = resolve(process.env.PULSE_DESKTOP_DIST || resolve(root, 'dist'));
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await cp(resolve(root, 'src'), out, { recursive: true });
// The shared companion core (view model, reminders, Pip, panel) ships as plain modules next to the panel.
await cp(resolve(root, '../../packages/companion/src'), resolve(out, 'companion'), { recursive: true, filter: (f) => !f.endsWith('.d.ts') });
await cp(resolve(root, 'NOTICE.md'), resolve(out, 'staff-notice.md'));
