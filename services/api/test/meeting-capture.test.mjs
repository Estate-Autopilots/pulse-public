import assert from "node:assert/strict";
import test from "node:test";
import { clock, draftProblems, nameFor, pageFor, parseTranscript, problemName, readable, secondsOf, summaryOf, topics } from "../dist/transcript-import.js";
import { actionsOf, importInput, speakerId } from "../dist/meetings.js";

// MEETING-CAPTURE (1946): transcripts brought into Meetings, read on this server. Synthetic words and names only.

test("times read and written", () => {
  assert.equal(secondsOf("0:05"), 5);
  assert.equal(secondsOf("[12:30]"), 750);
  assert.equal(secondsOf("1:02:03"), 3723);
  assert.equal(secondsOf("00:00:05.120"), 5);
  assert.equal(secondsOf("00:01:05,999"), 65);
  assert.equal(secondsOf("12:75"), null);
  assert.equal(secondsOf("hello"), null);
  assert.equal(clock(65), "1:05");
  assert.equal(clock(3723), "1:02:03");
});

test("WebVTT keeps the voices and joins caption pieces into sentences", () => {
  const vtt = `WEBVTT

NOTE synthetic captions

1
00:00:01.000 --> 00:00:03.000
<v Asha Synthetic>Welcome to the synthetic launch review.</v>

2
00:00:03.500 --> 00:00:05.000
<v Ravi Example>Thanks. I will send the brochure</v>

3
00:00:05.000 --> 00:00:07.000
<v Ravi Example>by Monday.</v>

4
00:01:10.000 --> 00:01:12.000
<v Asha Synthetic>We agreed to launch on the twentieth.</v>
`;
  const p = parseTranscript(vtt, "launch.vtt");
  assert.equal(p.format, "vtt");
  assert.deepEqual(p.speakers, ["Asha Synthetic", "Ravi Example"]);
  assert.deepEqual(p.lines.map((l) => [l.speaker, l.at, l.text]), [
    ["Asha Synthetic", 1, "Welcome to the synthetic launch review."],
    ["Ravi Example", 3, "Thanks. I will send the brochure by Monday."],
    ["Asha Synthetic", 70, "We agreed to launch on the twentieth."],
  ]);
});

test("SubRip with names in the text, and rolling repeats dropped", () => {
  const srt = `1
00:00:01,000 --> 00:00:02,500
Meera Testcase: The synthetic stock sheet is late.

2
00:00:02,500 --> 00:00:04,000
Meera Testcase: The synthetic stock sheet is late.

3
00:00:04,000 --> 00:00:06,000
[Ravi Example] I'll chase the supplier tomorrow.
`;
  const p = parseTranscript(srt, "call.srt");
  assert.equal(p.format, "srt");
  assert.deepEqual(p.lines.map((l) => [l.speaker, l.at, l.text]), [
    ["Meera Testcase", 1, "The synthetic stock sheet is late."],
    ["Ravi Example", 4, "I'll chase the supplier tomorrow."],
  ]);
});

test("Otter's export: a name and a time, then what they said", () => {
  const otter = `Synthetic weekly sync
Tue, Nov 3, 2026 10:00AM • 12:15

Asha Synthetic  0:02
Morning everyone. Let's look at the synthetic pipeline.

Ravi Example  0:15
Two leads moved this week. I will call the third one on Friday.

Transcribed by https://otter.ai
`;
  const p = parseTranscript(otter, "otter.txt");
  assert.equal(p.format, "otter");
  assert.equal(p.heldOn, "2026-11-03");
  assert.equal(p.heading, "Synthetic weekly sync");
  assert.deepEqual(p.lines.map((l) => [l.speaker, l.at]), [["Asha Synthetic", 2], ["Ravi Example", 15]]);
  assert.ok(!p.lines.some((l) => /otter\.ai/.test(l.text)));
  assert.equal(nameFor(p, { day: "2026-11-09" }), "Synthetic weekly sync, 3 Nov 2026");
});

test("Loom's copied transcript: a time before each line, or on its own line", () => {
  const loom = `0:00 Hi team, this is a quick synthetic walkthrough of the new quote screen.
0:12 First, the totals box sits on the right.
0:31
Then the send button moves to the top.`;
  const p = parseTranscript(loom);
  assert.equal(p.format, "loom");
  assert.deepEqual(p.lines.map((l) => [l.at, l.text.slice(0, 12)]), [[0, "Hi team, thi"], [12, "First, the t"], [31, "Then the sen"]]);
  assert.match(summaryOf(p), /It runs about 1 minute\./);
});

test("Name: words lines, wrapped lines continue the speaker, labels are not speakers", () => {
  const t = `Asha Synthetic: We decided to keep the synthetic price.
It stays the same for the next quarter.
Ravi Example: Okay. I will update the price list by Friday.
Action: book the synthetic site visit`;
  const p = parseTranscript(t);
  assert.equal(p.format, "speakers");
  assert.deepEqual(p.speakers, ["Asha Synthetic", "Ravi Example"]);
  assert.equal(p.lines[0].text, "We decided to keep the synthetic price. It stays the same for the next quarter.");
  assert.equal(p.lines.length, 3);
  assert.match(p.lines[2].text, /Action: book/);
  assert.equal(p.lines[2].speaker, null);
});

test("Wispr Flow dictation (one long paragraph) becomes sentences; a short first line is the heading", () => {
  const long = Array.from({ length: 12 }, (_, i) => `Synthetic point number ${i + 1} is about the brochure and the pricing sheet.`).join(" ");
  const p = parseTranscript(long);
  assert.equal(p.format, "plain");
  assert.ok(p.lines.length >= 3 && p.lines.every((l) => l.text.length <= 1200));
  assert.equal(p.heading, null);
  assert.equal(topics(p.lines)[0], "brochure");
  assert.match(nameFor(p, { day: "2026-11-09" }), /^Brochure and \w+, 9 Nov 2026$/);
  const h = parseTranscript("Synthetic hiring plan\nWe need two designers.\nMeera will post the job on Monday.");
  assert.equal(h.heading, "Synthetic hiring plan");
  assert.equal(nameFor(h, { day: "2026-11-09" }), "Synthetic hiring plan, 9 Nov 2026");
});

test("names: a meaningful file name, else the speakers; the day from the file name", () => {
  const p = parseTranscript("Asha Synthetic: hello there.\nRavi Example: hi.", "2026-11-05 Synthetic vendor call.txt");
  assert.equal(p.heldOn, "2026-11-05");
  assert.equal(nameFor(p, { fileName: "2026-11-05 Synthetic vendor call.txt", day: "2026-11-09" }), "Synthetic vendor call, 5 Nov 2026");
  assert.equal(nameFor(parseTranscript("Asha Synthetic: hello there.\nRavi Example: hi."), { fileName: "transcript (2).txt", day: "2026-11-09" }), "Meeting with Asha and Ravi, 9 Nov 2026");
});

test("a name from how the meeting introduces itself; full names when first names are shared", () => {
  const p = parseTranscript("Test Sam: Hi all, this is the Bluefin launch review.\nTest Kim: Thanks. The banner is late.\nTest Sam: Okay.");
  assert.equal(nameFor(p, { day: "2026-11-10" }), "Bluefin launch review, 10 Nov 2026");
  assert.match(summaryOf(p), /^2 people spoke: Test Sam and Test Kim\./);
  const q = parseTranscript("Today we will talk about the hiring plan for Q1.\nWe need two designers.\nMeera will post the job.");
  assert.equal(nameFor(q, { day: "2026-11-10" }), "Hiring plan for Q1, 10 Nov 2026");
});

test("readable text reads back to the same lines", () => {
  const p = parseTranscript("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v Asha Synthetic>First synthetic line.\n\n00:00:09.000 --> 00:00:10.000\n<v Ravi Example>Second synthetic line.\n");
  const text = readable(p.lines);
  assert.equal(text, "[0:01] Asha Synthetic: First synthetic line.\n[0:09] Ravi Example: Second synthetic line.");
  assert.deepEqual(parseTranscript(text).lines, p.lines);
});

test("the summary says who spoke, what about, and what was decided", () => {
  const p = parseTranscript(`Asha Synthetic: The synthetic brochure needs new photos.
Ravi Example: The brochure photos come from the synthetic shoot.
Asha Synthetic: We agreed to print the brochure next week.`);
  const s = summaryOf(p);
  assert.match(s, /^2 people spoke: Asha and Ravi\./);
  assert.match(s, /mostly about brochure/);
  assert.match(s, /Decision: We agreed to print the brochure next week\./);
  assert.ok(s.length <= 600);
});

test("Narrate a problem: the page named, a bug report drafted", () => {
  const d = draftProblems("Okay so this doesn't scroll on the tasks page.");
  assert.equal(d.length, 1);
  assert.deepEqual([d[0].kind, d[0].route, d[0].title], ["bug", "/tasks", "Tasks: This doesn't scroll"]);
  // Two problems on two pages; a request is a task.
  const two = draftProblems("The billing button is cut off on my phone. Also on the chats page the send button does nothing happens. Can we add a dark mode to my day?");
  assert.deepEqual(two.map((x) => [x.kind, x.route]), [["bug", "/erp"], ["bug", "/chats"], ["task", "/my-day"]]);
  // No page in the words: the page it was started from.
  const from = draftProblems("The save button is missing here.", { from: "/clients/abc" });
  assert.deepEqual([from[0].kind, from[0].route, from[0].title], ["bug", "/clients", "Clients: The save button is missing here"]);
  // More words about the same problem stay with it.
  const more = draftProblems("The tasks page doesn't scroll. It stops halfway. It also doesn't scroll on tasks with a long list.");
  assert.equal(more.length, 1);
  assert.match(more[0].quote, /stops halfway/);
  assert.equal(problemName(two, "2026-11-09"), "3 problems on Billing, 9 Nov 2026");
  assert.equal(pageFor("/tasks/projects/x")?.label, "Projects");
  assert.equal(pageFor("javascript:alert(1)"), null);
});

test("importInput: checks the text, names it and summarises it; a problem names its page", () => {
  assert.throws(() => importInput({ text: "  " }, "2026-11-09"), /Paste the transcript/);
  assert.throws(() => importInput({ text: "x".repeat(400_001) }, "2026-11-09"), /too long/);
  const r = importInput({ text: "Asha Synthetic: We agreed on the synthetic plan.\nRavi Example: I will send it by Monday.", fileName: "../../etc/passwd" }, "2026-11-09");
  assert.equal(r.fileName, null);
  assert.equal(r.purpose, "meeting");
  assert.equal(r.title, "Meeting with Asha and Ravi, 9 Nov 2026");
  assert.match(r.summary, /2 people spoke/);
  const typed = importInput({ text: "Notes about the synthetic plan.", title: " My own\u0007 name " }, "2026-11-09");
  assert.equal(typed.title, "My own name");
  const prob = importInput({ text: "this doesn't scroll on the tasks page", purpose: "problem", from: "javascript:x" }, "2026-11-09");
  assert.equal(prob.from, null);
  assert.equal(prob.title, "A problem on Tasks, 9 Nov 2026");
  assert.equal(prob.drafts[0].route, "/tasks");
  assert.equal(prob.summary, null);
});

test("with speakers, a line's I is its speaker; a speaker who is not a colleague names nobody", () => {
  const people = [{ id: "p-asha", name: "Asha Synthetic" }, { id: "p-ravi", name: "Ravi Example" }, { id: "p-me", name: "Meera Testcase" }];
  assert.equal(speakerId("Ravi", people), "p-ravi");
  assert.equal(speakerId("asha synthetic", people), "p-asha");
  assert.equal(speakerId("Guest Client", people), null);
  const lines = parseTranscript(`Ravi Example: The photos are ready. I will upload them tomorrow.
Guest Client: I will send the signed form by Friday.
Asha Synthetic: Ravi will call the printer on Monday.`).lines;
  const a = actionsOf(lines, { today: "2026-11-06", people, me: "p-me" });
  assert.deepEqual(a.map((x) => [x.title, x.assigneeId]), [["Upload them", "p-ravi"], ["Send the signed form", null], ["Call the printer", "p-ravi"]]);
  // No speakers: as slice 4 reads notes ("I" is the person who brought it in).
  assert.equal(actionsOf([{ text: "I will share the deck by Monday." }], { today: "2026-11-06", people, me: "p-me" })[0].assigneeId, "p-me");
});
