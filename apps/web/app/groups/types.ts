import type { Member } from '../chats/types';
export type Person=Member & { accounts:string[]; roles:string[] };
export type Group={address:string;name:string;aliases:string[];sourceKind:string|null;sourceValue:string|null;observedAt:string;members:{email:string;role:string;type:string;person:string|null;status?:string}[];expected:Person[];missing:string[];extra:{email:string;role:string;type:string}[];withoutWorkspace:Person[];commands?:string[]};
export type GroupsData={groups:Group[];aliases:{address:string;primaryAddress:string;kind:string;editable:boolean}[];sync:{at:string;ok:boolean;error:string|null}|null;channels:{id:string;name:string;kind:string;address:string|null;members:number}[];people:Person[];canMap:boolean;canPlan:boolean;required:string[];planOnly:boolean};
