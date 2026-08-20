import { serve } from "@hono/node-server";
import { createLogger } from "@sb/observability";

import { createApp } from "./app.js";
import { createEnqueuer } from "./enqueue.js";
import { loadEnv } from "./env.js";
import { createOidcVerifier } from "./oidc.js";

const env = loadEnv();
const logger = createLogger({ service: "api", env: env.NODE_ENV });

const app = createApp({
  logger,
  enqueuer: createEnqueuer(env),
  oidc: createOidcVerifier({
    audience: env.API_URL,
    allowedServiceAccounts: [env.SCHEDULER_INVOKER_SERVICE_ACCOUNT],
  }),
});

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  logger.info("api_started", { port: info.port });
});
