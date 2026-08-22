import { serve } from "@hono/node-server";
import { createAdminClient } from "@sb/db";
import { createMercadoLivreClient, loadEncryptionKey } from "@sb/mercado-livre";
import { createLogger } from "@sb/observability";

import { createWorkerApp } from "./app.js";
import { loadEnv } from "./env.js";
import { createEnqueuer } from "./enqueue.js";
import { createAnalyticsRecomputeHandler } from "./handlers/analytics-recompute.js";
import { createBackfillOrdersHandler } from "./handlers/backfill-orders.js";
import { createErpImportApplyHandler } from "./handlers/erp-import-apply.js";
import { createErpImportParseHandler } from "./handlers/erp-import-parse.js";
import { createNfeImportParseHandler } from "./handlers/nfe-import-parse.js";
import { createSyncFulfillmentSnapshotHandler } from "./handlers/sync-fulfillment-snapshot.js";
import { createSyncOrdersWindowHandler } from "./handlers/sync-orders-window.js";
import { createNfeXmlReader } from "./nfe-xml-reader.js";
import { withHandlers } from "./router.js";
import { createSheetReader } from "./sheet-reader.js";

const env = loadEnv();
const logger = createLogger({ service: "worker", env: env.NODE_ENV });

const db = createAdminClient({
  supabaseUrl: env.SUPABASE_URL,
  serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
});

const enqueuer = createEnqueuer(env);

// `redirectUri` nunca é enviado pelo refresh (`grant_type=refresh_token` não
// carrega esse campo) — só a troca inicial do `code`, feita pela `api`, usa
// o valor de verdade.
const oauth = {
  clientId: env.MERCADO_LIVRE_CLIENT_ID,
  clientSecret: env.MERCADO_LIVRE_CLIENT_SECRET,
  redirectUri: "",
};
const encryptionKey = loadEncryptionKey(env.ML_TOKEN_ENCRYPTION_KEY);
const mercadoLivre = createMercadoLivreClient();

// `DOCUMENTS_BUCKET` é opcional (env.ts) até o bucket real existir no GCP —
// o handler de parse da NF-e só entra no registro quando ela está presente,
// mesmo raciocínio de `dependencies?` opcionais em `apps/api/src/app.ts`.
const nfeHandlers =
  env.DOCUMENTS_BUCKET !== undefined
    ? { "nfe.import.parse": createNfeImportParseHandler({ db, reader: createNfeXmlReader(env.DOCUMENTS_BUCKET) }) }
    : {};

const app = createWorkerApp({
  logger,
  db,
  registry: withHandlers({
    "analytics.recompute": createAnalyticsRecomputeHandler({ db }),
    "erp.import.parse": createErpImportParseHandler({
      db,
      reader: createSheetReader(env.ERP_IMPORTS_BUCKET),
    }),
    "erp.import.apply": createErpImportApplyHandler({ db }),
    "sync.orders.window": createSyncOrdersWindowHandler({
      db,
      mercadoLivre,
      oauth,
      encryptionKey,
      enqueuer,
    }),
    "backfill.orders": createBackfillOrdersHandler({ db, mercadoLivre, oauth, encryptionKey, enqueuer }),
    "sync.fulfillment.snapshot": createSyncFulfillmentSnapshotHandler({ db, mercadoLivre, oauth, encryptionKey }),
    ...nfeHandlers,
  }),
});

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  logger.info("worker_started", { port: info.port });
});
