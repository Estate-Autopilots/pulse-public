// PULSE-BUGS-2 (EA #34): a voice note can be downloaded from its message's actions, and its Transcript link never
// does nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { saveFile, transcriptAction, voiceDownload, voiceFileUrl } from "./voice-note.mjs";

const NOTE = "0b6f2c1e-3a4d-4e5f-8a9b-0c1d2e3f4a5b";
const SHA = "a".repeat(64);
const note = (id, extra = {}) => ({ attachments: [{ id, name: "Voice message 20 Nov 15.56.webm", mime: "audio/webm", voice: { seconds: 7, peaks: [] } }], ...extra });

test("Download saves the note itself: a Pulse note from chat files, an imported WhatsApp note from its store", () => {
  assert.deepEqual(voiceDownload(note(NOTE)), { href: `/api/v0/chats/files/${NOTE}`, name: "Voice message 20 Nov 15.56.webm" });
  assert.deepEqual(voiceDownload(note(`wa-${SHA}`)), { href: `/api/v0/chats/whatsapp/files/${SHA}`, name: "Voice message 20 Nov 15.56.webm" });
  assert.equal(voiceDownload({ attachments: [{ id: NOTE, voice: { seconds: 3 } }] }).name, "Voice message", "a note without a name still saves");
  assert.equal(voiceFileUrl(NOTE), `/api/v0/chats/files/${NOTE}`);
});

test("no Download for a message without a voice note, one still sending, or one deleted", () => {
  assert.equal(voiceDownload({ attachments: [{ id: NOTE, name: "Quote.pdf", mime: "application/pdf" }] }), null);
  assert.equal(voiceDownload({ attachments: [] }), null);
  assert.equal(voiceDownload(note(NOTE, { pending: true })), null);
  assert.equal(voiceDownload(note(NOTE, { removed: true })), null);
  assert.equal(voiceDownload(null), null);
});

test("the Transcript link says where the transcript is, and is never a button that does nothing", () => {
  const at = (state, id = NOTE, transcripts = true) => transcriptAction({ id, transcripts, state });
  assert.equal(at(undefined), "ask", "no transcript yet: ask for one");
  assert.equal(at({ transcript: null, transcriptState: null }), "ask");
  assert.equal(at({ transcript: null, transcriptState: "queued" }), "working");
  assert.equal(at({ transcript: null, transcriptState: "failed" }), "retry", "a failed one can be asked for again");
  assert.equal(at({ transcript: "Shoot at eleven tomorrow", transcriptState: "done" }), null, "the words show instead");
  assert.equal(at({ transcript: null, transcriptState: "unclear" }), null, "Not clear — listen shows instead");
  assert.equal(at({ transcript: null, transcriptState: "done" }), null, "done with no words: no button that would do nothing");
  assert.equal(at(undefined, `wa-${SHA}`), null, "an imported WhatsApp note: Pulse's transcriber refuses it");
  assert.equal(at({ transcript: null, transcriptState: null }, `wa-${SHA}`), null);
  assert.equal(at(undefined, NOTE, false), null, "transcripts are off on this server");
});

test("saveFile downloads through a link named as the note was sent", () => {
  const made = [];
  const doc = { body: { appendChild: (el) => made.push(el) }, createElement: (tag) => ({ tag, style: {}, clicked: 0, removed: 0, click() { this.clicked++; }, remove() { this.removed++; } }) };
  assert.equal(saveFile({ href: `/api/v0/chats/files/${NOTE}`, name: "Voice message.webm" }, doc), true);
  assert.equal(made.length, 1);
  assert.equal(made[0].tag, "a");
  assert.equal(made[0].href, `/api/v0/chats/files/${NOTE}`);
  assert.equal(made[0].download, "Voice message.webm");
  assert.equal(made[0].clicked, 1);
  assert.equal(made[0].removed, 1);
  assert.equal(saveFile({ href: "/x", name: "y" }, undefined), false, "no page, nothing to do");
});
