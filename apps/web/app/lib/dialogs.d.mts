import type { ReactNode } from "react";

export type ConfirmOptions = {
  /** What is being asked, as a question: "Archive this folder?". */ title: string;
  /** What happens, in plain words: "Its docs stay and are listed under All docs." */ body?: ReactNode;
  /** The main button, a verb: "Archive folder" (not "OK"). */ confirmLabel: string;
  /** The other button; "Cancel" by default. */ cancelLabel?: string;
  /** Red main button, for deleting or ending something. */ danger?: boolean;
  /** For what cannot be undone: the main button waits until this text is typed (spaces and capitals do not matter). */ typeToConfirm?: string;
};

export type PromptOptions = {
  /** The question: "Name the new folder". */ title: string;
  /** The box's own label when it differs from the title: "Folder name". */ label?: string;
  /** A line of plain words under the title. */ body?: ReactNode;
  placeholder?: string;
  defaultValue?: string;
  /** A hint under the box (replaced by the problem when there is one). */ helper?: string;
  /** The main button, a verb: "Create folder". */ confirmLabel: string;
  cancelLabel?: string;
  /** An empty answer is refused (true by default); false lets an empty answer through as "". */ required?: boolean;
  minLength?: number;
  maxLength?: number;
  /** A link: true for https:// or http://, or the allowed starts (["https:", "http:", "mailto:"]). "example.com" gets https://. */
  url?: boolean | readonly string[];
  /** A box of several lines (reasons, notes): Enter answers, Shift+Enter starts a new line. */ multiline?: boolean;
  /** A password box: hidden as typed, the browser's password manager may fill it, never trimmed. */ password?: boolean;
  /** What was wrong with the last answer, shown as the box's problem until the person types again. */ error?: string | null;
  /** A code from an e-mail: number pad, one-time-code fill, a pasted "123 456" read as digits. */ code?: boolean;
  /** A second, quieter button beside Cancel; pressing it answers PROMPT_ALTERNATE. */ alternate?: string;
  /** Red main button. */ danger?: boolean;
  /** One more check on the trimmed answer: its problem in plain words, or null. */ validate?: (value: string) => string | null | undefined;
};

export type DialogKind = "confirm" | "prompt";
export type DialogRequest = { id: number; kind: DialogKind; options: ConfirmOptions | PromptOptions; settle: (value: boolean | string | null) => void };

export type DialogQueue = {
  open(kind: "confirm", options: ConfirmOptions): Promise<boolean>;
  open(kind: "prompt", options: PromptOptions): Promise<string | null>;
  current(): DialogRequest | null;
  size(): number;
  answer(id: number, value: boolean | string | null): boolean;
  clear(): void;
  subscribe(listener: () => void): () => void;
};
export function createDialogQueue(): DialogQueue;

export type ConfirmShape = { title: string; body: ReactNode | null; confirmLabel: string; cancelLabel: string; danger: boolean; typeToConfirm: string | null };
export function confirmOptions(options: Partial<ConfirmOptions> | undefined): ConfirmShape;

export type PromptShape = { title: string; label: string | null; body: ReactNode | null; placeholder: string; defaultValue: string; helper: string | null;
  confirmLabel: string; cancelLabel: string; required: boolean; minLength: number; maxLength: number; url: string[] | null; multiline: boolean; password: boolean; error: string | null; code: boolean; alternate: string | null; danger: boolean;
  validate: ((value: string) => string | null | undefined) | null };
export function promptOptions(options: Partial<PromptOptions> | PromptShape | undefined): PromptShape;

export function normalizeLink(value: string, schemes?: readonly string[]): string;
export function isLink(value: string, schemes?: readonly string[]): boolean;
export const PROMPT_ALTERNATE: string;
export function promptValue(raw: string, options: Partial<PromptOptions> | PromptShape): string;
export function promptProblem(raw: string, options: Partial<PromptOptions> | PromptShape): string | null;
export function typedMatches(typed: string, expected: string): boolean;
export function enterAnswers(event: { key: string; shiftKey?: boolean; isComposing?: boolean; tag?: string; multiline?: boolean }): boolean;
export function firstFocus(kind: DialogKind, options: { typeToConfirm?: string | null } | undefined): "input" | "confirm";

export type ToastTone = "success" | "error" | "info";
export type ToastExtra = { id?: string; message?: string; action?: { label: string; run: () => void }; timeout?: number };
export type ToastNotice = { id: string; tone: ToastTone; title: string; message?: string; action?: { label: string; run: () => void }; timeout: number };
export function toastNotice(tone: ToastTone | string, what: unknown, extra?: ToastExtra): ToastNotice;
