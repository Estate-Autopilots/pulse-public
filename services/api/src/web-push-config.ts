import { createECDH } from 'node:crypto';
import { readFile } from 'node:fs/promises';

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
