import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { PersonTokenVerifier } from './service-tasks-people.js';
import { readGooglePolicy } from './google-sign-in.js';

const ISSUER = 'https://accounts.google.com';
let keys: Promise<ReturnType<typeof createRemoteJWKSet>> | undefined;
// Fixed provider discovery, lazy and shared; failed discovery retries, jose caches/rotates the JWKS.
function googleKeys() {
  return keys ??= fetch(ISSUER + '/.well-known/openid-configuration', { signal: AbortSignal.timeout(5000), redirect: 'error' })
    .then(async response => {
      if (!response.ok) throw new Error('provider_unavailable');
      const metadata = await response.json() as { issuer?: string; jwks_uri?: string };
      const url = new URL(metadata.jwks_uri ?? '');
      if (metadata.issuer !== ISSUER || url.protocol !== 'https:') throw new Error('provider_invalid');
      return createRemoteJWKSet(url);
    }).catch(error => { keys = undefined; throw error; });
}
export const googlePersonToken: PersonTokenVerifier = async (token, c) => {
  const audience = (process.env.PULSE_SERVICE_PERSON_TOKEN_AUDIENCES ?? '').split(',').map(s => s.trim()).filter(Boolean);
  if (!audience.length) return null;
  try {
    const { payload: p } = await jwtVerify(token, await googleKeys(), { algorithms: ['RS256'], clockTolerance: 60,
      audience, issuer: [ISSUER, 'accounts.google.com'], requiredClaims: ['sub', 'iat', 'exp'] });
    if (!p.sub || !Number.isFinite(p.iat) || p.iat! > Date.now() / 1000 + 60 || p.iat! > p.exp! ||
        p.email_verified !== true || typeof p.hd !== 'string' || !(await readGooglePolicy(c)).allowedDomains.includes(p.hd)) return null;
    return { iss: ISSUER, sub: p.sub };
  } catch { return null; }
};
