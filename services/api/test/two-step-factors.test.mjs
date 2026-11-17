// TWO-STEP-FACTORS (owner, 30 Oct 2026): a passkey made and used by a software authenticator (P-256, "none"
// attestation) passes Pulse's WebAuthn checks; another site, another key or a garbled answer does not.
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import test from "node:test";
import { answerChallenge, authenticationOptions, registrationOptions, verifyAssertion, verifyRegistration } from "../dist/webauthn.js";

const RP = "pulse.example.test", ORIGIN = `https://${RP}`, PERSON = "00000000-0000-4000-8000-0000000000aa";
const b64u = (b) => Buffer.from(b).toString("base64url");
const sha = (b) => createHash("sha256").update(b).digest();
function cbor(v) {
  const head = (major, n) => n < 24 ? Buffer.from([major << 5 | n]) : n < 256 ? Buffer.from([major << 5 | 24, n]) : Buffer.from([major << 5 | 25, n >> 8, n & 255]);
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") { const b = Buffer.from(v, "utf8"); return Buffer.concat([head(3, b.length), b]); }
  if (v instanceof Uint8Array) return Buffer.concat([head(2, v.length), Buffer.from(v)]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error("cbor: unsupported value");
}
function authenticator() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" }), id = randomBytes(16);
  const cose = cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, "base64url")], [-3, Buffer.from(jwk.y, "base64url")]]));
  return {
    id: b64u(id),
    create(challenge, origin = ORIGIN) {
      const len = Buffer.from([id.length >> 8, id.length & 255]);
      const authData = Buffer.concat([sha(RP), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), len, id, cose]);
      const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge, origin, crossOrigin: false }));
      return { id: b64u(id), rawId: b64u(id), type: "public-key", clientExtensionResults: {}, authenticatorAttachment: "platform",
        response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(cbor(new Map([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]))), transports: ["internal"] } };
    },
    get(challenge, counter, key = privateKey, origin = ORIGIN) {
      const authData = Buffer.concat([sha(RP), Buffer.from([0x05]), Buffer.from([counter >>> 24, (counter >> 16) & 255, (counter >> 8) & 255, counter & 255])]);
      const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin, crossOrigin: false }));
      const signature = sign("sha256", Buffer.concat([authData, sha(clientDataJSON)]), key);
      return { id: b64u(id), rawId: b64u(id), type: "public-key", clientExtensionResults: {},
        response: { authenticatorData: b64u(authData), clientDataJSON: b64u(clientDataJSON), signature: b64u(signature), userHandle: b64u(Buffer.from(PERSON.replace(/-/g, ""), "hex")) } };
    },
  };
}

test("a passkey is made, then signs in; its counter moves on", async () => {
  const device = authenticator(), bytes = randomBytes(32);
  const options = await registrationOptions({ rpID: RP, challenge: bytes, userId: PERSON, name: "synthetic.admin", display: "Synthetic Admin", exclude: [] });
  assert.equal(options.challenge, b64u(bytes));
  assert.equal(options.rp.id, RP);
  assert.equal(options.authenticatorSelection.userVerification, "preferred");
  const made = device.create(options.challenge);
  assert.equal(answerChallenge(made), options.challenge);
  const cred = await verifyRegistration({ response: made, challenge: options.challenge, origin: ORIGIN, rpID: RP });
  assert.ok(cred && cred.id === device.id && cred.publicKey.length > 40);
  const asked = await authenticationOptions({ rpID: RP, challenge: randomBytes(32), allow: [{ id: cred.id, transports: cred.transports }] });
  assert.deepEqual(asked.allowCredentials.map((c) => c.id), [cred.id]);
  const count = await verifyAssertion({ response: device.get(asked.challenge, 1), challenge: asked.challenge, origin: ORIGIN, rpID: RP, credential: { ...cred, counter: 0 } });
  assert.equal(count, 1);
});

test("another site, another key or a garbled answer is refused", async () => {
  const device = authenticator(), stranger = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
  const options = await registrationOptions({ rpID: RP, challenge: randomBytes(32), userId: PERSON, name: "a", display: "A", exclude: [] });
  assert.equal(await verifyRegistration({ response: device.create(options.challenge, "https://phish.example"), challenge: options.challenge, origin: ORIGIN, rpID: RP }), null);
  const cred = await verifyRegistration({ response: device.create(options.challenge), challenge: options.challenge, origin: ORIGIN, rpID: RP });
  const ch = b64u(randomBytes(32));
  assert.equal(await verifyAssertion({ response: device.get(ch, 1, stranger), challenge: ch, origin: ORIGIN, rpID: RP, credential: { ...cred, counter: 0 } }), null);
  assert.equal(await verifyAssertion({ response: device.get(ch, 1), challenge: b64u(randomBytes(32)), origin: ORIGIN, rpID: RP, credential: { ...cred, counter: 0 } }), null);
  assert.equal(answerChallenge({ response: { clientDataJSON: "not-json" } }), null);
  assert.equal(answerChallenge(null), null);
});
