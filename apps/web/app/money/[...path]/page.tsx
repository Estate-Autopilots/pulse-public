import { permanentRedirect } from 'next/navigation';
export default async function LegacyFinancePath({params,searchParams}:{params:Promise<{path:string[]}>;searchParams:Promise<Record<string,string|string[]|undefined>>}) {
 const query=new URLSearchParams();for(const [key,value] of Object.entries(await searchParams))for(const item of Array.isArray(value)?value:value===undefined?[]:[value])query.append(key,item);
 const {path}=await params;if(!query.has('tab'))query.set('tab',path[0]==='plan'?'budget':path[0]);
 permanentRedirect(`/finance?${query}`);
}
