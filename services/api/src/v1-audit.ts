import type { Pool } from 'pg';
import type { V1Call } from './v1.js';
// A separate autocommit query: rolled-back business work still has one attempt receipt. No actor label/content.
export async function auditV1(pool: Pick<Pool, 'query'>, call: V1Call) {
  await pool.query('select pulse.v1_call_audit($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [call.requestId, call.tenantId,
    call.principal?.tokenId ?? null, call.principal?.id ?? null, call.principal?.kind ?? null,
    call.operationId, call.routeTemplate, call.status, call.idempotencyKey, call.ms]);
}
