import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const dynamic = 'force-static';
export async function GET() {
  const source = await readFile(join(process.cwd(), '../../packages/pulse-cli/pulse.mjs'), 'utf8');
  return new Response(source, { headers: { 'content-type': 'text/javascript; charset=utf-8',
    'content-disposition': 'attachment; filename="pulse.mjs"' } });
}
