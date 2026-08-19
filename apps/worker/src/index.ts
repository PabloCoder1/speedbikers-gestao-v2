import { serve } from "@hono/node-server";
import { createLogger } from "@sb/observability";

import { createWorkerApp } from "./app.js";
import { loadEnv } from "./env.js";

const env = loadEnv();
const logger = createLogger({ service: "worker", env: env.NODE_ENV });

const app = createWorkerApp({ logger });

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  logger.info("worker_started", { port: info.port });
});
