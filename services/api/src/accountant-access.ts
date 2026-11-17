// CA-ACCESS (owner, 8 Nov 2026): what a CA / accountant's session may call. Finance read (the desk, its files and
// exports, ERP invoices, a quotation, the month's pay total), the CA's own writes on the desk (Verified / Ask, a
// comment, a month-close tick), their own account (sign-in, two-step, password, sign-out), switching between the
// companies they serve and accepting a new one's invitation, and their start-here guide. Nothing else: no HR, people,
// salaries, chats, tasks or settings. routes.ts refuses everything this does not name; the database decides the rest
// (finance_ca_valid: access unrevoked and unexpired, a live two-step session; salaries only with the owner's tick).
export type AccountantRoute = 'self' | 'read' | 'write' | null;

const SELF = new Set(['/api/v0/me', '/api/v0/auth/account', '/api/v0/auth/change-password', '/api/v0/auth/logout']);
/** The join page reads the signed-in account (to offer "Join as @handle") and what a link is for. */
const JOIN = new Set(['GET /api/v0/account', 'POST /api/v0/auth/join-peek']);
const ACCOUNT_WRITES = new Set(['/api/v0/account/switch', '/api/v0/account/accept', '/api/v0/account/tab-open']);
const DESK_WRITES = new Set(['/api/v0/finance/desk/check', '/api/v0/finance/desk/note', '/api/v0/finance/desk/close']);

export function accountantRoute(method: string, url: string): AccountantRoute {
  const path = url.split('?')[0];
  const m = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase();
  if (SELF.has(path) || JOIN.has(`${m} ${path}`)) return 'self';
  if (path === '/api/v0/account/onboarding' && (m === 'GET' || m === 'POST')) return 'self';
  if (m === 'POST' && ACCOUNT_WRITES.has(path)) return 'self';
  if (m === 'GET' && (path === '/api/v0/finance/desk' || /^\/api\/v0\/finance\/desk\/(files|exports)\/[^/]+$/.test(path)
    || /^\/api\/v0\/erp(\/|$)/.test(path) || /^\/api\/v0\/quotes\/[0-9a-f-]{36}$/i.test(path) || path === '/api/v0/comp/totals')) return 'read';
  if (m === 'POST' && DESK_WRITES.has(path)) return 'write';
  return null;
}
