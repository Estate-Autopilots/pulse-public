// REPLAY-FIXES #5: Hang up ends the call on this device at once and tells the server after, retrying, and says so if it
// cannot (REPLAY-INSIGHTS: Savuzo's Hang up drew nothing for 3.3 s, then the server answered 503 after 4 s).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../calls/engine.ts", import.meta.url), "utf8");
const body = (name) => { const i = src.indexOf(`  ${name}`); assert.ok(i > 0, name); return src.slice(i, src.indexOf("\n  }\n", i) + 4); };

test("Hang up ends the call here before the server is asked", () => {
  const hang = body("async hangup()");
  assert.ok(hang.indexOf("this.endSession(s.call, true)") < hang.indexOf("this.leave("), "ended here first");
  assert.match(hang, /if \(!await this\.leave\(s\.call\.id\)\) void this\.leaveLater\(s\.call\.id\)/, "retries do not hold up answering another call");
});

test("my own Hang up is silent and drawn at once; the connection closes a frame later", () => {
  const end = body("endSession(call: Call, local = false)");
  const local = end.slice(end.indexOf("if (local) {"), end.indexOf("return;", end.indexOf("if (local) {")));
  assert.ok(local.indexOf("t.enabled = false") < local.indexOf("this.showEnded(call)"), "microphone and camera silent first");
  assert.ok(local.indexOf("this.showEnded(call)") < local.indexOf("s.close()"), "drawn before the connection closes");
  assert.match(local, /requestAnimationFrame\(\(\) => setTimeout\(\(\) => s\.close\(\), 0\)\)/);
  assert.match(end.slice(end.indexOf("return;")), /s\.close\(\); tones\.hangup\(\);/, "a call the others ended closes as before");
});

test("the server is tried three times in all, then the person is told in plain words", () => {
  const later = body("private async leaveLater(id: string)");
  assert.match(later, /for \(const wait of \[1500, 3000\]\)/);
  assert.match(later, /this\.fail\("The call ended here\. Pulse could not tell the others yet; it ends for them within 30 seconds\."\)/);
  assert.match(body("private async leave(id: string)"), /catch \{ return false; \}/);
});
