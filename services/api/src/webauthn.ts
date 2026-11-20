// TWO-STEP-FACTORS (owner, 30 Oct 2026: "add a passkey adder ... getting in should be easy"): passkeys (WebAuthn) as the
// second step. @simplewebauthn/server does the checks; this keeps Pulse's choices in one place: no attestation, the
// device's fingerprint, face or screen lock when it has one, two minutes to answer, and only the public key is kept.
import {generateAuthenticationOptions,generateRegistrationOptions,verifyAuthenticationResponse,verifyRegistrationResponse} from '@simplewebauthn/server';
import type {AuthenticationResponseJSON,AuthenticatorTransportFuture,RegistrationResponseJSON} from '@simplewebauthn/server';

export type KnownPasskey={id:string;transports?:string[]};
const transports=(t?:string[])=>(Array.isArray(t)?t:[]) as AuthenticatorTransportFuture[];

/** The challenge a WebAuthn answer was made for (base64url), read from its client data; null when unreadable. */
export function answerChallenge(response:unknown):string|null{
 try{
  const raw=(response as {response?:{clientDataJSON?:unknown}}|null)?.response?.clientDataJSON;if(typeof raw!=='string')return null;
  const c=JSON.parse(Buffer.from(raw,'base64url').toString('utf8')) as {challenge?:unknown};
  return typeof c.challenge==='string'&&/^[A-Za-z0-9_-]{16,128}$/.test(c.challenge)?c.challenge:null;
 }catch{return null;}
}

/** The browser's "create a passkey" request for one person (their Pulse id is the WebAuthn user handle). */
export function registrationOptions(o:{rpID:string;challenge:Uint8Array;userId:string;name:string;display:string;exclude:KnownPasskey[]}){
 return generateRegistrationOptions({rpName:'Pulse',rpID:o.rpID,userName:o.name,userDisplayName:o.display,
  userID:new Uint8Array(Buffer.from(o.userId.replace(/-/g,''),'hex')),challenge:new Uint8Array(o.challenge),attestationType:'none',timeout:120000,
  excludeCredentials:o.exclude.map(c=>({id:c.id,transports:transports(c.transports)})),
  authenticatorSelection:{residentKey:'preferred',userVerification:'preferred'}});
}

/** A checked new passkey (its public key as base64), or null when the answer does not hold. */
export async function verifyRegistration(o:{response:unknown;challenge:string;origin:string;rpID:string}){
 try{
  const r=await verifyRegistrationResponse({response:o.response as RegistrationResponseJSON,expectedChallenge:o.challenge,expectedOrigin:o.origin,expectedRPID:o.rpID,requireUserVerification:false});
  if(!r.verified||!r.registrationInfo)return null;
  const c=r.registrationInfo.credential;
  return {id:c.id,publicKey:Buffer.from(c.publicKey).toString('base64'),counter:c.counter,transports:(c.transports??[]) as string[]};
 }catch{return null;}
}

/** The browser's "use a passkey" request for the passkeys of one waiting sign-in. */
export function authenticationOptions(o:{rpID:string;challenge:Uint8Array;allow:KnownPasskey[]}){
 return generateAuthenticationOptions({rpID:o.rpID,challenge:new Uint8Array(o.challenge),timeout:120000,userVerification:'preferred',
  allowCredentials:o.allow.map(c=>({id:c.id,transports:transports(c.transports)}))});
}

/** The passkey's new signature counter when the answer holds, or null. */
export async function verifyAssertion(o:{response:unknown;challenge:string;origin:string;rpID:string;credential:{id:string;publicKey:string;counter:number;transports?:string[]}}){
 try{
  const r=await verifyAuthenticationResponse({response:o.response as AuthenticationResponseJSON,expectedChallenge:o.challenge,expectedOrigin:o.origin,expectedRPID:o.rpID,requireUserVerification:false,
   credential:{id:o.credential.id,publicKey:new Uint8Array(Buffer.from(o.credential.publicKey,'base64')),counter:Number(o.credential.counter),transports:transports(o.credential.transports)}});
  return r.verified?r.authenticationInfo.newCounter:null;
 }catch{return null;}
}
