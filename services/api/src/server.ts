import { drainWebPush } from "./web-push.js";
import { Pool } from "pg";
import { createApp } from "./app.js";
import { installServerTiming } from "./telemetry.js";
import { apiPoolConfig } from "./database.js";
import { assertConfiguredOrg, installationFor } from "./installation.js";

const pool = new Pool(apiPoolConfig());
const installation = installationFor(pool);
assertConfiguredOrg(process.env.PULSE_ORG_ID, await installation.readOrg());
const app = createApp(pool, pool, undefined, installation);
// TELEMETRY: every API request's route, status, duration and database time, written in batches off the request path.
installServerTiming(app, pool);
pool.on("error", (error: NodeJS.ErrnoException) => {
  app.log.error({ code: error.code ?? "unknown" }, "Idle PostgreSQL client failed");
});

const port = Number(process.env.PORT ?? 8081);
const host = process.env.HOST ?? "0.0.0.0";
await app.listen({ port, host });
app.log.info({ port }, "Pulse API listening");

// No provider calls without configured server credentials. One small serialized drain keeps health responsive.
const pushPool=process.env.PULSE_WEB_PUSH_PRIVATE_KEY_FILE&&process.env.PULSE_WEB_PUSH_PUBLIC_KEY
 ? new Pool({connectionString:process.env.PULSE_DATABASE_URL_WORKER??process.env.DATABASE_URL,
   ...(!process.env.PULSE_DATABASE_URL_WORKER?{options:'-c role=pulse_worker'}:{}),max:1}):null;
let pushing=false;
const pushTimer=pushPool?setInterval(()=>{if(pushing)return;pushing=true;void drainWebPush(pushPool).catch(()=>app.log.warn('Browser push delivery unavailable')).finally(()=>{pushing=false;});},2000):null;
let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  if(pushTimer)clearInterval(pushTimer);
  await app.close();
  if(pushPool)await pushPool.end();
  await pool.end();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
