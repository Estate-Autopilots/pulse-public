// ACCOUNT-CODE (1465), moved here by SELF-SERVE (1521) so API v1 and the connector's OAuth routes can ask it without
// importing the account routes (an import cycle left API v1's helpers uninitialised in the unit tests).
import { requestCompany } from './tenant-context.js';

/** Whether this request came in on the shared address: an address no company claims (the install's own). A session
 *  carried there may have picked another organisation for the request; the address itself still decides. */
export function sharedAddress(): boolean {
  const r = requestCompany();
  if (!r?.company) return true;
  return !!r.installOrg && r.hostOrg === r.installOrg;
}
