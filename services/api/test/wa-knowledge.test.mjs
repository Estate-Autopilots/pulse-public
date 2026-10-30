// WA-DATASETS (1099): a query is embedded by the server's local model when PULSE_EMBED_URL is set; without it, or when
// the model answers badly or slowly, the search ranks by words alone (null). Synthetic vectors only.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { embedQuery } from "../dist/wa-knowledge.js";

function embedder(answer, delayMs = 0) {
  return new Promise((resolve) => {
    const seen = [];
    const server = createServer((req, res) => {
      let body = ""; req.on("data", (d) => { body += d; });
      req.on("end", () => {
        seen.push({ path: req.url, body: JSON.parse(body || "{}") });
        setTimeout(() => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(answer)); }, delayMs);
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${server.address().port}`, seen, close: () => server.close() }));
  });
}

test("without an embedder the search ranks by words alone", async () => {
  delete process.env.PULSE_EMBED_URL;
  assert.equal(await embedQuery("2 BHK price"), null);
});

test("a 768-number answer becomes pgvector text; the query is sent once, as a query", async () => {
  const e = await embedder({ vectors: [Array.from({ length: 768 }, (_, i) => (i === 3 ? 1 : 0))] });
  process.env.PULSE_EMBED_URL = e.url;
  try {
    const v = await embedQuery("  synthetic   brochure question ");
    assert.ok(v.startsWith("[") && v.endsWith("]"));
    assert.equal(v.slice(1, -1).split(",").length, 768);
    assert.equal(v.slice(1, -1).split(",")[3], "1");
    assert.deepEqual(e.seen, [{ path: "/embed", body: { texts: ["synthetic brochure question"], kind: "query" } }]);
    assert.equal(await embedQuery("x"), null, "a single letter is not embedded");
  } finally { e.close(); delete process.env.PULSE_EMBED_URL; }
});

test("a wrong-sized vector or a slow embedder gives null, never an error", async () => {
  const bad = await embedder({ vectors: [[0.1, 0.2]] });
  process.env.PULSE_EMBED_URL = bad.url;
  try { assert.equal(await embedQuery("synthetic"), null); } finally { bad.close(); }
  const slow = await embedder({ vectors: [Array(768).fill(0.01)] }, 500);
  process.env.PULSE_EMBED_URL = slow.url;
  try { assert.equal(await embedQuery("synthetic", 50), null); } finally { slow.close(); delete process.env.PULSE_EMBED_URL; }
});
