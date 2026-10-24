import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail } from './routes.js';
import { hostCompany } from './tenant-context.js';

const defaultProductionHost = 'pulse.estateautopilots.com';
const defaultStagingAllow = ['hr@estateautopilots.com', 'admin@estateautopilots.com'];
const mailTransport = () => process.env.PULSE_MAIL_TRANSPORT?.trim().toLowerCase() || 'google';
const bridgeScript = resolve(dirname(fileURLToPath(import.meta.url)), '../../../tools/google-bridge.py');

function mailRecipientAllowed(to: unknown) {
  const recipient = String(to ?? '').trim().toLowerCase();
  let host = '';
  try { host = new URL(process.env.PULSE_PUBLIC_URL ?? 'https://invalid.local').hostname.toLowerCase(); } catch { /* no host */ }
  const productionHost = (process.env.PULSE_MAIL_PRODUCTION_HOST?.trim() || defaultProductionHost).toLowerCase();
  const allow = (process.env.PULSE_MAIL_STAGING_ALLOW ?? defaultStagingAllow.join(','))
    .split(',').map((address) => address.trim().toLowerCase()).filter(Boolean);
  return host === productionHost || allow.includes(recipient);
}

export async function googleBridge(action: string, args: Record<string, unknown>) {
  // UX-TENANT: the install mailbox and SMTP account are scoped to the install company.
  if (hostCompany()) {
    fail(403, 'This company has not connected its own Google account to Pulse');
  }
  if(action==='send') {
    if(process.env.PULSE_CI==='1'||process.env.NODE_ENV==='test'||process.env.PULSE_AUTH_MAIL_MODE==='sink')return {id:'test-sink',sent:true};
    if (!mailRecipientAllowed(args.to)) fail(403, 'This host may send mail only to the configured staging allow-list');
  }
  try {
    const stdout = await new Promise<string>((done, reject) => {
      const python = process.env.PULSE_GOOGLE_PYTHON ?? (action === 'send' && mailTransport() === 'smtp' ? 'python3' : '/home/eadev/ea-intel/venv/bin/python');
      const child = execFile(python, [bridgeScript, action],
        { timeout: 40000, maxBuffer: 32 * 1024 * 1024, env: process.env }, (error, out) => error ? reject(new Error('Google unavailable')) : done(out));
      child.stdin?.end(JSON.stringify(args));
    });
    const data = JSON.parse(stdout);
    if (data.error) fail(503, 'Mail is not available for this account');
    return data;
  } catch { fail(503, 'Mail is not available for this account. Check the configured transport and account connection.'); }
}
