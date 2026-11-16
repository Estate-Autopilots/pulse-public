// PULSE-ID: the keys behind "Sign in with Pulse" (docs/architecture/PULSE_IDENTITY_AND_DATA_API.md §6).
//  * PULSE_OIDC_SIGNING_KEY_FILE names a PEM file in the server's secret store (never in git) holding one or more RSA
//    private keys (PKCS#8 or PKCS#1). The first signs ID tokens (RS256); all are published in the JWKS, so a key that is
//    being retired keeps verifying the tokens it signed. kid = the key's RFC 7638 thumbprint.
//  * A file everyone on the machine can read is refused, as the document keyring is (mode 640, root with the Pulse
//    group, is fine), and so is a key under 2048 bits.
//  * PULSE_OIDC_SIGNING_KEY (that file, base64) is for an install whose deployer passes secrets only through its
//    root-only env file (Pulse production today); the file wins when both are set.
//  * Picture addresses are signed with an HMAC key derived from each signing key: a member's photo is served without a
//    token to the app it was given to, for as long as that app stays connected (the database decides that part).
import { createHash, createHmac, createPrivateKey, createPublicKey, sign, timingSafeEqual, type KeyObject } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';

export type SigningKey = { kid: string; key: KeyObject; jwk: { kty: 'RSA'; n: string; e: string; kid: string; alg: 'RS256'; use: 'sig' }; mac: Buffer };
export type KeySet = { ok: true; keys: SigningKey[] } | { ok: false; reason: 'missing' | 'unreadable' | 'exposed' | 'invalid' };

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** Every PEM private key block in a file, in order. */
export function parseSigningKeys(text: string): SigningKey[] | null {
  const blocks = text.match(/-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA )?PRIVATE KEY-----/g) ?? [];
  if (!blocks.length) return null;
  const keys: SigningKey[] = [];
  for (const pem of blocks) {
    let key: KeyObject;
    try { key = createPrivateKey(pem); } catch { return null; }
    if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) return null;
    const pub = createPublicKey(key).export({ format: 'jwk' }) as { n: string; e: string };
    // RFC 7638: the required members in lexicographic order, no spaces.
    const kid = b64url(createHash('sha256').update(JSON.stringify({ e: pub.e, kty: 'RSA', n: pub.n })).digest());
    const mac = createHash('sha256').update('pulse-oidc-picture/v1\0').update(key.export({ format: 'der', type: 'pkcs8' })).digest();
    keys.push({ kid, key, jwk: { kty: 'RSA', n: pub.n, e: pub.e, kid, alg: 'RS256', use: 'sig' }, mac });
  }
  return keys;
}

let cache: { path: string; inline: string; at: number; set: KeySet } | null = null;
/** The configured keys, read again at most once a minute (a new key file takes effect without a restart). */
export async function signingKeys(path = process.env.PULSE_OIDC_SIGNING_KEY_FILE ?? '', inline = process.env.PULSE_OIDC_SIGNING_KEY ?? ''): Promise<KeySet> {
  if (cache && cache.path === path && cache.inline === inline && Date.now() - cache.at < 60_000) return cache.set;
  let set: KeySet;
  if (!path && inline.trim()) { const keys = parseSigningKeys(Buffer.from(inline.trim(), 'base64').toString('utf8')); set = keys ? { ok: true, keys } : { ok: false, reason: 'invalid' }; }
  else if (!path) set = { ok: false, reason: 'missing' };
  else {
    try {
      const info = await stat(path);
      if (info.mode & 0o007) set = { ok: false, reason: 'exposed' };
      else { const keys = parseSigningKeys(await readFile(path, 'utf8')); set = keys ? { ok: true, keys } : { ok: false, reason: 'invalid' }; }
    } catch (e) { set = { ok: false, reason: (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable' }; }
  }
  cache = { path, inline, at: Date.now(), set };
  return set;
}
export const forgetSigningKeys = () => { cache = null; };

/** A compact RS256 JWT signed with the first key. */
export function signJwt(key: SigningKey, payload: Record<string, unknown>): string {
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: key.kid }));
  const body = b64url(JSON.stringify(payload));
  return `${head}.${body}.${b64url(sign('sha256', Buffer.from(`${head}.${body}`), key.key))}`;
}

/** OIDC Core §3.3.2.11 at_hash / c_hash: the left half of the SHA-256 of the token, base64url. */
export const halfHash = (token: string) => b64url(createHash('sha256').update(token).digest().subarray(0, 16));

const pictureInput = (app: string, org: string, member: string, version: string) => `${app}\0${org}\0${member}\0${version}`;
export function pictureSignature(key: SigningKey, app: string, org: string, member: string, version: string) {
  return b64url(createHmac('sha256', key.mac).update(pictureInput(app, org, member, version)).digest().subarray(0, 24));
}
/** Any configured key made this signature (so a key rotation keeps the addresses it signed working while it is listed). */
export function pictureSignatureOk(keys: SigningKey[], app: string, org: string, member: string, version: string, signature: string) {
  const given = Buffer.from(signature);
  return keys.some((k) => { const want = Buffer.from(pictureSignature(k, app, org, member, version)); return want.length === given.length && timingSafeEqual(want, given); });
}
/** The address an app reads a member's photo from, without a token. */
export function pictureUrl(issuer: string, key: SigningKey, app: string, org: string, member: string, version: number | string) {
  const v = String(version), url = new URL(`/api/v1/connect/photos/${member}`, issuer);
  url.search = new URLSearchParams({ o: org, v, a: app, s: pictureSignature(key, app, org, member, v) }).toString();
  return url.href;
}
