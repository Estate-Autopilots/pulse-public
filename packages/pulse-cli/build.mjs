import { mkdir, copyFile, chmod } from 'node:fs/promises';
const target = new URL('./dist/pulse.mjs', import.meta.url);
await mkdir(new URL('.', target), { recursive: true });
await copyFile(new URL('./pulse.mjs', import.meta.url), target);
await chmod(target, 0o755);
