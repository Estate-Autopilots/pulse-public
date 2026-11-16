export const needsProof: (e: unknown) => boolean;
export const USE_PASSWORD: string;
type Words = { title: string; body: string; label: string; confirmLabel: string; wrong: string; noPassword: string; signInTitle: string; signInLabel: string;
  codeBody: (to: string) => string; codeLabel: string; codeHelp: string; codeWrong: string; codeResent: string; codeOut: string; usePassword: string;
  offerTitle: string; offerBody: string; offerConfirm: string; offerLater: string };
export function proveWords(name?: string | null): Words;
export const PROVE_WORDS: Words;
export type ProveIo = {
  ask: (o: { title: string; body: string; label: string; confirmLabel: string; password?: boolean; code?: boolean; minLength?: number; maxLength: number;
    alternate?: string; placeholder?: string; helper?: string; error?: string }) => Promise<string | null>;
  prove: (password: string) => Promise<unknown>;
  confirm: (o: { title: string; body: string; confirmLabel: string }) => Promise<boolean>;
  signInAgain: () => unknown;
  tries?: number;
  name?: string | null;
  /** SWITCH-SMOOTH: send a code to the account's own e-mail (account/prove-code), and check one. */
  sendCode?: () => Promise<{ to?: string; personal?: boolean }>;
  proveCode?: (code: string) => Promise<unknown>;
  /** The masked own e-mail the code goes to, when known before (account/crossing). */
  codeTo?: string | null;
  /** Whether the account has a Pulse password (false: never asked for one). */
  password?: boolean;
  /** SWITCH-SMOOTH (2178): prove with the account's passkey (the device's own sheet); throws when cancelled. */
  passkey?: () => Promise<unknown>;
  /** After a code or a password proved the person: offer to add a passkey. */
  offerPasskey?: (w: Words) => Promise<unknown>;
};
export function proveNow(io: ProveIo): Promise<boolean>;
export function withProof<T>(work: () => Promise<T>, io: ProveIo): Promise<T>;
