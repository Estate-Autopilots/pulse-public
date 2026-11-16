import assert from "node:assert/strict";
import test from "node:test";
import { deskPerson } from "../dist/sales-desk.js";

test("the sales desk is the viewer's own unless a person is named", () => {
  assert.equal(deskPerson(undefined), null);
  assert.equal(deskPerson(""), null);
  const id = ["0f4c2d6e", "aaaa", "4bbb", "8ccc", "dddddddddddd"].join("-");
  assert.equal(deskPerson(id), id);
  assert.throws(() => deskPerson("someone"), /Choose a person/);
  assert.throws(() => deskPerson(["x"]), /Choose a person/);
});
