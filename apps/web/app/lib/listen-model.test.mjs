import { test } from "node:test";
import assert from "node:assert/strict";
import { actionsIn, clock, decisionsIn, lastSeq, liveEvent, liveSetup, mergeSegments, meterLevel, pauseCutter, pickMime, PIECE_MS, promiseLine, PURPOSES, rmsOf, summaryLines, toBase64, toPcm16 } from "./listen-model.mjs";

test("the recording format is the first one the browser makes", () => {
  assert.equal(pickMime((m) => m === "audio/mp4"), "audio/mp4");
  assert.equal(pickMime(() => true), "audio/webm;codecs=opus");
  assert.equal(pickMime(() => { throw new Error("old browser"); }), "");
});

test("the transcript merges new parts in order without repeats", () => {
  const a = [{ seq: 1, part: 0, text: "second" }, { seq: 0, part: 0, text: "first" }];
  const merged = mergeSegments(mergeSegments([], a), [{ seq: 1, part: 0, text: "second" }, { seq: 1, part: 1, text: "third" }, null]);
  assert.deepEqual(merged.map((s) => s.text), ["first", "second", "third"]);
  assert.equal(lastSeq(merged), 1);
  assert.equal(lastSeq([]), -1);
});

test("clock and base64", () => {
  assert.equal(clock(75000), "1:15");
  assert.equal(clock(3725000), "1:02:05");
  assert.equal(clock(-5), "0:00");
  assert.equal(toBase64(new Uint8Array([104, 105])), "aGk=");
  const big = new Uint8Array(100000).fill(65);
  assert.equal(Buffer.from(toBase64(big), "base64").length, 100000);
});

test("every purpose the database accepts has words", () => {
  assert.deepEqual(PURPOSES.map((p) => p.value), ["general", "quotation", "requirements", "meeting"]);
  assert.ok(PURPOSES.every((p) => p.label && p.hint));
});

// LISTEN-FAST
test("a piece ends at the first pause after the minimum, or at the longest", () => {
  const c = pauseCutter({ minMs: 1000, maxMs: 4000, gapMs: 300 });
  const run = (rms, ms) => { let cut = -1; for (let t = 0; t < ms; t += 50) if (c.step(rms, 50) && cut < 0) cut = t + 50; return cut; };
  assert.equal(run(0.2, 900), -1, "speaking, too short: no cut");
  assert.equal(run(0.001, 600), 300, "after 0.9 s of speech, the pause cuts it once 300 ms are quiet (and the piece is past 1 s)");
  c.reset();
  assert.equal(run(0.2, 5000), 4000, "nonstop speech is cut at the longest piece");
  assert.equal(PIECE_MS <= 8000, true, "the fallback's longest piece is shorter than the old 10 s");
});

// SPEED-2
test("the first piece of a session is cut sooner, so the first words show fast; later pieces as before", () => {
  const c = pauseCutter();
  const run = (rms, ms) => { let cut = -1; for (let t = 0; t < ms; t += 50) if (c.step(rms, 50) && cut < 0) cut = t + 50; return cut; };
  assert.equal(run(0.2, 1600), -1, "1.6 s of speech: still the first piece");
  assert.equal(run(0.001, 600), 400, "the first pause after 1.5 s ends the first piece");
  c.reset();
  assert.equal(run(0.2, 1600), -1);
  assert.equal(run(0.001, 600), -1, "the second piece is not cut at 2 s: it waits for 3.5 s");
  const d = pauseCutter();
  let cut = -1; for (let t = 0; t < 9000; t += 50) if (d.step(0.2, 50) && cut < 0) cut = t + 50;
  assert.equal(cut, 4000, "nonstop speech: the first piece is at most 4 s");
});

test("the level meter: silence is empty, speech fills most of it", () => {
  assert.equal(meterLevel(0), 0);
  assert.equal(meterLevel(0.002), 0);
  assert.ok(meterLevel(0.05) > 0.4 && meterLevel(0.05) < 0.9);
  assert.equal(meterLevel(2), 1);
  assert.equal(rmsOf(new Float32Array([0.5, -0.5])), 0.5);
  assert.equal(rmsOf([]), 0);
});

test("microphone samples become 16 kHz 16-bit PCM", () => {
  const s48 = new Float32Array(4800).fill(0.5);
  const pcm = toPcm16(s48, 48000);
  assert.equal(pcm.length, 1600, "100 ms at 48 kHz is 1600 samples at 16 kHz");
  assert.equal(pcm[0], Math.floor(0.5 * 0x7fff));
  assert.equal(toPcm16(new Float32Array([-2]), 16000)[0], -0x8000, "clipped, not wrapped");
  assert.equal(toPcm16(new Float32Array(441), 44100).length, 160);
});

test("the speech service's messages: ready, interim words, a finished sentence, reconnect", () => {
  assert.deepEqual(liveSetup("gemini-3.5-transcribe-live"), { setup: { model: "models/gemini-3.5-transcribe-live", generationConfig: { responseModalities: ["TEXT"] }, inputAudioTranscription: { languageCodes: [] } } });
  assert.deepEqual(liveEvent('{"setupComplete":{}}'), { type: "ready" });
  assert.deepEqual(liveEvent({ serverContent: { interimInputTranscription: { text: "क्लाइंट को चालीस " } } }), { type: "interim", text: "क्लाइंट को चालीस" });
  assert.deepEqual(liveEvent({ serverContent: { inputTranscription: { text: " Send the quotation today. " } } }), { type: "final", text: "Send the quotation today." });
  assert.deepEqual(liveEvent({ serverContent: { inputTranscription: { text: "Done." }, interimInputTranscription: { text: "Do" } } }).type, "final");
  assert.deepEqual(liveEvent({ goAway: { timeLeft: "10s" } }), { type: "goAway" });
  assert.equal(liveEvent({ error: { message: "quota" } }).type, "error");
  assert.equal(liveEvent("not json"), null);
  assert.equal(liveEvent({ serverContent: { turnComplete: true } }), null);
});

test("the line before Start says what will happen", () => {
  assert.match(promiseLine("general", null, true), /every word as it is said/);
  assert.match(promiseLine("general", null, false), /a few seconds after/);
  assert.equal(promiseLine("quotation", "Bharata", true), "Bharata will draft the quotation as the client speaks, list what is unclear, and make tasks for promises.");
  assert.equal(promiseLine("meeting", "Asha", true), "Asha will note decisions and create tasks for follow-ups.");
  assert.ok(PURPOSES.every((p) => promiseLine(p.value, "X", true).startsWith("X will ")));
});

test("the helper's actions are cards: one per record, newest first, this app's paths only", () => {
  const id1 = "0a1b2c3d-0000-4000-8000-000000000001", id2 = "0a1b2c3d-0000-4000-8000-000000000002";
  const cards = actionsIn([
    { at: "2026-11-14T10:00:00Z", body: `Made a task: Call the client back https://app.example.test/tasks/${id1}` },
    { at: "2026-11-14T10:01:00Z", body: `Drafted [Q-0042 for 40 signboards](/quotes/${id2}). Also see /tasks/${id1}.\nAnd /settings/whatever is not a record.` },
  ]);
  assert.deepEqual(cards.map((c) => [c.kind, c.label, c.title, c.href]), [
    ["quote", "Quote drafted", "Q-0042 for 40 signboards", `/quotes/${id2}`],
    ["task", "Task made", "Also see", `/tasks/${id1}`],
  ]);
  assert.deepEqual(actionsIn([{ at: "x", body: "No links here." }]), []);
  assert.deepEqual(actionsIn(null), []);
  assert.ok(actionsIn([{ at: "x", body: "see https://evil.test/tasks/0a1b2c3d" }]).every((c) => c.href.startsWith("/tasks/")), "another site's link opens here, as a path");
});

test("decisions and the short summary", () => {
  const segs = [{ text: "Okay, let's start." }, { text: "We agreed the budget is two lakh rupees." }, { text: "बजट दो लाख रुपये तय हुआ है।" }, { text: "बजेट ठरलं." }, { text: "We agreed the budget is two lakh rupees." }];
  assert.deepEqual(decisionsIn(segs), ["We agreed the budget is two lakh rupees.", "बजट दो लाख रुपये तय हुआ है।", "बजेट ठरलं."]);
  assert.deepEqual(summaryLines("2 people spoke. It was mostly about signboards. Decision: budget fixed. It runs about 3 minutes. Extra. Extra two.", 5).length, 5);
  assert.deepEqual(summaryLines(""), []);
});

test("a helper's reply reads as plain words", async () => {
  const { plainReply } = await import("./listen-model.mjs");
  assert.equal(plainReply("Made a task: [Order 40 signboards](/tasks/0a1b2c3d-0000). Done."), "Made a task: Order 40 signboards. Done.");
  assert.equal(plainReply("See [the quote](https://app.example.test/quotes/abc123) now"), "See the quote now");
  assert.equal(plainReply(null), "");
});
