// BUGFIX #29 (EA #29): "I am not able to switch from EA to Vitals OS." The switch answered 403 personal_sign_in (a
// company's own sign-in opens that company only) and the switcher did nothing. Now it asks "Confirm it's you" once (the
// person's own Pulse password, in the app's dialog), proves it, and switches; no signing out.
import { test } from "node:test";
import assert from "node:assert/strict";
import { needsProof, withProof, PROVE_WORDS, proveWords } from "./prove-its-you.mjs";
import { promptOptions, promptProblem, promptValue } from "./dialogs.mjs";

const refusal = (status, code, message = "To open your other companies, sign in as yourself") => Object.assign(new Error(message), { status, code });

function world({ answers = [], proveResults = [], confirmAnswer = false, refuseFirst = 1 } = {}) {
  const log = [];
  let left = refuseFirst;
  const io = {
    ask: async (o) => { log.push(["ask", o]); return answers.length ? answers.shift() : null; },
    prove: async (pw) => { log.push(["prove", pw]); const r = proveResults.shift(); if (r instanceof Error) throw r; return r ?? { personal: true }; },
    confirm: async (o) => { log.push(["confirm", o]); return confirmAnswer; },
    signInAgain: () => { log.push(["signInAgain"]); },
  };
  const work = async () => { log.push(["work"]); if (left-- > 0) throw refusal(403, "personal_sign_in"); return { org: "other" }; };
  return { io, work, log };
}

test("the company-only refusal asks once for the person's own password, proves it and switches", async () => {
  const { io, work, log } = world({ answers: [" my own pass "] });
  assert.deepEqual(await withProof(work, io), { org: "other" });
  assert.deepEqual(log.map((l) => l[0]), ["work", "ask", "prove", "work"]);
  const asked = log[1][1];
  assert.equal(asked.password, true);
  assert.equal(asked.title, "Confirm it's you");
  assert.match(asked.body, /type your own Pulse password once/);
  assert.equal(asked.error, undefined, "no error before a wrong try");
  assert.equal(log[2][1], " my own pass ", "the password is sent exactly as typed");
});

test("a wrong password asks again with a plain line; three wrong keep the first refusal", async () => {
  const wrong = () => refusal(401, undefined, "That is not your Pulse password.");
  const { io, work, log } = world({ answers: ["a", "b", "c"], proveResults: [wrong(), wrong(), wrong()] });
  await assert.rejects(withProof(work, io), (e) => e.code === "personal_sign_in");
  const asks = log.filter((l) => l[0] === "ask").map((l) => l[1].error);
  assert.deepEqual(asks, [undefined, PROVE_WORDS.wrong, PROVE_WORDS.wrong], "a wrong password is the box's error, not a hint");
  const ok = world({ answers: ["a", "right"], proveResults: [wrong(), { personal: true }] });
  assert.deepEqual(await withProof(ok.work, ok.io), { org: "other" });
});

test("cancelling keeps the refusal (the switcher shows why); nothing is proved", async () => {
  const { io, work, log } = world({ answers: [] });
  await assert.rejects(withProof(work, io), (e) => e.code === "personal_sign_in");
  assert.ok(!log.some((l) => l[0] === "prove"));
});

test("an account with no Pulse password is offered to sign in again as yourself", async () => {
  const yes = world({ answers: ["x"], proveResults: [refusal(403, "personal_sign_in")], confirmAnswer: true });
  await assert.rejects(withProof(yes.work, yes.io), (e) => e.code === "personal_sign_in");
  assert.deepEqual(yes.log.map((l) => l[0]), ["work", "ask", "prove", "confirm", "signInAgain"]);
  const no = world({ answers: ["x"], proveResults: [refusal(403, "personal_sign_in")], confirmAnswer: false });
  await assert.rejects(withProof(no.work, no.io));
  assert.ok(!no.log.some((l) => l[0] === "signInAgain"));
});

test("any other refusal is left alone: no password is asked for", async () => {
  const io = { ask: async () => assert.fail("asked"), prove: async () => assert.fail("proved"), confirm: async () => false, signInAgain: () => {} };
  await assert.rejects(withProof(async () => { throw refusal(403, undefined, "You are not a member of that organisation"); }, io), /not a member/);
  assert.equal(needsProof(refusal(403, "personal_sign_in")), true);
  assert.equal(needsProof(new Error("x")), false);
  assert.equal(needsProof(null), false);
});

test("the kit's prompt keeps a password exactly as typed and still requires one", () => {
  const o = promptOptions({ title: "Confirm it's you", confirmLabel: "Confirm and open", password: true });
  assert.equal(o.password, true);
  assert.equal(promptValue("  spaced pass ", o), "  spaced pass ");
  assert.equal(promptProblem("", o), "Please fill this in.");
  assert.equal(promptOptions({ title: "x", confirmLabel: "y", password: true, multiline: true }).password, false);
  assert.equal(promptValue("  trimmed  ", { title: "x", confirmLabel: "y" }), "trimmed");
});

test("the dialog names the company it opens (screenshot judge)", async () => {
  const { io, work, log } = world({ answers: ["pw"] });
  await withProof(work, { ...io, name: "Vitals Technology" });
  const asked = log.find((l) => l[0] === "ask")[1];
  assert.equal(asked.confirmLabel, "Open Vitals Technology");
  assert.match(asked.body, /^To open Vitals Technology, type your own Pulse password once/);
  assert.equal(proveWords().confirmLabel, "Confirm and open");
});

// SWITCH-SMOOTH (owner, 16 Nov 2026: "I don't even know what my password is"): one tap first. The code goes to the
// person's own e-mail at once; the password is the quiet second way; nobody is left at a dead end.
import { proveNow, USE_PASSWORD } from "./prove-its-you.mjs";
import { PROMPT_ALTERNATE } from "./dialogs.mjs";

function codeWorld({ answers = [], sendResults = [], codeResults = [], password, codeTo = "s••••@gmail.com", confirmAnswer = false } = {}) {
  const log = [];
  const io = {
    name: "Estate Autopilots", codeTo, ...(password === undefined ? {} : { password }),
    ask: async (o) => { log.push(["ask", o]); return answers.length ? answers.shift() : null; },
    sendCode: async () => { log.push(["send"]); const r = sendResults.shift(); if (r instanceof Error) throw r; return r ?? { sent: true, to: codeTo }; },
    proveCode: async (c) => { log.push(["code", c]); const r = codeResults.shift(); if (r instanceof Error) throw r; return r ?? { personal: true }; },
    prove: async (pw) => { log.push(["prove", pw]); return { personal: true }; },
    confirm: async (o) => { log.push(["confirm", o]); return confirmAnswer; },
    signInAgain: () => { log.push(["signInAgain"]); },
  };
  return { io, log };
}

test("one tap: a code goes to the person's own e-mail at once, the code proves them, no password is asked", async () => {
  const { io, log } = codeWorld({ answers: ["123456"] });
  assert.equal(await proveNow(io), true);
  assert.deepEqual(log.map((l) => l[0]), ["send", "ask", "code"]);
  const asked = log[1][1];
  assert.equal(asked.code, true);
  assert.equal(asked.password, undefined);
  assert.match(asked.body, /We sent a 6-digit code to s••••@gmail\.com\. Paste it here to open Estate Autopilots\. This device won't ask again\./);
  assert.equal(asked.confirmLabel, "Open Estate Autopilots");
  assert.equal(asked.alternate, "Use my Pulse password instead");
});

test("withProof runs the switch again after the code", async () => {
  let left = 1; const log = [];
  const { io } = codeWorld({ answers: ["123456"] });
  const r = await withProof(async () => { log.push("work"); if (left-- > 0) throw refusal(403, "personal_sign_in"); return { org: "ea" }; }, io);
  assert.deepEqual(r, { org: "ea" }); assert.deepEqual(log, ["work", "work"]);
});

test("'Use my Pulse password instead' asks for the password, as before", async () => {
  const { io, log } = codeWorld({ answers: [USE_PASSWORD, "my own pass"] });
  assert.equal(USE_PASSWORD, PROMPT_ALTERNATE);
  assert.equal(await proveNow(io), true);
  assert.deepEqual(log.map((l) => l[0]), ["send", "ask", "ask", "prove"]);
  assert.equal(log[2][1].password, true);
});

test("a wrong code is the box's error; a code that ran out is sent again once; cancelling proves nothing", async () => {
  const wrong = Object.assign(new Error("x"), { status: 401, code: "code_wrong" });
  const out = Object.assign(new Error("x"), { status: 401, code: "code_expired" });
  const { io, log } = codeWorld({ answers: ["000000", "111111", "222222"], codeResults: [wrong, out, { personal: true }] });
  assert.equal(await proveNow(io), true);
  const errors = log.filter((l) => l[0] === "ask").map((l) => l[1].error);
  assert.deepEqual(errors, [undefined, "That code is not right. Check the newest e-mail from Pulse.", "That code ran out, so we sent a new one. Check your e-mail."]);
  assert.equal(log.filter((l) => l[0] === "send").length, 2);
  const cancel = codeWorld({ answers: [null] });
  assert.equal(await proveNow(cancel.io), false);
  assert.ok(!cancel.log.some((l) => l[0] === "prove" || l[0] === "code"));
});

test("never a dead end: no own e-mail -> the password; neither -> sign in as yourself; a code sent a moment ago is still asked for", async () => {
  const none = Object.assign(new Error("no"), { status: 409, code: "no_own_email" });
  const pw = codeWorld({ answers: ["pass"], sendResults: [none] });
  assert.equal(await proveNow(pw.io), true);
  assert.deepEqual(pw.log.map((l) => l[0]), ["send", "ask", "prove"]);
  const neither = codeWorld({ sendResults: [none], password: false, confirmAnswer: true });
  assert.equal(await proveNow(neither.io), false);
  assert.deepEqual(neither.log.map((l) => l[0]), ["send", "confirm", "signInAgain"]);
  const noPasswordCode = codeWorld({ answers: ["123456"], password: false });
  assert.equal(await proveNow(noPasswordCode.io), true);
  assert.equal(noPasswordCode.log[1][1].alternate, undefined, "no password: no 'Use my Pulse password' button");
  const soon = codeWorld({ answers: ["123456"], sendResults: [Object.assign(new Error("wait"), { status: 429 })] });
  assert.equal(await proveNow(soon.io), true);
  assert.deepEqual(soon.log.map((l) => l[0]), ["send", "ask", "code"]);
});

test("the kit's code box reads a pasted '123 456' as its digits and asks for all six", () => {
  const o = promptOptions({ title: "Confirm it's you", confirmLabel: "Open", code: true, minLength: 6, maxLength: 6, alternate: "Use my Pulse password instead" });
  assert.equal(o.code, true); assert.equal(o.alternate, "Use my Pulse password instead");
  assert.equal(promptValue(" 123 456 ", o), "123456");
  assert.equal(promptProblem("123", o), "Type all 6 digits.");
  assert.equal(promptProblem("", o), "Type or paste the code from the e-mail.");
  assert.equal(promptProblem("123-456", o), null);
  assert.equal(promptOptions({ title: "x", confirmLabel: "y", code: true, password: true }).code, false);
});
