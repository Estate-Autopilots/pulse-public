import type { CompanionPayload } from './index.js';
export const UPDATE_INTERVAL: number;
export const UPDATE_URL: string;
export type UpdateFile = { name: string; platform: string; kind: string; url: string; size: number; sha256: string };
export type UpdateManifest = { channel: 'test'|'stable'; version: string; notes: string; platforms: Record<string, {url:string;signature:string}>; files: UpdateFile[] };
export function channel(value?:string): 'test'|'stable';
export function newer(next:string,current:string):boolean;
export function releaseURL(value:string):string;
export function parseManifest(raw:unknown,expected?:string):UpdateManifest;
export type UpdateContext = {signedIn:boolean;demo?:boolean;busy?:boolean;pending?:boolean;payload?:CompanionPayload|null;at?:number;laterUntil?:number};
export function canOfferUpdate(context:UpdateContext):boolean;
export class UpdateController {
 constructor(options:{check:()=>Promise<any>;prepare?:(found:any)=>Promise<void>;changed?:()=>void;clock?:()=>number});
 candidate:any;status:string;running:boolean;laterUntil:number;
 reset():void;later():void;poll(context:UpdateContext,force?:boolean):Promise<void>;offer(context:UpdateContext):any;
}
