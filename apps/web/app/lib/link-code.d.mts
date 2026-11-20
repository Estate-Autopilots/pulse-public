export function pastedToken(value: unknown): string;
export function typedCode(value: unknown): string;
/** { body } to post to auth/link-sign-in, or { error } to show. */
export function linkSignInBody(input: { username: string; entry: string; otp?: string }): { body?: Record<string, string>; error?: string };
