// CLI: /downloads/pulse-cli.tgz serves the built pulse command (packages/pulse-cli/dist/pulse-cli.tgz) as an npm
// package tarball, and answers 404 (not a broken build) when this build has no CLI.
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { GET } from "../downloads/pulse-cli.tgz/route.ts";

test("the CLI tarball is served when built, 404 otherwise", async () => {
  const built = existsSync(join(process.cwd(), "../../packages/pulse-cli/dist/pulse-cli.tgz"));
  const response = await GET();
  if (!built) { assert.equal(response.status, 404); return; }
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/gzip");
  assert.match(response.headers.get("content-disposition"), /filename="pulse-cli\.tgz"/);
  const tar = gunzipSync(Buffer.from(await response.arrayBuffer()));
  assert.equal(tar.subarray(0, 20).toString(), "package/package.json");
});
