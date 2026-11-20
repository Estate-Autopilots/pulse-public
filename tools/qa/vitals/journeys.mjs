#!/usr/bin/env node
// QA-2 (QA system stage 1, step 8b; research §4.5 "Journeys"): Vitals' journeys, nightly on DEV, in the QA company
// only (synthetic people; dev is a throwaway copy, so these journeys may write there; never on production).
// Each actor has its own sign-in (a separate session), as two people on two phones.
//
//   1. chat:  the owner writes to the seller; the seller sees it and answers; the owner sees the answer.
//   2. call:  the owner calls the seller in that chat (POST /calls), the seller sees it ring and answers, and two real
//             browser pages (on nivi, fake microphones) connect audio through the app's own signalling (/calls/:id/signal
//             and /calls/events/next) with the app's ICE servers; then once more with relay only (TURN), the path two
//             phones on different networks take.
//   3. quote: the seller drafts a quotation for a synthetic client and asks the owner to approve it; the owner approves;
//             the approved quotation's PDF can be fetched by the seller. Target: under a minute.
//
//   4. wl-*:  Willow Lane's working day (WL-FLOWS, wl-flows.mjs): lead, quotation with its PDF in the seller's chat,
//             approval (by the rule up to ₹10 lakh, else the owner), proforma, task, follow-up, reminder, check-in.
//
//   node tools/qa/vitals/journeys.mjs [--only chat,call,quote,wl] [--out DIR]     ("wl" is every wl-* journey)
// Output: <out>/journeys.json, stdout one line per journey. Exit 0 all passed, 1 a journey failed, 2 could not run.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { qaBrowser } from "./nivi-browser.mjs";
import { parseArgs, vitalsEnv } from "./vitals-env.mjs";
import { WL_FLOWS, wlFlows } from "./wl-flows.mjs";

const args = parseArgs(process.argv.slice(2));
const V = vitalsEnv("dev", { credentials: args.credentials });
if (!V.DEV) throw new Error("journeys run on dev only");
const OUT = args.out || path.join(os.homedir(), ".local/state/vitals-qa/journeys", new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19));
fs.mkdirSync(OUT, { recursive: true });
const ONLY = (args.only || "chat,call,quote,wl").split(",").flatMap((n) => (n === "wl" ? WL_FLOWS : [n]));
const log = (m) => process.stderr.write(`${new Date().toISOString().slice(11, 19)} ${m}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Step extends Error { constructor(step, detail) { super(`${step}: ${detail}`); this.step = step; this.detail = detail; } }
const must = (r, step, ok = (x) => x.status === 200) => { if (!ok(r)) throw new Step(step, `${r.status} ${String(r.json?.error || r.text || "").replace(/\s+/g, " ").slice(0, 160)}`); return r.json; };

// Two people, each signed in on their own.
const people = {};
async function person(role) {
  if (people[role]) return people[role];
  const s = await V.signIn(role);
  if (s.error) throw new Step(`${role} signs in`, s.error);
  const as = (p, o = {}) => V.call(p, { ...o, cookies: { pulse_session: s.jar.pulse_session } });
  const me = must(await as("/api/v0/me"), `${role} /me`);
  people[role] = { role, jar: s.jar, as, id: me.person?.id || me.personId || me.person, name: me.person?.name || me.name };
  if (typeof people[role].id !== "string") throw new Step(`${role} /me`, "no person id");
  return people[role];
}

async function direct(a, b) {
  const r = must(await a.as("/api/v0/chats/direct", { body: { personId: b.id } }), "open the direct chat");
  return r.id;
}
const messagesOf = async (p, chat) => { const r = must(await p.as(`/api/v0/chats/${chat}/messages`), `${p.role} reads the chat`); return Array.isArray(r) ? r : r.messages || r.items || []; };
async function waitFor(fn, ms, step) {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return { v, ms: Date.now() - t0 }; if (Date.now() - t0 > ms) throw new Step(step, `not within ${ms / 1000} s`); await sleep(700); }
}

async function chatJourney() {
  const owner = await person("owner"), seller = await person("seller");
  const chat = await direct(owner, seller);
  const token = `QA journey ${randomUUID().slice(0, 8)}`;
  const t0 = Date.now();
  must(await owner.as(`/api/v0/chats/${chat}/messages`, { body: { body: `${token}: hello from the owner`, clientId: randomUUID() } }), "owner sends");
  const got = await waitFor(async () => (await messagesOf(seller, chat)).find((m) => String(m.body || m.text || "").includes(token)), 20_000, "seller sees the message");
  must(await seller.as(`/api/v0/chats/${chat}/messages`, { body: { body: `${token}: reply from the seller`, clientId: randomUUID() } }), "seller answers");
  const back = await waitFor(async () => (await messagesOf(owner, chat)).find((m) => String(m.body || m.text || "").includes(`${token}: reply`)), 20_000, "owner sees the answer");
  return { chat, seenMs: got.ms, replyMs: back.ms, totalMs: Date.now() - t0 };
}

// ---- the call: real WebRTC in two pages, signalled through the app ----
const PAGE = "https://qa-call.invalid/";
async function callPage(browser) {
  const ctx = await browser.newContext({ permissions: ["microphone"] });
  await ctx.route(`${PAGE}**`, (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>QA call</title><p>QA call</p>" }));
  const page = await ctx.newPage();
  await page.goto(PAGE);
  return { ctx, page };
}
const peerSetup = async ({ ice, relay, offerer }) => {
  const pc = new RTCPeerConnection({ iceServers: ice, iceTransportPolicy: relay ? "relay" : "all" });
  window.__pc = pc; window.__out = []; window.__cands = [];
  pc.onicecandidate = (e) => { if (e.candidate) window.__out.push({ kind: "candidate", body: e.candidate.toJSON() }); };
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  for (const t of stream.getTracks()) pc.addTrack(t, stream);
  if (offerer) { const o = await pc.createOffer(); await pc.setLocalDescription(o); window.__out.push({ kind: "description", body: { type: o.type, sdp: o.sdp } }); }
  return true;
};
const peerTake = async (signals) => {
  const pc = window.__pc;
  for (const s of signals) {
    if (s.kind === "description") {
      await pc.setRemoteDescription(s.body);
      for (const c of window.__cands.splice(0)) await pc.addIceCandidate(c).catch(() => {});
      if (s.body.type === "offer") { const a = await pc.createAnswer(); await pc.setLocalDescription(a); window.__out.push({ kind: "description", body: { type: a.type, sdp: a.sdp } }); }
    } else if (s.kind === "candidate") {
      if (pc.remoteDescription) await pc.addIceCandidate(s.body).catch(() => {}); else window.__cands.push(s.body);
    }
  }
  return true;
};
const peerState = async () => {
  const pc = window.__pc; let bytes = 0, path = "";
  const stats = await pc.getStats();
  stats.forEach((s) => { if (s.type === "inbound-rtp" && s.kind === "audio") bytes += s.bytesReceived || 0; });
  stats.forEach((s) => { if (s.type === "candidate-pair" && s.nominated && s.state === "succeeded") { const l = stats.get(s.localCandidateId); path = l?.candidateType || ""; } });
  return { state: pc.connectionState, ice: pc.iceConnectionState, bytes, path };
};
const peerOut = () => window.__out.splice(0);

async function callOnce(browser, owner, seller, chat, relay) {
  const start = must(await owner.as("/api/v0/calls", { body: { channelId: chat, video: false } }), "owner places the call");
  const callId = start.call?.id;
  if (!callId) throw new Step("owner places the call", "no call id");
  if (relay && !start.relay) return { skipped: "this server offers no TURN relay (PULSE_TURN_URLS)" };
  const t0 = Date.now();
  // The seller's events: the ring, then the owner's signals.
  let cursor = must(await seller.as("/api/v0/calls/events/next"), "seller reads call events").cursor;
  const ring = await waitFor(async () => { const r = must(await seller.as("/api/v0/calls"), "seller lists calls"); const list = Array.isArray(r) ? r : r.calls || []; return list.find((c) => c.id === callId); }, 15_000, "the call rings at the seller");
  const ans = must(await seller.as(`/api/v0/calls/${callId}/answer`, { body: {} }), "seller answers");
  let ownerCursor = must(await owner.as("/api/v0/calls/events/next"), "owner reads call events").cursor;
  const A = await callPage(browser), B = await callPage(browser);
  try {
    await A.page.evaluate(peerSetup, { ice: start.iceServers, relay, offerer: true });
    await B.page.evaluate(peerSetup, { ice: ans.iceServers, relay, offerer: false });
    const pump = async (fromPage, fromPerson, toPerson) => {
      const out = await fromPage.evaluate(peerOut);
      for (let i = 0; i < out.length; i += 50) must(await fromPerson.as(`/api/v0/calls/${callId}/signal`, { body: { signals: out.slice(i, i + 50).map((s) => ({ ...s, to: toPerson.id })) } }), `${fromPerson.role} sends signals`);
    };
    const drain = async (p, cur, page) => {
      const r = must(await p.as(`/api/v0/calls/events/next?after=${cur}`), `${p.role} reads signals`);
      const sig = (r.events || []).filter((e) => e.event === "signal" && e.data?.callId === callId).map((e) => ({ kind: e.data.kind, body: e.data.body }));
      if (sig.length) await page.evaluate(peerTake, sig);
      return r.cursor;
    };
    let last = { state: "new" };
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      await pump(A.page, owner, seller); cursor = await drain(seller, cursor, B.page);
      await pump(B.page, seller, owner); ownerCursor = await drain(owner, ownerCursor, A.page);
      const a = await A.page.evaluate(peerState), b = await B.page.evaluate(peerState);
      last = { owner: a, seller: b };
      if (a.state === "connected" && b.state === "connected" && b.bytes > 2000 && a.bytes > 2000) break;
      if (a.state === "failed" || b.state === "failed") break;
      await sleep(600);
    }
    const ok = last.owner?.state === "connected" && last.seller?.state === "connected" && last.seller.bytes > 2000 && last.owner.bytes > 2000;
    if (!ok) throw new Step(relay ? "audio connects through the relay (TURN)" : "audio connects", JSON.stringify(last).slice(0, 220));
    return { callId, ringMs: ring.ms, connectMs: Date.now() - t0, path: last.seller.path, audioBytes: { owner: last.owner.bytes, seller: last.seller.bytes } };
  } finally {
    await owner.as(`/api/v0/calls/${callId}/leave`, { body: {} }).catch(() => null);
    await seller.as(`/api/v0/calls/${callId}/leave`, { body: {} }).catch(() => null);
    await A.ctx.close().catch(() => {}); await B.ctx.close().catch(() => {});
  }
}

async function callJourney(browser) {
  const owner = await person("owner"), seller = await person("seller");
  const chat = await direct(owner, seller);
  const direct_ = await callOnce(browser, owner, seller, chat, false);
  const relayed = await callOnce(browser, owner, seller, chat, true);
  return { direct: direct_, relay: relayed };
}

async function quoteJourney() {
  const owner = await person("owner"), seller = await person("seller");
  const t0 = Date.now();
  // A synthetic client and one line, drafted by the seller.
  const parties = must(await seller.as("/api/v0/erp/parties?q=QA%20Journey%20Client"), "seller finds the client");
  let client = (parties.clients || []).find((p) => p.name === "QA Journey Client (synthetic)");
  if (!client) {
    // Only an admin adds a client (records.ts); the owner sets the synthetic client up once.
    const made = must(await owner.as("/api/v0/clients", { body: { kind: "company", companyName: "QA Journey Client (synthetic)" } }), "owner adds the synthetic client (once)", (r) => r.status === 200 || r.status === 201);
    client = { id: made.id || made.client?.id || made.clientId };
  }
  const doc = must(await seller.as("/api/v0/erp/documents", { body: { docType: "quotation", clientId: client.id } }), "seller drafts the quotation");
  const docId = doc.id || doc.document?.id;
  // FIX-BILLING (BC-066): the company's day (India), not UTC's: from 00:00 to 05:30 IST a UTC date was yesterday's and the
  // series refused it ("The last quotation in this series is dated 19 Nov 2026; date this one on or after it").
  const day = (n) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(Date.now() + n * 86400_000));
  const draft = { issueDate: day(0), validUntil: day(15), buyer: { name: "QA Journey Client (synthetic)", stateCode: "27" }, lines: [{ description: "QA journey item (synthetic)", qty: 1, rate: 1000, gstRate: 18, unit: "Nos" }] };
  must(await seller.as(`/api/v0/erp/documents/${docId}/approval`, { body: { to: owner.id, note: "QA journey: please approve", draft } }), "seller asks the owner to approve");
  // QUOTE-FAST (2380): "Approve the quotation for …" (billing.approval) reaches the approver's bell with Approve on it.
  const notices = async (p) => { const r = must(await p.as("/api/v0/notices"), `${p.role} reads the bell`); return JSON.stringify(r); };
  const asked = await waitFor(async () => (await notices(owner)).includes(docId), 30_000, "the approval reaches the owner's bell");
  // Approve = number and file it (what the bell's Approve and the document's page do).
  must(await owner.as(`/api/v0/erp/documents/${docId}/issue`, { body: {} }), "owner approves (issues) the quotation");
  const issued = await waitFor(async () => { const d = must(await seller.as(`/api/v0/erp/documents/${docId}`), "seller reads the quotation"); const s = d.document?.status || d.status; return s && s !== "draft" ? s : null; }, 30_000, "the seller sees it approved");
  const told = await waitFor(async () => (await notices(seller)).includes(docId), 30_000, "the seller is told it is approved (billing.approved)").catch((e) => ({ missing: e.message }));
  const pdf = await seller.as(`/api/v0/erp/documents/${docId}/pdf`);
  if (pdf.status !== 200 || !pdf.text.startsWith("%PDF")) throw new Step("the seller gets the PDF", `${pdf.status} ${pdf.text.slice(0, 40)}`);
  const totalMs = Date.now() - t0;
  if (told.missing) throw new Step("the seller is told it is approved (billing.approved)", told.missing);
  if (totalMs > 60_000) throw new Step("under a minute", `${Math.round(totalMs / 1000)} s`);
  // Not covered here: the AI employee posting the PDF into the seller's chat (needs the model; the AI task set's part).
  return { docId, status: issued.v, askedMs: asked.ms, totalMs };
}

const wl = wlFlows({ V, person, must, waitFor, Step, sleep, log, credentials: args.credentials });

const t0 = Date.now();
const out = [];
let qb;
for (const sig of ["SIGTERM", "SIGINT"]) process.once(sig, async () => { if (qb) await qb.close(); for (const p of Object.values(people)) await V.signOut(p.jar); process.exit(143); });
try {
  for (const name of ONLY) {
    const roles = name.startsWith("wl-") ? ["owner", "seller", "finance", "bhrātā (QA copy)", "Artha (QA copy)"] : ["owner", "seller"];
    log(`journey ${name}`);
    try {
      let detail;
      if (name === "chat") detail = await chatJourney();
      else if (name === "call") { qb = qb || await qaBrowser({ ttl: 900, slot: false, log }); /* two light pages for a minute: beside the build slots */ detail = await callJourney(qb.browser); }
      else if (name === "quote") detail = await quoteJourney();
      else if (wl[name]) detail = await wl[name]();
      else throw new Step("journey", `unknown journey ${name}`);
      out.push({ name, ok: true, roles, detail });
    } catch (e) {
      out.push({ name, ok: false, roles, failedStep: e.step || "error", detail: e.detail || String(e.message).split("\n")[0].slice(0, 200) });
    }
  }
} finally {
  for (const p of Object.values(people)) await V.signOut(p.jar);
  if (qb) await qb.close();
}
fs.writeFileSync(path.join(OUT, "journeys.json"), JSON.stringify({ at: new Date().toISOString(), env: "dev", org: V.creds.org.handle, browser: qb?.where || null, seconds: Math.round((Date.now() - t0) / 1000), journeys: out }, null, 1));
const lines = out.map((j) => `${j.ok ? "ok  " : "FAIL"} ${j.name.padEnd(6)} ${j.ok ? JSON.stringify(j.detail).slice(0, 200) : `${j.failedStep}: ${j.detail}`}`);
console.log([`journeys dev (${Math.round((Date.now() - t0) / 1000)} s)`, ...lines].join("\n"));
process.exit(out.every((j) => j.ok) ? 0 : 1);
