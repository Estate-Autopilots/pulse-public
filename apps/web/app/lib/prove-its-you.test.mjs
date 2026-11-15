// BUGFIX #29 (EA #29): "I am not able to switch from EA to Vitals OS." The switch answered 403 personal_sign_in (a
// company's own sign-in opens that company only) and the switcher did nothing. Now it asks "Confirm it's you" once (the
// person's own Pulse password, in the app's dialog), proves it, and switches; no signing out.
import { test } from "node:test";
import assert from "node:assert/strict";
import { needsProof, withProof, PROVE_WORDS } from "./prove-its-you.mjs";
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
  assert.match(asked.body, /opens this company only/);
  assert.equal(log[2][1], " my own pass ", "the password is sent exactly as typed");
});

test("a wrong password asks again with a plain line; three wrong keep the first refusal", async () => {
  const wrong = () => refusal(401, undefined, "That is not your Pulse password.");
  const { io, work, log } = world({ answers: ["a", "b", "c"], proveResults: [wrong(), wrong(), wrong()] });
  await assert.rejects(withProof(work, io), (e) => e.code === "personal_sign_in");
  const asks = log.filter((l) => l[0] === "ask").map((l) => l[1].helper);
  assert.deepEqual(asks, [undefined, PROVE_WORDS.wrong, PROVE_WORDS.wrong]);
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
