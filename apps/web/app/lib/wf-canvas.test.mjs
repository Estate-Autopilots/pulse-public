import assert from "node:assert/strict";
import test from "node:test";
import { autoLayout, canWire, checklistOf, detailOf, explicit, freeSpot, nodeHeight, outType, portPoint, specOf, wiresOf, SIZE } from "./wf-canvas.mjs";

// The blocks the API hands over (a few, shaped as services/api/src/workflow-blocks.ts).
const P = (key, label, type) => ({ key, label, type });
const BLOCKS = [
  { module: "lead_capture", label: "Lead capture", kind: "task", inputs: [], outputs: [P("lead", "Lead", "lead")] },
  { module: "sales_xray", label: "Sales X-Ray", kind: "task", inputs: [P("lead", "Lead", "lead")], outputs: [P("summary", "Summary", "call"), P("items", "Items asked for", "call")] },
  { module: "quotation", label: "Quotation", kind: "task", inputs: [P("lead", "Lead", "lead"), P("items", "Items asked for", "call")], outputs: [P("quote", "Quote", "quote")] },
  { module: "follow_up", label: "Follow-up", kind: "task", inputs: [P("quote", "Quote", "quote")], outputs: [P("reply", "Reply", "quote")] },
  { module: "approval", label: "Approval", kind: "approval", inputs: [P("in", "In", "any")], outputs: [P("approved", "Approved", "any"), P("back", "Send back", "any")] },
  { module: "checklist", label: "Checklist (SOP)", kind: "task", inputs: [P("in", "In", "any")], outputs: [P("done", "Done", "any")] },
  { module: "decision", label: "Decision", kind: "decision", inputs: [P("in", "In", "any")], outputs: [P("yes", "Yes", "any"), P("no", "Otherwise", "any")] },
  { module: "wait", label: "Wait", kind: "wait", inputs: [P("in", "In", "any")], outputs: [P("after", "After", "any")] },
  { module: "end", label: "End", kind: "end", inputs: [P("in", "In", "any")], outputs: [] },
  { module: "handoff", label: "Hand-off", kind: "task", inputs: [P("in", "In", "any")], outputs: [] },
  { module: "data_capture", label: "Data capture form", kind: "task", inputs: [P("in", "In", "any")], outputs: [P("answers", "Answers", "form")] },
];
const BY = Object.fromEntries(BLOCKS.map((b) => [b.module, b]));
const flow = () => [
  { id: "a", title: "Lead", kind: "task", module: "lead_capture", next: [{ to: "b", label: null, port: "lead" }] },
  { id: "b", title: "Call", kind: "task", module: "sales_xray", next: [{ to: "c", label: null, port: "items" }] },
  { id: "c", title: "Quote", kind: "task", module: "quotation", next: [{ to: "d", label: null, port: "quote" }] },
  { id: "d", title: "Check", kind: "task", module: "checklist", next: [] },
];

test("ports carry their types, and a pass-through port carries what came in", () => {
  const s = flow();
  assert.equal(outType(s, BY, "b", "items"), "call");
  assert.equal(outType(s, BY, "d", "done"), "quote", "the checklist passes the quote on");
  assert.equal(outType(s, BY, "a", null), "lead");
});

test("a wire joins matching types only, and offers adapters otherwise", () => {
  const s = flow();
  assert.deepEqual(canWire(s, BY, BLOCKS, "c", "quote", "b", null).ok, false, "a quote cannot go into Sales X-Ray");
  const lead = canWire(s, BY, BLOCKS, "a", "lead", "d", null);
  assert.equal(lead.ok, true, "anything goes into a checklist");
  const r = canWire(s, BY, BLOCKS, "a", "lead", "c", "items");
  assert.equal(r.ok, false);
  assert.ok(r.adapters.includes("sales_xray"), "Sales X-Ray turns a lead into call analysis");
  // An adapter is joined by the input that fits: call analysis goes into a Quotation's "items", never its "lead".
  assert.equal(canWire(s, BY, BLOCKS, "b", "items", "c", "items").ok, true);
  assert.equal(canWire(s, BY, BLOCKS, "b", "items", "c", "lead").ok, false);
  assert.equal(canWire(s, BY, BLOCKS, "b", "summary", "a", null).ok, false, "nothing goes into a start block");
  assert.equal(canWire(s, BY, BLOCKS, "b", "summary", "b", null).ok, false);
  // Through a pass-through block the type is kept: a checklist after a quote still feeds a follow-up.
  s.push({ id: "e", title: "Follow", kind: "task", module: "follow_up", next: [] });
  assert.equal(canWire(s, BY, BLOCKS, "d", "done", "e", null).ok, true);
});

test("implicit next steps become wires, and SOP steps are laid out in columns", () => {
  const sop = [{ id: "s1", title: "One", kind: "task", next: null }, { id: "s2", title: "Two", kind: "approval", next: [{ to: "s3", label: "Approved" }, { to: "s1", label: "Send back" }] }, { id: "s3", title: "Three", kind: "task", next: null }];
  assert.deepEqual(wiresOf(sop).map((w) => `${w.from}>${w.to}`), ["s1>s2", "s2>s3", "s2>s1"]);
  const ex = explicit(sop, BY);
  assert.deepEqual(ex[0].next, [{ to: "s2", label: null }]);
  assert.deepEqual(ex[2].next, []);
  const laid = autoLayout(ex, BY);
  assert.ok(laid.every((s) => s.pos));
  assert.ok(laid[1].pos.x > laid[0].pos.x && laid[2].pos.x > laid[1].pos.x, "columns follow the flow; a send-back does not pull a step left");
  assert.equal(specOf({ kind: "approval" }, BY).module, "approval");
});

test("geometry: port dots, heights and a free spot", () => {
  const spec = BY.sales_xray;
  assert.equal(nodeHeight(spec), SIZE.head + 2 * SIZE.row + SIZE.pad);
  const p = portPoint({ x: 100, y: 50 }, spec, "out", "items");
  assert.deepEqual(p, { x: 100 + SIZE.w, y: 50 + SIZE.head + SIZE.row + SIZE.row / 2 });
  const s = autoLayout(flow(), BY);
  const spot = freeSpot(s, BY, s[3]);
  assert.ok(spot.x > s[3].pos.x);
  assert.deepEqual(freeSpot([], BY, null), { x: SIZE.margin, y: SIZE.margin });
});

test("a block's checklist is its SOP lines", () => {
  assert.deepEqual(checklistOf("• Call the lead\n• Upload the recording\n\n3. Check it"), ["Call the lead", "Upload the recording", "Check it"]);
  assert.equal(detailOf(["Call the lead", " ", "Upload"]), "• Call the lead\n• Upload");
  assert.equal(detailOf([]), null);
});
