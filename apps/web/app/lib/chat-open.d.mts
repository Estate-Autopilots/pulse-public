import type { ChatData } from "../chats/types";
export declare function existingDirect(list: ChatData | null | undefined, personId: string | null | undefined): string | null;
export declare function withDirect(list: ChatData, id: string, person: { id: string; name: string; agent?: boolean; photoAt?: string | null; username?: string | null }): ChatData;
