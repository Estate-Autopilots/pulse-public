import test from "node:test";
import assert from "node:assert/strict";
import { exportGroup, looksLikePhone, reconcileRows, senderTotals } from "./chat-names.mjs";

// The reviewed synthetic number 98123 45678 written in another script's digits (fullwidth, Devanagari, Arabic-Indic).
const inScript = (zero) => "9812345678".replace(/[0-9]/g, (d) => String.fromCodePoint(zero + Number(d)));

// EST-1542 B: synthetic senders only.
test("the group comes from WhatsApp's file name, else the folder", () => {
  assert.equal(exportGroup("WhatsApp Chat with Site Team.txt"), "Site Team");
  assert.equal(exportGroup("WhatsApp Chat with Site Team (2).txt"), "Site Team", "a second export is the same group");
  assert.equal(exportGroup("WhatsApp Chat - Harbour Villa.txt"), "Harbour Villa");
  assert.equal(exportGroup("_chat.txt", "Exports/Harbour Villa/_chat.txt"), "Harbour Villa");
  assert.equal(exportGroup("notes.txt"), "notes");
});

test("totals per sender: largest export per group, summed over groups; phone numbers left out", () => {
  const p = (label, messages, phone = false) => ({ label, messages, phone });
  const t = senderTotals([
    { group: "Site Team", participants: [p("Asha Example", 10), p("+91 99999 00001", 4, true)] },
    { group: "Site Team", participants: [p("Asha Example", 12), p("Ravi Sample", 3)] },        // a later export of the same chat
    { group: "Harbour Villa", participants: [p("Asha Example", 5), p("+91 99999 00001", 2, true), p("+91 99999 00002", 1, true)] },
  ]);
  assert.deepEqual(t.names, [{ label: "Asha Example", messages: 17, groups: 2 }, { label: "Ravi Sample", messages: 3, groups: 1 }]);
  assert.equal(t.phoneSenders, 2, "each number is counted once and never listed");
  assert.deepEqual(senderTotals([]), { names: [], phoneSenders: 0 });
});

test("the browser leaves out what the server refuses: a number inside a name, and over-long names are kept to 80", () => {
  assert.equal(looksLikePhone("Ravi 98123 45678"), true);
  assert.equal(looksLikePhone("Site Team 2026"), false, "a year is not a phone number");
  for (const zero of [0xff10, 0x0966, 0x0660, 0x10d40]) assert.equal(looksLikePhone(`Ravi ${inScript(zero)}`), true, `digits from U+${zero.toString(16)}`);
  const long = "N".repeat(95);
  const t = senderTotals([{ group: "Site Team", participants: [{ label: "Ravi 98123 45678", phone: false, messages: 4 }, { label: long, phone: false, messages: 2 }] }]);
  assert.deepEqual(t.names, [{ label: "N".repeat(80), messages: 2, groups: 1 }]);
  assert.equal(t.phoneSenders, 1);
});

test("a reload takes the server's counts and order, and keeps an answer still being saved", () => {
  const row = (id, groups, decision = null) => ({ id, label: id, messages: 10, groups, decision, person: null, decidedBy: decision ? "you" : null });
  const local = [row("a", 1, "skip"), row("b", 1)];
  const server = [row("b", 5), row("a", 1)];                      // same number of rows: b now in 5 groups and first
  assert.deepEqual(reconcileRows(server, local, new Set(["a"])), [row("b", 5), row("a", 1, "skip")]);
  assert.deepEqual(reconcileRows(server, local, new Set()), server, "nothing pending: the server's rows as they are");
});
