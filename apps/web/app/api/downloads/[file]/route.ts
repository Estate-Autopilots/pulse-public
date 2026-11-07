import {releaseURL} from '../../../../../../packages/companion/src/updates.js';
import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {api,type Me} from '../../../lib/api';
import {downloadsDir,readDownloads,FILE_NAME} from '../../../settings/downloads';
import {installOrigin} from '../../../lib/app-updates';
/** Signed-in staff download the published Pulse app builds listed in the manifest; nothing else on disk is reachable. */
export async function GET(req:Request,{params}:{params:Promise<{file:string}>}){
 const me=await api<Me>('me');if(!me.data||me.data.mustChange)return Response.json({error:'Sign in to Pulse'},{status:401});
 const {file}=await params;if(!FILE_NAME.test(file))return Response.json({error:'Download unavailable'},{status:404});
 try{const manifest=await readDownloads(installOrigin(req.headers));const entry=manifest?.files.find(x=>x.name===file);if(!entry)throw Error('missing');if(entry.url)return Response.redirect(releaseURL(entry.url),302);const path=join(downloadsDir(),file);const info=await stat(path);if(info.size!==entry.size)throw Error('size');
  return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream,{headers:{'content-type':'application/octet-stream','content-length':String(info.size),'content-disposition':`attachment; filename="${file}"`,'cache-control':'private, no-store','x-content-type-options':'nosniff','content-security-policy':'sandbox'}});
 }catch{return Response.json({error:'Download not published yet'},{status:404});}
}
