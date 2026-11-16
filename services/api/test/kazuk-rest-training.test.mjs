import assert from "node:assert/strict";
import test from "node:test";
import { assignInput, byteRange, courseInput, quizInput, uploadInput, videoLink, MAX_UPLOAD } from "../dist/training.js";

test("a video link is https to a public page; the provider decides how it opens", () => {
  assert.deepEqual(videoLink(" https://www.youtube.com/watch?v=SYNTHETIC01 "), { url: "https://www.youtube.com/watch?v=SYNTHETIC01", provider: "youtube" });
  assert.equal(videoLink("https://youtu.be/SYNTHETIC01").provider, "youtube");
  assert.equal(videoLink("https://vimeo.com/000000001").provider, "vimeo");
  assert.equal(videoLink("https://drive.google.com/file/d/SYNTHETIC/view").provider, "drive");
  assert.equal(videoLink("https://video.example.test/course/intro").provider, "web");
  for (const bad of ["http://video.example.test/a", "javascript:alert(1)", "https://user:pw@video.example.test/a", "https://127.0.0.1/a", "https://localhost/a",
    "https://intranet/a", "https://video.example.test:8443/a", "ftp://video.example.test/a", "", "not a link"])
    assert.throws(() => videoLink(bad), /link|https|public|share/i, bad);
  assert.throws(() => videoLink(`https://video.example.test/${"a".repeat(600)}`), /too long/);
});

test("a course needs a title; the pass mark is 1 to 100; the status is draft, published or archived", () => {
  assert.deepEqual(courseInput({ title: "  Synthetic starter kit\u0007 ", summary: "Line one\nline two", passMark: 80, status: "published" }),
    { title: "Synthetic starter kit", summary: "Line one\nline two", passMark: 80, status: "published" });
  assert.equal(courseInput({ title: "x" }).passMark, 70);
  assert.equal(courseInput({ title: "x" }).status, "draft");
  assert.throws(() => courseInput({ title: " " }), /title/);
  assert.throws(() => courseInput({ title: "x", passMark: 0 }), /pass mark/);
  assert.throws(() => courseInput({ title: "x", passMark: 50.5 }), /pass mark/);
  assert.throws(() => courseInput({ title: "x", status: "live" }), /draft, published or archived/);
});

test("a quiz has up to 20 questions, each with 2 to 6 choices and the right one marked", () => {
  const q = quizInput({ questions: [{ prompt: " Which cable is synthetic? ", options: ["Red", " ", "Blue", "Green"], answer: 1 }] });
  assert.deepEqual(q, [{ prompt: "Which cable is synthetic?", options: ["Red", "Blue", "Green"], answer: 1 }]);
  assert.throws(() => quizInput({ questions: [{ prompt: "a", options: ["only one"], answer: 0 }] }), /2 to 6 choices/);
  assert.throws(() => quizInput({ questions: [{ prompt: "a", options: ["x", "y"], answer: 2 }] }), /right choice/);
  assert.throws(() => quizInput({ questions: [{ prompt: "", options: ["x", "y"], answer: 0 }] }), /Write question 1/);
  assert.throws(() => quizInput({ questions: Array.from({ length: 21 }, () => ({ prompt: "a", options: ["x", "y"], answer: 0 })) }), /up to 20/);
  assert.deepEqual(quizInput({ questions: [] }), []);
});

test("a course is assigned to a person, a group (channel partners and dealers) or a role", () => {
  const pid = ["0f4c2d6e", "aaaa", "4bbb", "8ccc", "dddddddddddd"].join("-");
  assert.deepEqual(assignInput({ kind: "person", personId: pid, dueOn: "2026-12-01" }), { kind: "person", personId: pid, target: null, dueOn: "2026-12-01" });
  assert.deepEqual(assignInput({ kind: "side", target: "channel_partner" }), { kind: "side", personId: null, target: "channel_partner", dueOn: null });
  assert.deepEqual(assignInput({ kind: "role", target: "pod_head", dueOn: "" }), { kind: "role", personId: null, target: "pod_head", dueOn: null });
  assert.throws(() => assignInput({ kind: "side", target: "client" }), /person, a group or a role/);
  assert.throws(() => assignInput({ kind: "role", target: "admin" }), /person, a group or a role/);
  assert.throws(() => assignInput({ kind: "person", personId: "x" }), /person/);
  assert.throws(() => assignInput({ kind: "side", target: "staff", dueOn: "1 Dec" }), /due day/);
});

test("an upload is an MP4, WebM or MOV up to 25 MB, sent as base64", () => {
  const ok = uploadInput({ mime: "video/mp4", name: "../synthetic clip.mp4", bytes: Buffer.from("synthetic").toString("base64") });
  assert.equal(ok.bytes.toString(), "synthetic");
  assert.equal(ok.name, ".._synthetic clip.mp4");
  assert.throws(() => uploadInput({ mime: "image/png", bytes: "AAAA" }), /MP4, WebM or MOV/);
  assert.throws(() => uploadInput({ mime: "video/mp4", bytes: "not base64!" }), /video file/);
  assert.throws(() => uploadInput({ mime: "video/mp4", bytes: "A".repeat(Math.ceil(MAX_UPLOAD / 3) * 4 + 4) }), /25 MB/);
});

test("byte ranges let the player seek in an uploaded clip", () => {
  assert.equal(byteRange(undefined, 100), null);
  assert.deepEqual(byteRange("bytes=0-9", 100), { start: 0, end: 9 });
  assert.deepEqual(byteRange("bytes=90-", 100), { start: 90, end: 99 });
  assert.deepEqual(byteRange("bytes=-10", 100), { start: 90, end: 99 });
  assert.deepEqual(byteRange("bytes=50-500", 100), { start: 50, end: 99 });
  assert.equal(byteRange("bytes=100-", 100), "invalid");
  assert.equal(byteRange("bytes=", 100), null);
});
