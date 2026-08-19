import { serve } from "@hono/node-server";
import { createLogger } from "@sb/observability";

import { createApp } from "./app.js";
import { loadEnv } from "./env.js";

const env = loadEnv();
const logger = createLogger({ service: "api", env: env.NODE_ENV });

const app = createApp({ logger });

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  logger.info("api_started", { port: info.port });
});
