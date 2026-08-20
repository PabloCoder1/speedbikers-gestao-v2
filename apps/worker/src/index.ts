import { serve } from "@hono/node-server";
import { createAdminClient } from "@sb/db";
import { createLogger } from "@sb/observability";

import { createWorkerApp } from "./app.js";
import { loadEnv } from "./env.js";

const env = loadEnv();
const logger = createLogger({ service: "worker", env: env.NODE_ENV });

const app = createWorkerApp({
  logger,
  db: createAdminClient({
    supabaseUrl: env.SUPABASE_URL,
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
  }),
});

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  logger.info("worker_started", { port: info.port });
});
