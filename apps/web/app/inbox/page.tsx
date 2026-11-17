import { redirect } from 'next/navigation';
export default async function Inbox({searchParams}:{searchParams:Promise<Record<string,string>>}) { const q=await searchParams;redirect(`/chats?${new URLSearchParams({...q,source:'email'})}`); }
