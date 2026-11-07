export type Device = {id:string;name:string;platform:string;revokedAt:string|null;paused:boolean;health:string;appVersion:string;lastSeen:string|null;purposes:string[];capabilities?:Record<string,string>};
export type Evidence = {id:string;deviceId:string;kind:string;at:string;receivedAt:string;purpose:string;state:string;data:Record<string,unknown>;correction:string|null};
export type DevicesData = {devices:Device[];events:Evidence[];notices:{id:string;version:string;purpose:string;items:string[]}[];gatewayReady:boolean;queueDays:number};
