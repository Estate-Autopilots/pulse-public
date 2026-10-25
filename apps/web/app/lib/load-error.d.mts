export const UNAVAILABLE: string;
export function apiFailure(status: number | undefined, body: unknown): string;
export function describeFailure(text: string | null | undefined): { retry: boolean; title: string; text: string };
