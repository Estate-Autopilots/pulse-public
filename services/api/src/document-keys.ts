// PRESENCE-2 (owner, 10 Oct 2026): government ID files and bank details are sealed here, in the API, by envelope
// encryption, so neither the key nor the plaintext ever reaches PostgreSQL (or its logs).
//  * Every file gets its own random 256-bit data key (AES-256-GCM). The data key is wrapped by a master key and only
//    the wrapped form is stored, beside the master key's ID. The plaintext data key exists only in this process.
//  * The master keys come from a root-installed keyring file (PULSE_DOCUMENT_KEY_FILE, default
//    /etc/pulse/document-master.key, mounted read-only): one "<key id> <32 random bytes in base64>" per line. The last
//    line seals new files; earlier lines keep older files readable (rotation). `rewrap` moves a file to the active key
//    without touching the file itself.
//  * The file's owner and purpose (organisation, person, document kind) are bound in as associated data, so a sealed
//    file copied onto another person's record does not open.
//  * No keyring, no new files: uploads are refused with a sentence HR can act on. There is no fallback key.
// Rotation and re-encryption: document-rekey.ts. Root steps: docs/ops/DOCUMENT-KEYS.md.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

export const DEFAULT_KEY_FILE = "/etc/pulse/document-master.key";
export const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const FORMAT = 1;
const IV = 12, TAG = 16;

export type Keyring = { active: string; keys: Map<string, Buffer> };
export type KeyringState = { ok: true; ring: Keyring } | { ok: false; reason: "missing" | "unreadable" | "exposed" | "invalid" };
/** What is stored: the master key's ID, the wrapped data key and the sealed bytes. */
export type Sealed = { keyId: string; dataKey: Buffer; data: Buffer };

/** A refusal people can read (the API passes the message on with 503). Never carries key material. */
export class DocumentKeyError extends Error {
  readonly statusCode = 503;
  readonly expose = true;
  constructor(message: string, readonly reason: string) { super(message); }
}

type Reason = Exclude<KeyringState, { ok: true }>["reason"];
/** READY (Datup, 21 Oct): AC's key file was installed but had no key ID, and HR read "isn’t installed". Each refusal now
 *  names what is wrong, so the administrator fixes the right thing. Never carries key material. */
export const KEY_PROBLEM: Record<Reason, { what: string; fix: string }> = {
  missing: { what: "the document encryption key isn’t installed on this Pulse server", fix: "install it" },
  unreadable: { what: "this Pulse server can’t read its document encryption key file", fix: "give the file to root with the Pulse group, mode 640" },
  exposed: { what: "this Pulse server’s document encryption key file is readable by everyone, so Pulse won’t use it", fix: "set the file to mode 640 (root with the Pulse group)" },
  invalid: { what: "this Pulse server’s document encryption key file is installed but not in the right format", fix: "write one “<key id> <base64 key>” per line (see docs/ops/DOCUMENT-KEYS.md)" },
};
const MISSING = {
  upload: (r: Reason) => `ID files can’t be uploaded yet: ${KEY_PROBLEM[r].what}. Nothing was saved. HR: ask the Pulse administrator to ${KEY_PROBLEM[r].fix}.`,
  bank: (r: Reason) => `Bank details can’t be saved yet: ${KEY_PROBLEM[r].what}. Nothing was saved. HR: ask the Pulse administrator to ${KEY_PROBLEM[r].fix}.`,
  open: (r: Reason) => `This file can’t be opened: ${KEY_PROBLEM[r].what}. HR: ask the Pulse administrator to ${KEY_PROBLEM[r].fix}.`,
  pay: (r: Reason) => `Pay can’t be saved or shown yet: ${KEY_PROBLEM[r].what}. Nothing was saved. HR: ask the Pulse administrator to ${KEY_PROBLEM[r].fix}.`,
  // CONNECT-AI: AI tokens, API keys and workspace keys are sealed with the same keyring.
  // MAILBOX: a company mailbox's Google sign-in (its refresh token) is sealed with the same keyring.
  mail: (r: Reason) => `The company mailbox can’t be connected or used yet: ${KEY_PROBLEM[r].what.replace("document encryption key", "encryption key")}. Nothing was saved. Ask the Pulse administrator to ${KEY_PROBLEM[r].fix}.`,
  ai: (r: Reason) => `AI connections can’t be saved or used yet: ${KEY_PROBLEM[r].what.replace("document encryption key", "encryption key")}. Nothing was saved. Ask the Pulse administrator to ${KEY_PROBLEM[r].fix}.`,
};

/** Parse a keyring. Any malformed line, short key or repeated ID rejects the whole file (never a partial keyring). */
export function parseKeyring(text: string): Keyring | null {
  const keys = new Map<string, Buffer>();
  let active = "";
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [id, encoded, ...rest] = line.split(/\s+/);
    if (rest.length || !KEY_ID.test(id) || !/^[A-Za-z0-9+/]{43}=$/.test(encoded ?? "") || keys.has(id)) return null;
    const key = Buffer.from(encoded, "base64");
    if (key.length !== 32) return null;
    keys.set(id, key);
    active = id;
  }
  return active ? { active, keys } : null;
}

/** Read the keyring on every use, so an added key applies without a restart. Refuses a world-accessible file. */
export async function loadKeyring(path = process.env.PULSE_DOCUMENT_KEY_FILE || DEFAULT_KEY_FILE): Promise<KeyringState> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return { ok: false, reason: "missing" };
    if (info.mode & 0o007) return { ok: false, reason: "exposed" };
    const ring = parseKeyring(await readFile(path, "utf8"));
    return ring ? { ok: true, ring } : { ok: false, reason: "invalid" };
  } catch (e) {
    return { ok: false, reason: (e as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable" };
  }
}

/** The keyring, or the refusal for what the person was doing. */
export async function requireKeyring(action: keyof typeof MISSING): Promise<Keyring> {
  const state = await loadKeyring();
  if (!state.ok) throw new DocumentKeyError(MISSING[action](state.reason), state.reason);
  return state.ring;
}

/** The context a sealed value is bound to: whose it is and what it is. */
export const documentContext = (org: string, person: string, kind: string) => `${org}/${person}/document/${kind}`;
export const bankContext = (org: string, person: string) => `${org}/${person}/bank`;
/** COMP-A: a pay value (a version's figures, an item, a claim, a receipt, a statement, a letter) of one person. */
export const payContext = (org: string, person: string, kind: string, id?: string) => `${org}/${person}/comp/${kind}${id ? `/${id}` : ""}`;
/** COMP-B: a company-level payroll value (a run's totals, its bank file, a ledger entry, a budget, a scenario). */
export const payrollContext = (org: string, kind: string, id: string) => `${org}/payroll/${kind}/${id}`;

function encrypt(key: Buffer, plain: Buffer, aad: string) {
  const iv = randomBytes(IV), cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([Buffer.of(FORMAT), iv, body, cipher.getAuthTag()]);
}
function decrypt(key: Buffer, sealed: Buffer, aad: string) {
  if (sealed.length < 1 + IV + TAG || sealed[0] !== FORMAT) throw new Error("unknown sealed format");
  const decipher = createDecipheriv("aes-256-gcm", key, sealed.subarray(1, 1 + IV));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG));
  return Buffer.concat([decipher.update(sealed.subarray(1 + IV, sealed.length - TAG)), decipher.final()]);
}
const wrapContext = (keyId: string, context: string) => `pulse.data-key.v1\n${keyId}\n${context}`;
const dataContext = (context: string) => `pulse.sealed.v1\n${context}`;

function unwrap(ring: Keyring, keyId: string, dataKey: Buffer, context: string) {
  const master = ring.keys.get(keyId);
  if (!master) throw new DocumentKeyError(`This file was sealed with document key “${keyId}”, which this Pulse server’s keyring no longer lists. HR: ask the Pulse administrator to restore that key.`, "unknown-key");
  try { return decrypt(master, dataKey, wrapContext(keyId, context)); }
  catch { throw new DocumentKeyError("This file can’t be opened: it does not match its encryption key. HR: ask the Pulse administrator.", "mismatch"); }
}

/** Seal with a fresh data key wrapped by the active master key. */
export function seal(ring: Keyring, plain: Buffer, context: string): Sealed {
  const key = randomBytes(32);
  try {
    return { keyId: ring.active, dataKey: encrypt(ring.keys.get(ring.active)!, key, wrapContext(ring.active, context)), data: encrypt(key, plain, dataContext(context)) };
  } finally { key.fill(0); }
}

export function open(ring: Keyring, sealed: Sealed, context: string): Buffer {
  const key = unwrap(ring, sealed.keyId, sealed.dataKey, context);
  try { return decrypt(key, sealed.data, dataContext(context)); }
  catch { throw new DocumentKeyError("This file can’t be opened: it does not match its encryption key. HR: ask the Pulse administrator.", "mismatch"); }
  finally { key.fill(0); }
}

/** Rotation: the same data key, wrapped again by the active master key. The sealed file itself does not change. */
export function rewrap(ring: Keyring, keyId: string, dataKey: Buffer, context: string): { keyId: string; dataKey: Buffer } {
  const key = unwrap(ring, keyId, dataKey, context);
  try { return { keyId: ring.active, dataKey: encrypt(ring.keys.get(ring.active)!, key, wrapContext(ring.active, context)) }; }
  finally { key.fill(0); }
}
