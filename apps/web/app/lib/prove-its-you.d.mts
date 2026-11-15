export const needsProof: (e: unknown) => boolean;
export const PROVE_WORDS: { title: string; body: string; label: string; confirmLabel: string; wrong: string; noPassword: string; signInTitle: string; signInLabel: string };
export function withProof<T>(work: () => Promise<T>, io: {
  ask: (o: { title: string; body: string; label: string; confirmLabel: string; password: boolean; maxLength: number; helper?: string }) => Promise<string | null>;
  prove: (password: string) => Promise<unknown>;
  confirm: (o: { title: string; body: string; confirmLabel: string }) => Promise<boolean>;
  signInAgain: () => unknown;
  tries?: number;
}): Promise<T>;
