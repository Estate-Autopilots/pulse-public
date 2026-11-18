import { redirect } from 'next/navigation';
import { api, getMe } from '../../../lib/api';
import { Message, Page, PageHeader } from '../../../ui';
import { WaChat, type WaChatMeta } from '../wa';
// WA-IMPORT: one imported WhatsApp group, read-only (?m=<message> opens at that message). Members and admins only:
// anyone else gets "unavailable", as for a chat they are not in.
export default async function WhatsAppChatPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
 const [{ id }, q] = await Promise.all([params, searchParams]);
 const m = q.m && /^[0-9a-f-]{36}$/.test(q.m) ? q.m : undefined;
 // WA-NATIVE: the history is the Pulse chat's own now: an old link opens the chat (at its message); ?original=1 keeps
 // this read-only view of the export as it was loaded.
 if (q.original !== '1') {
  const n = await api<{ channelId: string; messageId: string | null }>(`chats/whatsapp/${id}/native${m ? `?m=${m}` : ''}`);
  if (n.data?.channelId) redirect(`/chats?channel=${n.data.channelId}${n.data.messageId ? `&message=${n.data.messageId}` : ''}`);
 }
 const [r, me] = await Promise.all([api<WaChatMeta>(`chats/whatsapp/${id}`), getMe()]);
 if (r.error) return <Message text={r.status === 404 ? 'This chat is not available to you.' : r.error} />;
 const chat = r.data!;
 return <Page fit>
  <PageHeader title={chat.title} back={{ href: `/chats?channel=${chat.channelId}`, label: 'Chat' }} recent={{ title: chat.title }}
   context={[chat.client, chat.project, `${chat.participants.length} people`].filter(Boolean) as string[]} />
  <WaChat chat={chat} viewer={me.data?.person ?? null} focus={m} />
 </Page>;
}
