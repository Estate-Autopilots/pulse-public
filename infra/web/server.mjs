import { createReadStream } from "node:fs";
import { createServer, get, request as httpRequest } from "node:http";
import { fileURLToPath } from "node:url";

const port = Number(process.env.WEB_PORT ?? 8080);
const apiHost = process.env.API_HOST ?? "127.0.0.1";
const apiPort = Number(process.env.API_PORT ?? 8081);
const ingestHost = process.env.INGEST_HOST ?? "127.0.0.1";
const ingestPort = Number(process.env.INGEST_PORT ?? 8082);
const pagePath = fileURLToPath(new URL("./index.html", import.meta.url));

const server = createServer((incoming, outgoing) => {
  const path = new URL(incoming.url ?? "/", "http://localhost").pathname;

  if (path === "/healthz") {
    const healthRequest = get({ hostname: apiHost, port: apiPort, path: "/healthz" }, (upstream) => {
      const headers = { "cache-control": "no-store" };
      if (upstream.headers["content-type"]) headers["content-type"] = upstream.headers["content-type"];
      outgoing.writeHead(upstream.statusCode ?? 503, headers);
      upstream.pipe(outgoing);
    });
    healthRequest.on("error", () => {
      if (!outgoing.headersSent) {
        outgoing.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
      }
      outgoing.end(JSON.stringify({ status: "unavailable", part: "api" }));
    });
    return;
  }

  const upstream = path === "/api" || path.startsWith("/api/")
    ? { host: apiHost, port: apiPort, part: "api" }
    : path === "/v1" || path.startsWith("/v1/")
      ? { host: ingestHost, port: ingestPort, part: "ingest" }
      : null;

  if (upstream) {
    const proxyRequest = httpRequest(
      {
        hostname: upstream.host,
        port: upstream.port,
        path: incoming.url ?? "/",
        method: incoming.method,
        headers: incoming.headers,
      },
      (upstream) => {
        outgoing.writeHead(upstream.statusCode ?? 502, upstream.headers);
        upstream.pipe(outgoing);
      },
    );
    proxyRequest.on("error", () => {
      if (!outgoing.headersSent) {
        outgoing.writeHead(502, { "content-type": "application/json" });
      }
      outgoing.end(JSON.stringify({ status: "unavailable", part: upstream.part }));
    });
    incoming.pipe(proxyRequest);
    return;
  }

  if (path === "/" && (incoming.method === "GET" || incoming.method === "HEAD")) {
    outgoing.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    if (incoming.method === "HEAD") outgoing.end();
    else createReadStream(pagePath).pipe(outgoing);
    return;
  }

  outgoing.writeHead(404, { "content-type": "application/json" });
  outgoing.end(JSON.stringify({ error: "not_found" }));
});

server.listen(port, "0.0.0.0", () => {
  const address = server.address();
  const listeningPort = typeof address === "object" && address ? address.port : port;
  console.log(`Pulse placeholder web server listening on ${listeningPort}`);
});

function close() {
  server.close(() => process.exit(0));
}
process.once("SIGINT", close);
process.once("SIGTERM", close);
