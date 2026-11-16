export declare function draftKey(kind: string, id?: string | null): string | null;
export declare function offerDraft(draft: { data?: unknown; updatedAt?: string } | null | undefined, recordSavedAt: string | null | undefined): boolean;
export declare function keptAgo(at: string | null | undefined, now?: number): string;
export type ResumeRow = { key: string; title: string; href: string; at: string; what: string };
export declare function resumeList(
  items: { key: string; title: string; href: string; updatedAt: string }[] | null | undefined,
  billing: { id: string; docType: string; number: string | null; buyer: string | null; updatedAt: string }[] | null | undefined,
  labels: Record<string, string> | null | undefined, max?: number): ResumeRow[];
