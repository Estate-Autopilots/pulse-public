// SIM-CLIENTS R146 / AI-EMP-2: while the API restarts or answers slowly, a host keeps the sign-in mode it last had (a
// client on a password address was told to sign in through Access when the lookup timed out).
import assert from "node:assert/strict";
import test from "node:test";
import { hostMode } from "./host-mode.mjs";

test("a known host keeps its last answer while the API cannot say; an unknown host gets the install's default", async () => {
  delete process.env.PULSE_PUBLIC_LOGIN_ENABLED;
  const real = Date.now; let now = 1_800_000_000_000; Date.now = () => now;
  try {
    const up = async () => ({ ok: true, json: async () => ({ signIn: "password", name: "Rookwood Homes (test)", own: false }) });
    const down = async () => { throw new Error("The operation was aborted due to timeout"); };
    const refused = async () => ({ ok: false, json: async () => ({}) });
    assert.equal((await hostMode("rookwood-test.localhost:3200", up)).signIn, "password");
    now += 31_000; // past the 30 s cache
    assert.equal((await hostMode("rookwood-test.localhost:3200", down)).signIn, "password", "timed out: the last answer stands");
    assert.equal((await hostMode("rookwood-test.localhost:3200", refused)).signIn, "password", "an error answer: the last answer stands");
    assert.equal((await hostMode("never-seen-test.localhost:3200", down)).signIn, "access", "never answered: the install's default");
  } finally { Date.now = real; }
});
