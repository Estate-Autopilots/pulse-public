export declare const OPEN_SUBTASKS: RegExp;
export declare function isOpenSubtasks(error: unknown): boolean;
export declare const finishHref: (id: string) => string;
export declare function finishWords(open?: number | null): { title: string; message: string };
