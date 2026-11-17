// TWO-STEP-FACTORS (owner, 30 Oct 2026): the browser side of passkeys and e-mailed codes. The browser's own passkey
// sheet saves and offers the passkey (Windows Hello, Google Password Manager on Android and Chrome, iCloud Keychain),
// including "use a phone or tablet" with a QR code; Pulse only asks for it and sends the answer back.
import {browserSupportsWebAuthn,startAuthentication,startRegistration} from '@simplewebauthn/browser';
import type {PublicKeyCredentialCreationOptionsJSON,PublicKeyCredentialRequestOptionsJSON} from '@simplewebauthn/browser';
import {post} from '../records';
import {passkeyName} from './two-step.mjs';

export const passkeysSupported=()=>typeof window!=='undefined'&&browserSupportsWebAuthn();

/** Adds a passkey for the signed-in person (the password once); answers new backup codes when these are the first. */
export async function addPasskey(current:string){
 const optionsJSON=await post<PublicKeyCredentialCreationOptionsJSON>('auth/passkey-options',{current});
 const response=await startRegistration({optionsJSON});
 return post<{recoveryCodes?:string[]}>('auth/passkey-register',{response,name:passkeyName(navigator.userAgent)});
}

/** Finishes a waiting sign-in with a passkey (the answer goes to auth/two-step, which sets the session cookie). */
export async function passkeySecondStep(challenge:string){
 const optionsJSON=await post<PublicKeyCredentialRequestOptionsJSON>('auth/two-step-start',{challenge,method:'passkey'});
 const response=await startAuthentication({optionsJSON});
 return post<Record<string,unknown>>('auth/two-step',{challenge,method:'passkey',response});
}

/** Sends a sign-in code to the delivery e-mail of a waiting sign-in. */
export const emailSignInCode=(challenge:string)=>post<{sent?:boolean;to?:string}>('auth/two-step-start',{challenge,method:'email'});

/** A cancelled or timed-out passkey sheet reads as that, not as an error code. */
export const passkeyMessage=(e:unknown,fallback:string)=>e instanceof Error&&!['NotAllowedError','AbortError'].includes(e.name)&&e.message?e.message:fallback;
