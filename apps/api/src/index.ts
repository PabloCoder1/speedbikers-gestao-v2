import { serve } from "@hono/node-server";
import { createAdminClient, createUserClient } from "@sb/db";
import { loadEncryptionKey } from "@sb/mercado-livre";
import { createLogger } from "@sb/observability";

import { createAnthropicClient } from "./anthropic-client.js";
import { createApp } from "./app.js";
import { createAuthenticator } from "./auth.js";
import { createEnqueuer } from "./enqueue.js";
import { loadEnv } from "./env.js";
import { createIpAllowlistVerifier } from "./ip-allowlist.js";
import { createOidcVerifier } from "./oidc.js";
import { createFileStore } from "./storage.js";

const env = loadEnv();
const logger = createLogger({ service: "api", env: env.NODE_ENV });

const db = createAdminClient({
  supabaseUrl: env.SUPABASE_URL,
  serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
});

const enqueuer = createEnqueuer(env);

// `DOCUMENTS_BUCKET` é opcional (env.ts) até o bucket real existir no GCP —
// as rotas de NF-e só entram no registro quando ela está presente, mesmo
// raciocínio do handler de parse em `apps/worker/src/index.ts`.
const nfeImportDeps =
  env.DOCUMENTS_BUCKET !== undefined
    ? { db, enqueuer, logger, store: createFileStore(env.DOCUMENTS_BUCKET) }
    : undefined;

/*
  As origens do `web`, na ordem declarada. A PRIMEIRA é para onde o link de
  convite leva depois de verificado (D-303): sem ela o Auth usa a "Site URL" do
  projeto, que em 2026-09-10 era `http://localhost:3000` — todo convite mandava
  a pessoa para a máquina dela.
*/
const webOrigins = (env.WEB_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter((origin) => origin !== "");

const app = createApp({
  logger,
  enqueuer,
  webOrigins,
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
  // Espalhado condicionalmente, não `nfeImportDeps` direto: com
  // `exactOptionalPropertyTypes`, atribuir `undefined` a uma propriedade
  // opcional é diferente de omitir a chave — só omitir satisfaz o tipo.
  ...(nfeImportDeps !== undefined ? { nfeImportDeps } : {}),
  ipAllowlist: createIpAllowlistVerifier(),
  webhook: { db, enqueuer, logger },
  mlAccounts: {
    db,
    logger,
    enqueuer,
    oauth: {
      clientId: env.MERCADO_LIVRE_CLIENT_ID,
      clientSecret: env.MERCADO_LIVRE_CLIENT_SECRET,
      redirectUri: env.MERCADO_LIVRE_REDIRECT_URI,
    },
    encryptionKey: loadEncryptionKey(env.ML_TOKEN_ENCRYPTION_KEY),
  },
  reconcile: { db, enqueuer, logger },
  fulfillmentSchedule: { db, enqueuer, logger },
  balanceReconcileSchedule: { db, enqueuer, logger },
  ledgerIntegritySchedule: { db, enqueuer, logger },
  listingsSchedule: { db, enqueuer, logger },
  listingVisitsSchedule: { db, enqueuer, logger },
  orderFinancialsSchedule: { db, enqueuer, logger },
  supportQuestionsSchedule: { db, enqueuer, logger },
  supportClaimsSchedule: { db, enqueuer, logger },
  supportMessagesSchedule: { db, enqueuer, logger },
  supportReply: { db, enqueuer, logger },
  relist: { db, enqueuer, logger },
  invites: { db, logger, ...(webOrigins[0] === undefined ? {} : { webUrl: webOrigins[0] }) },
  salesAnomalyActionsSchedule: { db, enqueuer, logger },
  decisionOutcomesSchedule: { db, enqueuer, logger },
  aiBudgetSchedule: { db, enqueuer, logger },
  copilot: {
    db,
    logger,
    createUserClient: (accessToken) =>
      createUserClient({ supabaseUrl: env.SUPABASE_URL, publishableKey: env.SUPABASE_PUBLISHABLE_KEY }, accessToken),
    anthropic: createAnthropicClient(env.ANTHROPIC_API_KEY),
  },
});

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  /*
    O HOST do Supabase entra no log de boot, e a razao e uma tarde inteira de
    diagnostico (D-300).

    `SUPABASE_URL` exportada no ambiente VENCE o `.env.local`: `--env-file` do
    Node nao sobrescreve variavel que ja existe. Quando isso acontece com a
    web apontando para o Supabase local e a API para o remoto, todo token
    legitimo vira "token invalido" -- 401 em cada rota, sem que nada em tela ou
    em log diga que sao DOIS projetos diferentes.

    Uma linha no boot torna isso legivel em cinco segundos. So o HOST: chave
    nunca entra em log (D-232).
  */
  logger.info("api_started", { port: info.port, supabase_host: new URL(env.SUPABASE_URL).host });
});
