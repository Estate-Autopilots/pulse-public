/** FIN-ENTRY → CHAT-SHELL seam: the finance slash commands for the Chats composer.
 *  `/expense ₹5,000 Facebook ads 14 Apr from HDFC` (also /income, /bill, /refund, /transfer).
 *  The composer calls `runFinanceCommand(line)`; with `save: false` (the default) nothing is saved and the result gives
 *  what Pulse understood plus `href`, the Finance form filled in (open it in the right panel). With `save: true` the
 *  entry is saved at once when the amount was understood (source "Chats"), and `href` opens that entry.
 *  Only leadership and the Finance role may use it: anyone else gets a 403 message to show inline. */
import type { Entry, Quick } from './entry-types';

export type SlashCommand = { command: string; label: string; hint: string; example: string };
export const FINANCE_SLASH_COMMANDS: SlashCommand[] = [
 { command: '/expense', label: 'Add an expense', hint: 'Amount, what for, date, paid from', example: '/expense ₹5,000 Facebook ads 14 Apr from HDFC' },
 { command: '/income', label: 'Payment received', hint: 'Amount, from whom, into which account', example: '/income 1.2 lakh from Acme into ICICI today' },
 { command: '/bill', label: 'Add a bill', hint: 'Amount, vendor, GST, due date', example: '/bill 18,000 + 18% GST rent due 5 Nov' },
 { command: '/refund', label: 'Add a refund', hint: 'Amount and from whom', example: '/refund 2,000 from Zoom' },
 { command: '/transfer', label: 'Move money between accounts', hint: 'Amount, from and into', example: '/transfer 50k from HDFC to ICICI' },
];
export const isFinanceCommand = (line: string) => FINANCE_SLASH_COMMANDS.some((c) => line.trim().toLowerCase().startsWith(c.command));

export async function runFinanceCommand(line: string, { save = false }: { save?: boolean } = {}): Promise<{ parsed: Quick; saved: Entry | null; href: string }> {
 const r = await fetch('/api/v0/finance/entries/quick', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: line, save, from: 'chat' }) });
 const data = await r.json().catch(() => ({}));
 if (!r.ok) throw new Error(data.error ?? 'Could not read that');
 if (save) window.dispatchEvent(new Event('pulse:data-changed'));
 return data;
}
