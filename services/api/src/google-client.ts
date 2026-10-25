import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { requestCompany } from './tenant-context.js';

// Same company-folder boundary as pulse_sdk.connector.company_secret; never borrow the install's credential.
export function hostedGoogleCompany() {
 const r = requestCompany();
 return r?.company && r.company.org !== r.installOrg ? r.company.org : null;
}
function hostedClient(company: string) {
 const base = process.env.PULSE_CONNECTOR_SECRETS_DIR;
 if (!base || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(company)) return null;
 let fd: number | undefined;
 try {
  const folder = join(base, company), dir = lstatSync(folder);
  if (lstatSync(base).isSymbolicLink() || !dir.isDirectory() || (dir.mode & 0o7777) !== 0o700) return null;
  fd = openSync(join(folder, 'google-sign-in.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const file = fstatSync(fd);
  if (!file.isFile() || (file.mode & 0o7777) !== 0o600 || file.nlink !== 1 || file.size > 16_384) return null;
  const value = JSON.parse(readFileSync(fd, 'utf8'));
  if (!value || Array.isArray(value) || Object.keys(value).sort().join() !== 'client_id,client_secret' ||
      ![value.client_id, value.client_secret].every(v => typeof v === 'string' && v.trim().length > 0)) return null;
  return { company, clientId: value.client_id as string, clientSecret: value.client_secret as string };
 } catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
}
export function googleConfigured() {
 const company = hostedGoogleCompany();
 return company ? hostedClient(company) !== null : !!(process.env.PULSE_GOOGLE_CLIENT_ID && process.env.PULSE_GOOGLE_CLIENT_SECRET_FILE);
}
export function googleClient() {
 const company = hostedGoogleCompany();
 if (company) return hostedClient(company);
 return googleConfigured() ? { company: 'install', clientId: process.env.PULSE_GOOGLE_CLIENT_ID!,
  clientSecret: readFileSync(process.env.PULSE_GOOGLE_CLIENT_SECRET_FILE!, 'utf8').trim() } : null;
}
