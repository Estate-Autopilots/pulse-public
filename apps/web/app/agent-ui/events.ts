// AGENT-UI-CONTROL: the window events the screen actions travel on inside the page. Each is cancelable; the part of the
// screen that does it calls preventDefault(), so the action knows it was done (and says so when nothing on screen could).

/** Put words (or an emoji) into the message box the person has open: detail { text, channelId }. Never sends. */
export const COMPOSER_EVENT = "pulse:composer-insert";
/** Start (detail { on: true }, after the person's own tap) or stop (on: false) a voice note in the chat's message box. */
export const MIC_EVENT = "pulse:mic";
export type ComposerInsert = { text: string; channelId?: string | null };
export type MicRequest = { on: boolean };

/** Dispatch one; true when something on screen took it. */
export function ask<T>(name: string, detail: T): boolean {
  const e = new CustomEvent<T>(name, { detail, cancelable: true });
  window.dispatchEvent(e);
  return e.defaultPrevented;
}
