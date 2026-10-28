export type CmdMember = { id: string; username: string | null; name: string };
export function localDay(d: Date): string;
export function whoWhen<M extends CmdMember>(args: string, o: { members?: M[]; today: string; viewer?: string }): { text: string; person: M | null; self: boolean; dueOn: string | null };
export function leaveRange(args: string, today: string): { from: string; to: string; half: "first" | "second" | null; kind: string | null; reason: string } | null;
export function remindAt(args: string, now?: Date): { at: Date; text: string } | null;
export function amountOf(args: string): { amount: number; what: string } | null;
export function requestIntent(text: string, today: string): { title: string; dueOn: string | null } | null;
export type DigestMessage = { authorId: string; name: string; body: string; createdAt: string; kind?: string; removed?: boolean; attachments?: { task?: string }[] };
export function chatDigest(messages: DigestMessage[], o: { viewer: string; since?: string | null }): {
  count: number; people: { name: string; n: number }[]; questions: { name: string; body: string }[]; tasks: number; files: number;
  latest: { name: string; body: string }[]; from: string | null };
