// Account and Google policy requests keep transport/HTML failures in plain words.
export const RECONNECT='Pulse could not be reached. Check your connection and try again.';
export async function authResponse<T>(url:string,init?:RequestInit):Promise<{response:Response;data:T&{error?:string}}>{
 try{const response=await fetch(url,init),data=await response.json();return {response,data};}
 catch{throw new Error(RECONNECT);}
}
