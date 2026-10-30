import { readFile } from "node:fs/promises";
import { join } from "node:path";

// CLI: the pulse command as an npm-style tarball (packages/pulse-cli, built before the web app), so
// `npm install -g https://<pulse>/downloads/pulse-cli.tgz` or `npx <that address>` installs it. Read once at build
// time; a build without the CLI answers 404 rather than failing the whole web build.
export const dynamic = "force-static";
export async function GET() {
  try {
    const tarball = await readFile(join(process.cwd(), "../../packages/pulse-cli/dist/pulse-cli.tgz"));
    return new Response(new Uint8Array(tarball), { headers: { "content-type": "application/gzip", "content-disposition": 'attachment; filename="pulse-cli.tgz"',
      "cache-control": "public, max-age=300", "x-content-type-options": "nosniff" } });
  } catch {
    return new Response("The pulse CLI is not part of this build.\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  }
}
