import { serve } from "@hono/node-server";
import { createAdminClient } from "@sb/db";
import { createLogger } from "@sb/observability";

import { createWorkerApp } from "./app.js";
import { loadEnv } from "./env.js";
import { createErpImportParseHandler } from "./handlers/erp-import-parse.js";
import { withHandlers } from "./router.js";
import { createSheetReader } from "./sheet-reader.js";

const env = loadEnv();
const logger = createLogger({ service: "worker", env: env.NODE_ENV });

const db = createAdminClient({
  supabaseUrl: env.SUPABASE_URL,
  serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
});

const app = createWorkerApp({
  logger,
  db,
  registry: withHandlers({
    "erp.import.parse": createErpImportParseHandler({
      db,
      reader: createSheetReader(env.ERP_IMPORTS_BUCKET),
    }),
  }),
});

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  logger.info("worker_started", { port: info.port });
});
