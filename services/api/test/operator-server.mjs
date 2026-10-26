// The real API on the scratch database for tests/core/test_operator_init.py: listens on a free local port and prints
// "operator-server listening <port>". PULSE_OPERATOR_TOKEN is read from the environment like in production.
import { Pool } from "pg";
import { createApp } from "../dist/app.js";

const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG));
const app = createApp(pool, pool);
await app.listen({ host: "127.0.0.1", port: 0 });
process.stdout.write(`operator-server listening ${app.server.address().port}\n`);
const stop = async () => { await app.close(); await pool.end(); process.exit(0); };
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
