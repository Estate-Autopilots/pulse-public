import { permanentRedirect } from 'next/navigation';
export default async function LegacyMoney({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}) {
 const query=new URLSearchParams();
 for(const [key,value] of Object.entries(await searchParams)) for(const item of Array.isArray(value)?value:value===undefined?[]:[value]) query.append(key,item);
 permanentRedirect(`/finance${query.size?'?'+query.toString():''}`);
}
