import type { ActionId, Mode, View } from './index';

export type PanelUi = { busy?: boolean; status?: string; statusTone?: 'warning' | 'success'; mode?: Mode; showPip?: boolean; still?: boolean; tools?: { id: string; label: string; icon: string }[]; openLabel?: string; compact?: boolean };
export type PanelHandlers = { onAction?(id: ActionId): void; onMode?(mode: Mode): void; onOpen?(href: string): void; onTool?(id: string): void };
export function icon(name: string, size?: number): string;
export function mountPanel(root: HTMLElement, handlers?: PanelHandlers): { render(view: View, ui?: PanelUi): void; tick(view: View): void; reset(): void };
export type ConnectModel = { phase: 'start' | 'code' | 'awaiting' | 'password' | 'gate' | 'error'; code?: string; message?: string; busy?: boolean; still?: boolean; twoStep?: boolean; place?: string };
export function renderConnect(root: HTMLElement, model: ConnectModel, handlers?: { onPair?(): void; onCancel?(): void; onPassword?(input: { username: string; password: string; code: string }): void; onPasswordStart?(): void; onDemo?(): void; onOpenUrl?(): void }): void;
