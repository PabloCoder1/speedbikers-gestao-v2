import { serve } from "@hono/node-server";
import { createAdminClient } from "@sb/db";
import { createLogger } from "@sb/observability";

import { createApp } from "./app.js";
import { createAuthenticator } from "./auth.js";
import { createEnqueuer } from "./enqueue.js";
import { loadEnv } from "./env.js";
import { createOidcVerifier } from "./oidc.js";
import { createFileStore } from "./storage.js";

const env = loadEnv();
const logger = createLogger({ service: "api", env: env.NODE_ENV });

const db = createAdminClient({
  supabaseUrl: env.SUPABASE_URL,
  serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
});

const enqueuer = createEnqueuer(env);

const app = createApp({
  logger,
  enqueuer,
  webOrigins: (env.WEB_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin !== ""),
  oidc: createOidcVerifier({
    audience: env.API_URL,
    allowedServiceAccounts: [env.SCHEDULER_INVOKER_SERVICE_ACCOUNT],
  }),
  auth: createAuthenticator(db),
  importDeps: {
    db,
    enqueuer,
    logger,
    store: createFileStore(env.ERP_IMPORTS_BUCKET),
  },
});

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  logger.info("api_started", { port: info.port });
});
