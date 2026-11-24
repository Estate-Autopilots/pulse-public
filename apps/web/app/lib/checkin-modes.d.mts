export type CheckinMode = "office" | "wfh" | "field";
export const CHECKIN_MODES: { id: CheckinMode; label: string }[];
export const CHECKIN_MODES_LABEL: string;
export function modeLabel(id: string): string;
export function pressLabel(action: string, idle: string, state: { doing: string | null; sending: boolean; settled: boolean }): string;
