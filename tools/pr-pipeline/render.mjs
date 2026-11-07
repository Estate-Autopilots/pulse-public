// PR-PIPELINE: render filled creative pages to PNG with headless Chromium and measure them (after PR-CREATIVES' render.mjs).
//   node tools/pr-pipeline/render.mjs <jobs.json> <results.json>
//   jobs: [{"id", "html": "/abs/page.html", "w", "h", "out": "/abs/out.png"}]
// The checks, per creative:
//   contrast    WCAG contrast of every text run against the colour behind it, at least PR_CONTRAST_MIN (4.5:1) for all text;
//   legible360  the smallest text, scaled to a 360px-wide phone, is at least 9px;
//   cropSafe    every text run sits inside a 4% safe margin, and no text overflows its box or the canvas.
// Spelling and privacy are checked on the copy by collect.py (checks.py). Nothing here reads the database.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { measure, summarise } from './checks.mjs';

const PW = process.env.PR_PIPELINE_PLAYWRIGHT || '/home/eadev/work/pulse/strike/tests/e2e/node_modules/@playwright/test/index.mjs';
const { chromium } = await import(pathToFileURL(PW).href);
const [jobsFile, outFile] = process.argv.slice(2);
if (!jobsFile || !outFile) { console.error('usage: render.mjs <jobs.json> <results.json>'); process.exit(2); }
const jobs = JSON.parse(fs.readFileSync(jobsFile, 'utf8'));
const min = Number(process.env.PR_CONTRAST_MIN || 4.5);
const browser = await chromium.launch({ args: ['--disable-dev-shm-usage', '--allow-file-access-from-files'] });
const results = {};
async function one(job) {
  const page = await browser.newPage({ viewport: { width: job.w, height: job.h }, deviceScaleFactor: 1 });
  try {
    await page.goto(pathToFileURL(job.html).href, { waitUntil: 'networkidle', timeout: 45000 });
    await page.evaluate(async () => { await document.fonts.ready; });
    await page.waitForFunction(() => document.body.dataset.fitted === '1', null, { timeout: 20000 }).catch(() => {});
    const m = await page.evaluate(measure, { W: job.w, H: job.h });
    fs.mkdirSync(path.dirname(job.out), { recursive: true });
    await page.screenshot({ path: job.out, clip: { x: 0, y: 0, width: job.w, height: job.h } });
    results[job.id] = { ok: true, checks: summarise(m, { W: job.w, H: job.h, min }) };
  } catch (e) {
    results[job.id] = { ok: false, error: String(e && e.message || e).slice(0, 300) };
  } finally { await page.close(); }
  console.log(job.id, results[job.id].ok ? 'rendered' : 'FAILED');
}
const queue = [...jobs];
await Promise.all([0, 1].map(async () => { while (queue.length) await one(queue.shift()); }));
await browser.close();
fs.writeFileSync(outFile, JSON.stringify(results));
