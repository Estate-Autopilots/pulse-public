import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const serverPath = resolve(dirname(fileURLToPath(import.meta.url)), "../server.mjs");

async function createServiceStub(healthStatus) {
  const server = createServer((request, response) => {
    if (request.url === "/healthz") {
      response.writeHead(healthStatus, {
        "connection": "close",
        "content-type": "application/json",
      });
      response.end(JSON.stringify(healthStatus === 200 ? { status: "ok" } : { status: "unavailable" }));
      return;
    }

    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      response.writeHead(201, { "connection": "close", "content-type": "application/json" });
      response.end(JSON.stringify({
        method: request.method,
        url: request.url,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  let closed = false;
  return {
    port: server.address().port,
    async close() {
      if (closed) return;
      closed = true;
      const closeEvent = once(server, "close");
      server.close();
      server.closeAllConnections();
      await closeEvent;
    },
  };
}

async function startWeb(apiPort, ingestPort = apiPort) {
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      API_HOST: "127.0.0.1",
      API_PORT: String(apiPort),
      INGEST_HOST: "127.0.0.1",
      INGEST_PORT: String(ingestPort),
      WEB_PORT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const output = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const port = await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, listeningPort) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      output.close();
      if (error) reject(error);
      else resolve(listeningPort);
    };
    const timeout = setTimeout(() => {
      finish(new Error(`web server did not start: ${stderr}`));
    }, 5000);

    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => {
      finish(new Error(`web server exited before listening (${code ?? signal}): ${stderr}`));
    });
    output.on("line", (line) => {
      const match = line.match(/listening on (\d+)$/);
      if (match) finish(null, Number(match[1]));
    });
  }).catch(async (error) => {
    child.kill("SIGTERM");
    throw error;
  });

  return {
    port,
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    },
  };
}

async function withServers(healthStatus, run) {
  const api = await createServiceStub(healthStatus);
  const ingest = await createServiceStub(200);
  const web = await startWeb(api.port, ingest.port);
  try {
    await run(web, api, ingest);
  } finally {
    await Promise.all([web.close(), api.close(), ingest.close()]);
  }
}

test("/healthz returns 200 when the API is healthy", async () => {
  await withServers(200, async ({ port }) => {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok" });
  });
});

test("/healthz returns 503 when the API reports unavailable", async () => {
  await withServers(503, async ({ port }) => {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { status: "unavailable" });
  });
});

test("/healthz returns 503 with part api when the API is down", async () => {
  await withServers(200, async ({ port }, api) => {
    await api.close();
    const response = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { status: "unavailable", part: "api" });
  });
});

test("/api/x forwards method, path, query, and body", async () => {
  await withServers(200, async ({ port }) => {
    const body = '{"note":"keep this body"}';
    const response = await fetch(`http://127.0.0.1:${port}/api/x?keep=1`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { method: "POST", url: "/api/x?keep=1", body });
  });
});

test("/v1/events forwards method, path, query, and body to ingest", async () => {
  await withServers(200, async ({ port }) => {
    const body = '{"events":[{"id":"evt_test"}]}';
    const response = await fetch(`http://127.0.0.1:${port}/v1/events?cursor=next`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), {
      method: "POST",
      url: "/v1/events?cursor=next",
      body,
    });
  });
});

test("/v1/events returns 502 with part ingest when ingest is down", async () => {
  await withServers(200, async ({ port }, _api, ingest) => {
    await ingest.close();
    const response = await fetch(`http://127.0.0.1:${port}/v1/events`, {
      method: "POST",
      body: "{}",
    });

    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { status: "unavailable", part: "ingest" });
  });
});
