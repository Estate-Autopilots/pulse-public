import { api, getMe } from '../lib/api';
import { Message, Page } from '../ui';
import { OperatorApp } from './operator';
import type { ChatData } from '../chats/types';
// AGENT-OPERATOR (owner, 13 Nov 2026, OWNER-FEEDBACK-1113 P4.2): the operator view. The chat with an AI employee on the
// right; on the left the Pulse page it works in, live, with every step it takes and Stop. ?channel= picks the chat with
// that AI employee, ?path= the page it starts on (My desk by default). Staff seats with Chats only (a client seat or a
// company with Chats off has no AI conversation to watch).
export default async function OperatorPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const q = await searchParams;
  const [data, me] = await Promise.all([api<ChatData>('chats'), getMe()]);
  if (me.data?.side === 'client') return <Message text="Watching an AI employee work is for your team's own accounts." />;
  if (data.status === 403 || !data.data) return <Message text="This needs Chats. Ask an admin to turn Chats on, or to link your People record." />;
  const ai = data.data.channels.filter((c) => c.kind === 'direct' && c.peerAgent && !c.peerFormer);
  const path = typeof q.path === 'string' && /^\/(?!\/)[^\s]{0,400}$/.test(q.path) && !/^\/(api|operator)(\/|$)/.test(q.path) ? q.path : '/me';
  return <Page fit><OperatorApp chats={ai} viewer={data.data.viewer ?? ''} first={q.channel ?? null} start={path} /></Page>;
}
