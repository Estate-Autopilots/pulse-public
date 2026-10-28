import { createECDH } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { platformConfig, platformMail } from './platform-config.js';

/** DE-EA: who push services contact about this install (VAPID "subject"): PULSE_VAPID_SUBJECT, else the install's web
 *  origin, else its support or sender mailbox. Never one company's literal. */
export function vapidSubject(env: NodeJS.ProcessEnv = process.env): string {
  const set = env.PULSE_VAPID_SUBJECT?.trim();
  if (set && /^(https:\/\/|mailto:)\S+$/.test(set)) return set;
  const m = platformMail(env);
  return m.origin?.startsWith('https://') ? m.origin : `mailto:${platformConfig(env).supportEmail ?? m.mailFrom ?? 'push@pulse.invalid'}`;
}

/** Advertise browser enrolment only when this process can also sign deliveries. Never expose the private key. */
export async function webPushConfig() {
  const publicKey = process.env.PULSE_WEB_PUSH_PUBLIC_KEY;
  const file = process.env.PULSE_WEB_PUSH_PRIVATE_KEY_FILE;
  if (!publicKey || !file) return null;
  try {
    const privateKey = (await readFile(file, 'utf8')).trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(privateKey) || !/^[A-Za-z0-9_-]{87}$/.test(publicKey)) return null;
    const signer = createECDH('prime256v1');
    signer.setPrivateKey(Buffer.from(privateKey, 'base64url'));
    if (signer.getPublicKey().toString('base64url') !== publicKey) return null;
    return { publicKey, privateKey };
  } catch { return null; }
}
