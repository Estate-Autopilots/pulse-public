// Exit codes: 0 done, 1 Pulse or the network failed, 2 not signed in (or the sign-in ended), 3 Pulse refused it
// (role or scope), 4 the command was wrong (usage, validation, not found), 5 rate limited.
export const EXIT = { failed: 1, auth: 2, forbidden: 3, usage: 4, rateLimited: 5 } as const;

export class CliError extends Error {
  constructor(message: string, readonly exitCode: number = EXIT.usage, readonly hint?: string) { super(message); }
}
export const usage = (message: string, hint?: string): never => { throw new CliError(message, EXIT.usage, hint); };

const TOKEN = /\b(?:pat|prt|pcs|psvc|pak|pcat|poc)_[A-Za-z0-9_-]{8,}/g;
const secrets: string[] = [];
/** Remember a credential so no message or output ever prints it. */
export const secret = (value: string | undefined) => { if (value && value.length >= 8) secrets.push(value); };
/** Credentials (known ones and anything shaped like a Pulse token) become [redacted]; control characters go. */
export function redact(text: string): string {
  let out = String(text);
  for (const s of secrets) out = out.split(s).join('[redacted]');
  return out.replace(TOKEN, '[redacted]').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}
