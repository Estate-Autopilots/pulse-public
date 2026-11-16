// TG-VOICE: Meta's WhatsApp webhook reaches the API signed out, with only its body and signature; nothing of a person
// (cookie, session, Access identity) is forwarded, and neighbouring paths still need a sign-in. Synthetic values only.
import assert from "node:assert/strict";
import test from "node:test";
import { createApiProxy, v0ProxyOptions } from "../api/proxy.mjs";

const context = (path) => ({ params: Promise.resolve({ path }) });
const capture = () => { const seen = []; return { seen, fetchImpl: async (url, init) => { seen.push({ url, init }); return new Response("12345", { status: 200, headers: { "content-type": "text/plain" } }); } }; };
const proxyWith = (fetchImpl) => createApiProxy({ ...v0ProxyOptions, fetchImpl, hostLookup: async () => ({ signIn: "password" }) });
const HOOK = ["channels", "whatsapp", "hook"];

test("Meta's verification handshake reaches the API signed out", async () => {
  const { seen, fetchImpl } = capture();
  const r = await proxyWith(fetchImpl)(new Request("http://web.test/api/v0/channels/whatsapp/hook?hub.mode=subscribe&hub.verify_token=synthetic-verify&hub.challenge=12345"), context(HOOK));
  assert.equal(r.status, 200);
  assert.equal(await r.text(), "12345");
  assert.match(seen[0].url, /\/api\/v0\/channels\/whatsapp\/hook\?hub\.mode=subscribe&hub\.verify_token=synthetic-verify&hub\.challenge=12345$/);
});

test("a delivery goes with its exact body and signature, and nothing of a person", async () => {
  const { seen, fetchImpl } = capture();
  const body = '{"object":"whatsapp_business_account","entry":[]}';
  const r = await proxyWith(fetchImpl)(new Request("http://web.test/api/v0/channels/whatsapp/hook", { method: "POST", body,
    headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=" + "a".repeat(64), cookie: "pulse_session=synthetic", "x-pulse-session": "synthetic" } }), context(HOOK));
  assert.equal(r.status, 200);
  const sent = seen[0].init;
  assert.equal(Buffer.from(sent.body).toString("utf8"), body);
  assert.equal(sent.headers["x-hub-signature-256"], "sha256=" + "a".repeat(64));
  assert.equal(sent.headers.cookie, undefined);
  assert.equal(sent.headers["x-pulse-session"], undefined);
});

test("only GET and POST, and the paths beside it still need a sign-in", async () => {
  const { seen, fetchImpl } = capture();
  const put = await proxyWith(fetchImpl)(new Request("http://web.test/api/v0/channels/whatsapp/hook", { method: "PUT", body: "{}" }), context(HOOK));
  assert.equal(put.status, 405);
  const other = await proxyWith(fetchImpl)(new Request("http://web.test/api/v0/channels/whatsapp/other"), context(["channels", "whatsapp", "other"]));
  assert.equal(other.status, 401);
  const link = await proxyWith(fetchImpl)(new Request("http://web.test/api/v0/whatsapp/link"), context(["whatsapp", "link"]));
  assert.equal(link.status, 401);
  assert.equal(seen.length, 0);
});

test("Company channels saves with PUT from the same origin only; other PUTs stay refused", async () => {
  const { seen, fetchImpl } = capture();
  const proxy = createApiProxy({ ...v0ProxyOptions, fetchImpl, hostLookup: async () => ({ signIn: "password" }) });
  const put = (path, origin) => proxy(new Request(`http://web.test/api/v0/${path.join("/")}`, { method: "PUT", body: "{}",
    headers: { "content-type": "application/json", cookie: "pulse_session=synthetic-session", ...(origin ? { origin } : {}) } }), context(path));
  assert.equal((await put(["agent-channels"], "https://evil.test")).status, 403);
  assert.equal((await put(["agent-channels"])).status, 403);
  assert.equal((await put(["tasks"], "http://web.test")).status, 405);
  assert.equal(seen.length, 0);
});
