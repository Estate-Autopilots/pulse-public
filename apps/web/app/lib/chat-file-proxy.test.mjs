// FEATURES-1024: what the web proxy lets a chat file be. A PDF or plain text the API marked inline opens in place (a PDF
// without the sandbox, so Chrome's viewer can draw it); raster images as before; anything else, and an e-mail
// attachment's PDF, stays a sandboxed download.
import assert from "node:assert/strict";
import test from "node:test";
import { createApiProxy, v0ProxyOptions } from "../api/proxy.mjs";

const context = (path) => ({ params: Promise.resolve({ path }) });
const upstream = (type, disposition) => async () => new Response("bytes", { status: 200, headers: { "content-type": type, "content-disposition": disposition } });
const get = (type, disposition, path = ["chats", "files", "f1a2b3c4"]) =>
  createApiProxy({ ...v0ProxyOptions, fetchImpl: upstream(type, disposition), hostLookup: async () => ({ signIn: "access" }) })(
    new Request(`http://web.test/api/v0/${path.join("/")}?inline=1`, { headers: { host: "web.test", "cf-access-authenticated-user-email": "synthetic@example.test" } }), context(path));
const seen = (r) => ({ type: r.headers.get("content-type"), disposition: r.headers.get("content-disposition"), csp: r.headers.get("content-security-policy") });

test("a chat PDF marked inline opens in place, without the sandbox", async () => {
  assert.deepEqual(seen(await get("application/pdf", "inline; filename*=UTF-8''b.pdf")), { type: "application/pdf", disposition: "inline; filename*=UTF-8''b.pdf", csp: null });
});
test("chat plain text opens in place, sandboxed; an image as before", async () => {
  assert.deepEqual(seen(await get("text/plain", "inline; filename*=UTF-8''n.txt")), { type: "text/plain", disposition: "inline; filename*=UTF-8''n.txt", csp: "sandbox" });
  assert.equal(seen(await get("image/png", "inline; filename*=UTF-8''p.png")).type, "image/png");
});
test("anything else, a PDF the API sent as a download, and an e-mail attachment's PDF stay sandboxed downloads", async () => {
  for (const [type, disposition, path] of [["application/zip", "inline; filename*=UTF-8''a.zip"], ["application/pdf", "attachment; filename*=UTF-8''b.pdf"],
    ["application/pdf", "inline; filename*=UTF-8''m.pdf", ["inbox", "attachment"]]]) {
    const r = seen(await get(type, disposition, path));
    assert.equal(r.type, "application/octet-stream", `${type} ${disposition}`); assert.ok(r.disposition.startsWith("attachment")); assert.equal(r.csp, "sandbox");
  }
});
