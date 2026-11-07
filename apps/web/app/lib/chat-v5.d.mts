export function zoneOffset(date: Date, zone?: string): number;
export function laterChoices(kind?: "reminder" | "send", now?: Date, zone?: string): [string, string][];
export function whenWords(iso: string, now?: Date, zone?: string): string;
export function localInput(iso: string, zone?: string): string;
export function fromLocalInput(value: string, zone?: string): string | null;
