import {publishedUpdate,updateSurface,updateOrigin} from '../../../lib/app-updates';
export async function GET(request:Request,{params}:{params:Promise<{channel:string}>}){
 const {channel}=await params;
 if(!['test','stable'].includes(channel))return Response.json({error:'Unknown update channel'},{status:404});
 // Installed 1.0.0 desktop clients already use this URL and the updater's fixed User-Agent.
 // Phones receive the original manifest only when its Android releases match this install's build origin.
 const manifest=await publishedUpdate(channel,updateSurface(request),updateOrigin(request));
 return manifest?Response.json(manifest,{headers:{'cache-control':'public, max-age=60','vary':'User-Agent','x-content-type-options':'nosniff'}}):new Response(null,{status:204,headers:{'cache-control':'no-store','vary':'User-Agent'}});
}
