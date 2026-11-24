import { api } from '../../lib/api';
import { Message, Page, PageHeader } from '../../ui';
import { ImportApp, type ImportPage } from './import';
// R47: bring a past WhatsApp chat into a Pulse conversation. Admins only (the owner operates real imports); the export
// is read in this browser for the preview and is sent only when it is imported, which stays off until approved.
// CHAT-VOICE-FIX: opened from a chat's menu (⋯ → Import WhatsApp chat) it comes with that chat chosen (?channel=).
export default async function ChatImportPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
 const q = await searchParams;
 const r = await api<ImportPage>('chats/imports');
 if (r.error) return <Message text={r.status === 403 ? 'Only an admin imports WhatsApp history. The owner operates real imports.' : r.error} />;
 const d = r.data!;
 return <Page>
  <PageHeader title="Import WhatsApp history" back={{ href: '/chats', label: 'Chats' }}
   context={[d.enabled ? 'Imports are on' : 'Preview only: imports are off', `${d.batches.length} past import${d.batches.length === 1 ? '' : 's'}`]} />
  <ImportApp page={d} channel={q.channel ?? null} />
 </Page>;
}
