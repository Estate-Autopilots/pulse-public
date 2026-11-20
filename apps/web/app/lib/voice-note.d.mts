export type VoiceTranscriptState = "queued" | "done" | "failed" | "unclear" | null;
export declare function voiceFileUrl(id: string | null | undefined): string;
export declare function voiceDownload(m: { pending?: boolean; removed?: boolean; attachments?: { id?: string; name?: string; voice?: unknown }[] } | null | undefined): { href: string; name: string } | null;
export declare function transcriptAction(p: { id: string | null | undefined; transcripts: boolean; state?: { transcript?: string | null; transcriptState?: VoiceTranscriptState } | null }): "ask" | "working" | "retry" | null;
export declare function saveFile(file: { href: string; name: string }, doc?: Document): boolean;
