import { api, getMe } from '../lib/api';
import { roleLabelFor } from '../lib/nav';
import { Message, Page } from '../ui';
import { ChatsApp } from './app';
import { EmailApp } from './email';
import type { ChatData } from './types';
// CHATS-2: the page waits for one small read (the chat list, ~40 ms) and nothing else: Gmail loads in the browser, from
// its own cache first. A revisit draws from the local cache while this renders (loading.tsx), so it is never a skeleton.
export default async function ChatsPage({searchParams}:{searchParams:Promise<Record<string,string>>}) {
 const q=await searchParams;
 if(q.source==='email')return <Page fit><EmailApp initial={null}/></Page>;
 const [data,me]=await Promise.all([api<ChatData>('chats'),getMe()]);
 if(data.status===403||!data.data&&/individual employee account/i.test(data.error??''))return <Message text="Chats needs your individual employee account. Ask HR to link your People record."/>;
 return <Page fit><ChatsApp initial={data.data??null} initialError={data.error} role={me.data?roleLabelFor(me.data):undefined} modulesOff={me.data?.modules?.off}/></Page>;
}
