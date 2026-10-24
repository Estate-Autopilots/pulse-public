// Synthetic counts overlay; never connects to a real tenant.
import { createServer } from "node:http";
createServer(async (req, res) => {
  try {
    const email = req.headers["cf-access-authenticated-user-email"] ?? "";
    const headers = { ...req.headers, "cf-access-authenticated-user-email": email.startsWith("zero@") || email.startsWith("legacy@") ? "admin@northwind-on.example" : email };
    const upstream = await fetch(`${process.env.COUNTS_SHELL_API}${req.url}`, { headers, signal: AbortSignal.timeout(5000) });
    const body = await upstream.json(), path = new URL(req.url, "http://localhost").pathname;
    const ai = email.startsWith("zero@") ? 0 : email.startsWith("legacy@") ? undefined : 3;
    if (path === "/api/v0/hr/desk") body.counts = { ...body.counts, ai };
    if (path === "/api/v0/insights") body.people = { ...body.people, ai };
    if (path === "/api/v0/home") body.people = { headcount: 3, ai };
    res.writeHead(upstream.status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body));
  } catch { res.writeHead(503); res.end(JSON.stringify({ error: "Synthetic service unavailable" })); }
}).listen(Number(process.env.PORT), "127.0.0.1");
