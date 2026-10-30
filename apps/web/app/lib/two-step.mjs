// TWO-STEP-GUIDE (owner, 30 Oct 2026): small pure helpers for the guided two-step window (two-step-guide.tsx).

/** The setup key in groups of four, the way authenticator apps show a key typed by hand. */
export const groupKey = (key) => String(key ?? '').replace(/\s+/g, '').replace(/(.{4})/g, '$1 ').trim();

/** The six digits of a code as typed or pasted ("123 456", "123-456"); empty until there are exactly six. */
export function otpDigits(text) {
  const digits = String(text ?? '').replace(/\D/g, '');
  return digits.length === 6 ? digits : '';
}

/** The backup codes as a small text file: whose they are, how they work, one code per line. */
export function backupText(codes, org, when = new Date()) {
  return [`Pulse backup codes for ${org}`, `Made ${when.toISOString().slice(0, 10)}. Each code works once, in place of the 6-digit code.`, '',
    ...codes, ''].join('\n');
}

/** TWO-STEP-FACTORS: a passkey's name from the device it was made on, so the Account page can tell them apart. */
export function passkeyName(ua) {
  const s = String(ua ?? '');
  return /iPhone/.test(s) ? 'iPhone' : /iPad/.test(s) ? 'iPad' : /Android/.test(s) ? 'Android phone' : /CrOS/.test(s) ? 'Chromebook'
    : /Windows/.test(s) ? 'Windows computer' : /Mac OS X|Macintosh/.test(s) ? 'Mac' : /Linux/.test(s) ? 'Linux computer' : 'Passkey';
}
