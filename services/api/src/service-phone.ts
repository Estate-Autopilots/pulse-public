import { createHmac } from 'node:crypto';
import { cleanPhone, managedKeys } from './acquisition-model.js';

/** 1.1 phone lookup: E.164 through the acquisition alias normaliser; a bare 10-digit number is read as +91. */
export function lookupPhone(raw: unknown): string | null {
  const phone = cleanPhone(raw), e164 = /^[0-9]{10}$/.test(phone) ? '+91' + phone : phone;
  return /^\+[1-9][0-9]{7,14}$/.test(e164) ? e164 : null;
}

/** The keyed aliases `protectContact` stores, for every configured key version and every lead source scope. */
export function phoneAliases(phone: string, scopes: { controller: string; path: string }[], env: NodeJS.ProcessEnv = process.env) {
  return managedKeys(env).flatMap(k => scopes.map(({ controller, path }) => ({ version: k.version, controller, path,
    key: createHmac('sha256', Buffer.from(k.key, 'hex')).update(controller + '|' + path + '|phone:' + phone).digest('hex') })));
}

// 30 lookups/minute per authenticated key id: entries exist only for keys that passed authentication.
const lookups = new Map<string, { start: number; count: number }>();
export function phoneBudgetSpent(keyId: string, now = Date.now()) {
  const entry = lookups.get(keyId);
  if (!entry || now - entry.start >= 60_000) { lookups.set(keyId, { start: now, count: 1 }); return false; }
  return ++entry.count > 30;
}
