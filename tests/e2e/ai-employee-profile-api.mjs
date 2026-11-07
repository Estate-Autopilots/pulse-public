// Synthetic profile contract overlay; all other shell requests use the existing synthetic API.
import { createServer } from "node:http";

createServer(async (request, response) => {
  const path = new URL(request.url, "http://localhost").pathname;
  const id = path.match(/^\/api\/v0\/agents\/([^/]+)$/)?.[1];
  const reply = (status, data) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(data)); };
  if (id || path === "/api/v0/people/synthetic-hidden") {
    if (["synthetic-hidden", "synthetic-unknown"].includes(id) || !id) return reply(404, { error: "Not found" });
    if (id === "synthetic-unavailable") return reply(503, { error: "Synthetic service unavailable" });
    if (id === "synthetic-slow") await new Promise((resolve) => setTimeout(resolve, 2500));
    return reply(200, {
      id, employeeId: "NW-AI-001", name: "Synthetic Studio Assistant", orgName: "Northwind Studio", orgCode: "NW",
      owner: { id: "synthetic-owner", name: "Synthetic Owner" }, title: "Creative assistant",
      lane: id === "synthetic-quick" ? "quick" : "thinking", model: "Synthetic runtime",
      status: id === "synthetic-paused" ? "paused" : id === "synthetic-off" ? "off" : "on",
      pausedReason: id === "synthetic-paused" ? "Daily budget reached" : null,
      dailyBudget: id === "synthetic-zero" ? 0 : 160000,
      usedToday: id === "synthetic-zero" ? 0 : id === "synthetic-over" ? 180000 : 40000,
    });
  }
  try {
    const upstream = await fetch(`${process.env.PROFILE_SHELL_API}${request.url}`, { headers: request.headers, signal: AbortSignal.timeout(5000) });
    response.writeHead(upstream.status, { "Content-Type": "application/json" });
    response.end(await upstream.text());
  } catch { reply(503, { error: "Synthetic shell unavailable" }); }
}).listen(Number(process.env.PORT), "127.0.0.1");
