import { randomUUID } from "node:crypto";

import type { Logger } from "@sb/observability";
import { Hono } from "hono";
import { cors } from "hono/cors";

import type { Authenticator } from "./auth.js";
import type { BalanceReconcileScheduleDeps } from "./balance-reconcile-schedule.js";
import { triggerBalanceReconciliation } from "./balance-reconcile-schedule.js";
import type { Enqueuer } from "./enqueue.js";
import type { ImportDeps } from "./erp-import.js";
import { confirmApply, isImportKind, receiveUpload } from "./erp-import.js";
import type { FulfillmentScheduleDeps } from "./fulfillment-schedule.js";
import { triggerFulfillmentSnapshot } from "./fulfillment-schedule.js";
import type { IpAllowlistVerifier } from "./ip-allowlist.js";
import type { LedgerIntegrityScheduleDeps } from "./ledger-integrity-schedule.js";
import { triggerLedgerIntegrityCheck } from "./ledger-integrity-schedule.js";
import type { ListingVisitsScheduleDeps } from "./listing-visits-schedule.js";
import { triggerListingVisitsSnapshot } from "./listing-visits-schedule.js";
import type { ListingsScheduleDeps } from "./listings-schedule.js";
import { triggerListingsSnapshot } from "./listings-schedule.js";
import type { MlAccountsDeps } from "./ml-accounts.js";
import { completeConnect, startConnect } from "./ml-accounts.js";
import type { NfeImportDeps } from "./nfe-import.js";
import { confirmNfeApply, receiveNfeUpload } from "./nfe-import.js";
import type { OidcVerifier } from "./oidc.js";
import type { ReconcileDeps } from "./reconcile.js";
import { triggerOrdersReconciliation } from "./reconcile.js";
import type { SalesAnomalyActionsScheduleDeps } from "./sales-anomaly-actions-schedule.js";
import { triggerSalesAnomalyActionsDetection } from "./sales-anomaly-actions-schedule.js";
import type { WebhookDeps } from "./webhook.js";
import { receiveWebhook } from "./webhook.js";

/**
 * Variáveis carregadas no contexto do request.
 *
 * Declarar o tipo é o que permite usar `context.get("requestId")` sem cast — e
 * o que faz o compilador reclamar se alguém ler uma variável que nunca foi
 * escrita.
 */
export interface AppVariables {
  requestId: string;
}

export interface AppEnv { Variables: AppVariables }

export interface AppDependencies {
  logger: Logger;

  /**
   * Origens do `web` autorizadas a chamar `/v1/*` do navegador.
   *
   * Lista explícita, nunca `*`. O upload da planilha sai do navegador direto
   * para cá — isso evita que o arquivo atravesse a Vercel só de passagem e
   * esbarre no limite de corpo da função — e é o CORS que decide de onde ele
   * pode sair.
   */
  webOrigins?: readonly string[];
  startedAt?: Date;
  enqueuer?: Enqueuer;
  oidc?: OidcVerifier;
  auth?: Authenticator;
  importDeps?: ImportDeps;
  /** `undefined` até `DOCUMENTS_BUCKET` existir no ambiente (env.ts) — mesmo raciocínio de `importDeps`. */
  nfeImportDeps?: NfeImportDeps;
  ipAllowlist?: IpAllowlistVerifier;
  webhook?: WebhookDeps;
  mlAccounts?: MlAccountsDeps;
  reconcile?: ReconcileDeps;
  fulfillmentSchedule?: FulfillmentScheduleDeps;
  balanceReconcileSchedule?: BalanceReconcileScheduleDeps;
  ledgerIntegritySchedule?: LedgerIntegrityScheduleDeps;
  listingsSchedule?: ListingsScheduleDeps;
  listingVisitsSchedule?: ListingVisitsScheduleDeps;
  salesAnomalyActionsSchedule?: SalesAnomalyActionsScheduleDeps;
}

/**
 * Monta a aplicação HTTP.
 *
 * Recebe as dependências em vez de criá-las para que o teste possa observar o
 * log sem tocar em stdout.
 */
export function createApp(dependencies: AppDependencies): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const startedAt = dependencies.startedAt ?? new Date();

  // Todo request carrega um id, propagado no log e devolvido no header. É o que
  // permite correlacionar uma linha de log com uma requisição concreta.
  app.use("*", async (context, next) => {
    const requestId = context.req.header("x-request-id") ?? randomUUID();

    context.set("requestId", requestId);
    context.header("x-request-id", requestId);

    await next();
  });

  // CORS apenas em `/v1/*`. Webhook e `/internal/*` não são chamados por
  // navegador: liberar origem neles só ampliaria a superfície à toa.
  //
  // `credentials` fica desligado de propósito: a autorização viaja no header
  // `Authorization`, não em cookie. Sem cookie no jogo, não há CSRF a mitigar.
  if (dependencies.webOrigins !== undefined && dependencies.webOrigins.length > 0) {
    const allowed = new Set(dependencies.webOrigins);

    app.use(
      "/v1/*",
      cors({
        origin: (origin) => (allowed.has(origin) ? origin : null),
        allowMethods: ["GET", "POST", "OPTIONS"],
        allowHeaders: ["authorization", "content-type", "x-request-id"],
        maxAge: 3600,
      }),
    );
  }

  app.get("/health", (context) => {
    return context.json({
      status: "ok",
      service: "api",
      startedAt: startedAt.toISOString(),
    });
  });

  // --------------------------------------------------------------------
  // Webhook do Mercado Livre.
  //
  // Caminho liberado EXPLICITAMENTE E APENAS ELE (docs/API.md secao 2). Não
  // exige JWT nem OIDC — o Mercado Livre não envia nenhum dos dois. É
  // exatamente o oposto do bug da V2: lá, o proxy exigia sessão e o webhook
  // morria num 307 para /login, em silêncio, por semanas (D-024).
  //
  // A única autenticação é a allowlist de IP (D-043): sem assinatura HMAC
  // documentada para este produto.
  // --------------------------------------------------------------------
  app.use("/webhooks/*", async (context, next) => {
    const ipAllowlist = dependencies.ipAllowlist;

    if (ipAllowlist === undefined) {
      return context.json({ error: { code: "not_configured" } }, 503);
    }

    const result = ipAllowlist.verify(context.req.header("x-forwarded-for"));

    if (!result.ok) {
      dependencies.logger.warn("webhook_origin_rejected", {
        request_id: context.get("requestId"),
        path: context.req.path,
        ip: result.ip,
      });

      // Resposta genérica: não confirmar ao chamador se o problema foi o IP
      // ou outra coisa.
      return context.json({ error: { code: "forbidden" } }, 403);
    }

    await next();
  });

  app.post("/webhooks/mercado-livre", async (context) => {
    const webhook = dependencies.webhook;

    if (webhook === undefined) {
      return context.json({ error: { code: "not_configured" } }, 503);
    }

    let rawBody: unknown;

    try {
      rawBody = await context.req.json();
    } catch {
      return context.json({ error: { code: "invalid_payload", message: "corpo não é JSON" } }, 400);
    }

    const outcome = await receiveWebhook(webhook, rawBody);

    if (outcome.status === "invalid_payload") {
      return context.json({ error: { code: "invalid_payload", message: outcome.reason } }, 400);
    }

    // "unknown_account" também recebe 200: reenviar não vai criar a conta que
    // falta, e devolver erro só faria o Mercado Livre gastar 8 tentativas em
    // 1h à toa (docs/MERCADO_LIVRE.md secao 2.5).
    return context.json({ received: true, processed: outcome.status === "enqueued" });
  });

  // --------------------------------------------------------------------
  // Callback do OAuth do Mercado Livre.
  //
  // Caminho público, como o webhook — mas a autenticação própria aqui é o
  // `state` de CSRF (`ml_oauth_states`), não a allowlist de IP: quem chega
  // aqui é o NAVEGADOR do ADMIN sendo redirecionado pelo Mercado Livre, não
  // o Mercado Livre chamando servidor a servidor. Nem JWT (o navegador ainda
  // não tem sessão desta chamada) nem IP fixo (é o admin, de qualquer rede).
  // --------------------------------------------------------------------
  app.get("/oauth/mercado-livre/callback", async (context) => {
    const mlAccounts = dependencies.mlAccounts;

    if (mlAccounts === undefined) {
      return context.json({ error: { code: "not_configured" } }, 503);
    }

    const state = context.req.query("state");

    if (state === undefined) {
      return context.json({ error: { code: "invalid_payload", message: "state ausente" } }, 400);
    }

    const code = context.req.query("code");
    const error = context.req.query("error");

    // Com `exactOptionalPropertyTypes`, passar `code: undefined` não é o
    // mesmo que omitir a chave (mesma regra já documentada em enqueue.ts).
    const outcome = await completeConnect(mlAccounts, {
      state,
      ...(code === undefined ? {} : { code }),
      ...(error === undefined ? {} : { error }),
    });

    if (outcome.status === "invalid_state") {
      return context.json({ error: { code: "invalid_state" } }, 400);
    }

    if (outcome.status === "rejected") {
      return context.json({ error: { code: "rejected", message: outcome.reason } }, 400);
    }

    return context.json({ connected: true, mlAccountId: outcome.mlAccountId });
  });

  // --------------------------------------------------------------------
  // Rotas internas: Cloud Scheduler e Cloud Tasks, autenticadas por OIDC.
  //
  // A `api` é pública no Cloud Run por causa do webhook do Mercado Livre, que
  // não envia credencial do Google. Logo, a verificação acontece AQUI.
  // --------------------------------------------------------------------
  app.use("/internal/*", async (context, next) => {
    const oidc = dependencies.oidc;

    if (oidc === undefined) {
      return context.json({ error: { code: "not_configured" } }, 503);
    }

    const result = await oidc.verify(context.req.header("authorization"));

    if (!result.ok) {
      dependencies.logger.warn("internal_auth_rejected", {
        request_id: context.get("requestId"),
        path: context.req.path,
        reason: result.reason,
      });

      // Resposta genérica: não informar ao chamador o que exatamente falhou.
      return context.json({ error: { code: "unauthorized" } }, 401);
    }

    await next();
  });

  app.post("/internal/jobs/ping", async (context) => {
    const enqueuer = dependencies.enqueuer;

    if (enqueuer === undefined) {
      return context.json({ error: { code: "not_configured" } }, 503);
    }

    const result = await enqueuer.enqueue({
      jobType: "system.ping",
      organizationId: "00000000-0000-4000-8000-000000000000",
      dedupeKey: `ping:${new Date().toISOString().slice(0, 16)}`,
      queue: "maintenance",
    });

    dependencies.logger.info("job_enqueued", {
      request_id: context.get("requestId"),
      job_id: result.envelope.jobId,
      job_type: result.envelope.jobType,
      deduplicated: result.deduplicated,
    });

    return context.json({
      enqueued: true,
      deduplicated: result.deduplicated,
      jobId: result.envelope.jobId,
    });
  });

  // --------------------------------------------------------------------
  // Reconciliação por janela — rede de segurança do que o webhook perdeu
  // (docs/MERCADO_LIVRE.md secao 3). Chamada pelo Cloud Scheduler, no máximo
  // uma vez por hora útil (dedupe por hora cheia dentro de triggerOrdersReconciliation).
  // --------------------------------------------------------------------
  app.post("/internal/schedule/reconcile", async (context) => {
    const reconcile = dependencies.reconcile;

    if (reconcile === undefined) {
      return context.json({ error: { code: "not_configured" } }, 503);
    }

    const outcome = await triggerOrdersReconciliation(reconcile);

    return context.json(outcome);
  });

  // --------------------------------------------------------------------
  // Captura de estoque Full por conta — mesmo formato de reconcile acima,
  // cadência menor (`infra/cloud-scheduler.sh`: a cada 6h, não a cada hora).
  // --------------------------------------------------------------------
  app.post("/internal/schedule/fulfillment", async (context) => {
    const fulfillmentSchedule = dependencies.fulfillmentSchedule;

    if (fulfillmentSchedule === undefined) {
      return context.json({ error: { code: "not_configured" } }, 503);
    }

    const outcome = await triggerFulfillmentSnapshot(fulfillmentSchedule);

    return context.json(outcome);
  });

  // --------------------------------------------------------------------
  // Reconciliação de estoque contra o snapshot do UpSeller (D-029) — por
  // ORGANIZAÇÃO, não por conta ML (estoque não pertence a uma conta
  // específica, D-006). Cadência diária: `infra/cloud-scheduler.sh`.
  // --------------------------------------------------------------------
  app.post("/internal/schedule/maintenance", async (context) => {
    const balanceReconcileSchedule = dependencies.balanceReconcileSchedule;

    if (balanceReconcileSchedule === undefined) {
      return context.json({ error: { code: "not_configured" } }, 503);
    }

    const outcome = await triggerBalanceReconciliation(balanceReconcileSchedule);

    return context.json(outcome);
  });

  // --------------------------------------------------------------------
  // Conferência automática ledger × projeção (D-056) — mesmo formato de
  // /internal/schedule/maintenance acima, por ORGANIZAÇÃO. Cadência diária:
  // `infra/cloud-scheduler.sh`.
  // --------------------------------------------------------------------
  app.post("/internal/schedule/ledger-integrity", async (context) => {
    const ledgerIntegritySchedule = dependencies.ledgerIntegritySchedule;

    if (ledgerIntegritySchedule === undefined) {
      return context.json({ error: { code: "not_configured" } }, 503);
    }

    const outcome = await triggerLedgerIntegrityCheck(ledgerIntegritySchedule);

    return context.json(outcome);
  });

  // --------------------------------------------------------------------
  // Sincronização de listings/anúncios (D-058) — mesmo formato de
  // /internal/schedule/fulfillment acima, por CONTA. Cadência a cada 6h:
  // `infra/cloud-scheduler.sh`.
  // --------------------------------------------------------------------
  app.post("/internal/schedule/listings", async (context) => {
    const listingsSchedule = dependencies.listingsSchedule;

    if (listingsSchedule === undefined) {
      return context.json({ error: { code: "not_configured" } }, 503);
    }

    const outcome = await triggerListingsSnapshot(listingsSchedule);

    return context.json(outcome);
  });

  // --------------------------------------------------------------------
  // Sincronização de visitas por anúncio (D-032) — mesmo formato de
  // /internal/schedule/listings acima, por CONTA. Cadência diária:
  // `infra/cloud-scheduler.sh`.
  // --------------------------------------------------------------------
  app.post("/internal/schedule/listing-visits", async (context) => {
    const listingVisitsSchedule = dependencies.listingVisitsSchedule;

    if (listingVisitsSchedule === undefined) {
      return context.json({ error: { code: "not_configured" } }, 503);
    }

    const outcome = await triggerListingVisitsSnapshot(listingVisitsSchedule);

    return context.json(outcome);
  });

  // --------------------------------------------------------------------
  // Detecção de anomalia de venda (Fase 6, D-064) — mesmo formato de
  // /internal/schedule/ledger-integrity acima, por ORGANIZAÇÃO. Cadência
  // diária: `infra/cloud-scheduler.sh`.
  // --------------------------------------------------------------------
  app.post("/internal/schedule/sales-anomaly-actions", async (context) => {
    const salesAnomalyActionsSchedule = dependencies.salesAnomalyActionsSchedule;

    if (salesAnomalyActionsSchedule === undefined) {
      return context.json({ error: { code: "not_configured" } }, 503);
    }

    const outcome = await triggerSalesAnomalyActionsDetection(salesAnomalyActionsSchedule);

    return context.json(outcome);
  });

  // --------------------------------------------------------------------
  // Importação do UpSeller — upload do arquivo.
  //
  // Comando privilegiado: a `api` guarda o arquivo, registra o lote e
  // ENFILEIRA o parse. Interpretar 23.924 linhas é trabalho do worker; a `api`
  // nunca faz trabalho longo inline (docs/ARCHITECTURE.md secao 5).
  // --------------------------------------------------------------------
  app.post("/v1/erp-imports", async (context) => {
    const auth = dependencies.auth;
    const importDeps = dependencies.importDeps;

    if (auth === undefined || importDeps === undefined) {
      return context.json({ error: { code: "not_configured" } }, 503);
    }

    // Importação reescreve o catálogo inteiro: só ADMIN e GESTOR.
    const authorized = await auth.authenticate(context.req.header("authorization"), [
      "ADMIN",
      "GESTOR",
    ]);

    if (!authorized.ok) {
      dependencies.logger.warn("erp_import_unauthorized", {
        request_id: context.get("requestId"),
        reason: authorized.reason,
      });

      return context.json({ error: { code: "unauthorized" } }, authorized.status);
    }

    const form = await context.req.parseBody();
    const file = form.file;
    const kind = form.kind;

    if (!(file instanceof File)) {
      return context.json({ error: { code: "file_required" } }, 400);
    }

    if (!isImportKind(kind)) {
      return context.json({ error: { code: "invalid_kind" } }, 400);
    }

    const outcome = await receiveUpload(importDeps, authorized.caller, {
      kind,
      fileName: file.name,
      contentType: file.type,
      body: new Uint8Array(await file.arrayBuffer()),
    });

    if (outcome.status === "rejected") {
      return context.json({ error: { code: "rejected", message: outcome.reason } }, 400);
    }

    // 200 e não 201 no duplicado: o lote já existe, nada foi criado agora.
    return context.json(
      { batchId: outcome.batchId, contentHash: outcome.contentHash, duplicate: outcome.status === "duplicate" },
      outcome.status === "created" ? 201 : 200,
    );
  });

  // --------------------------------------------------------------------
  // Importação do UpSeller — confirmação humana da aplicação.
  //
  // Comando privilegiado: move o lote para APPLYING e ENFILEIRA a aplicação.
  // Escrever em domínio a partir de 23.924 linhas é trabalho do worker; a
  // `api` nunca faz trabalho longo inline (docs/ARCHITECTURE.md secao 5).
  // --------------------------------------------------------------------
  app.post("/v1/erp-imports/:id/apply", async (context) => {
    const auth = dependencies.auth;
    const importDeps = dependencies.importDeps;

    if (auth === undefined || importDeps === undefined) {
      return context.json({ error: { code: "not_configured" } }, 503);
    }

    // Mesmo papel mínimo do upload: aplicação reescreve o catálogo inteiro.
    const authorized = await auth.authenticate(context.req.header("authorization"), [
      "ADMIN",
      "GESTOR",
    ]);

    if (!authorized.ok) {
      dependencies.logger.warn("erp_apply_unauthorized", {
        request_id: context.get("requestId"),
        reason: authorized.reason,
      });

      return context.json({ error: { code: "unauthorized" } }, authorized.status);
    }

    const outcome = await confirmApply(importDeps, authorized.caller, context.req.param("id"));

    if (outcome.status === "not_found") {
      return context.json({ error: { code: "not_found" } }, 404);
    }

    if (outcome.status === "rejected") {
      return context.json({ error: { code: "rejected", message: outcome.reason } }, 409);
    }

    return context.json({ batchId: outcome.batchId, queued: true });
  });

  // --------------------------------------------------------------------
  // NF-e/XML — upload.
  //
  // Mesmo raciocínio do upload do UpSeller: a `api` guarda o arquivo, registra
  // o documento e ENFILEIRA o parse. Interpretar o XML é trabalho do worker.
  // --------------------------------------------------------------------
  app.post("/v1/nfe-imports", async (context) => {
    const auth = dependencies.auth;
    const nfeImportDeps = dependencies.nfeImportDeps;

    if (auth === undefined || nfeImportDeps === undefined) {
      return context.json({ error: { code: "not_configured" } }, 503);
    }

    // Mesmo papel mínimo do UpSeller: NF-e alimenta o ledger de estoque.
    const authorized = await auth.authenticate(context.req.header("authorization"), [
      "ADMIN",
      "GESTOR",
    ]);

    if (!authorized.ok) {
      dependencies.logger.warn("nfe_import_unauthorized", {
        request_id: context.get("requestId"),
        reason: authorized.reason,
      });

      return context.json({ error: { code: "unauthorized" } }, authorized.status);
    }

    const form = await context.req.parseBody();
    const file = form.file;

    if (!(file instanceof File)) {
      return context.json({ error: { code: "file_required" } }, 400);
    }

    const outcome = await receiveNfeUpload(nfeImportDeps, authorized.caller, {
      fileName: file.name,
      contentType: file.type,
      body: new Uint8Array(await file.arrayBuffer()),
    });

    if (outcome.status === "rejected") {
      return context.json({ error: { code: "rejected", message: outcome.reason } }, 400);
    }

    // 200 e não 201 no duplicado: o documento já existe, nada foi criado agora.
    return context.json(
      { documentId: outcome.documentId, contentHash: outcome.contentHash, duplicate: outcome.status === "duplicate" },
      outcome.status === "created" ? 201 : 200,
    );
  });

  // --------------------------------------------------------------------
  // NF-e/XML — confirmação humana da aplicação.
  //
  // Move o documento para APPLYING e ENFILEIRA `nfe.import.apply`. Exige
  // 100% dos itens vinculados — ver `confirmNfeApply` em nfe-import.ts.
  // --------------------------------------------------------------------
  app.post("/v1/nfe-imports/:id/apply", async (context) => {
    const auth = dependencies.auth;
    const nfeImportDeps = dependencies.nfeImportDeps;

    if (auth === undefined || nfeImportDeps === undefined) {
      return context.json({ error: { code: "not_configured" } }, 503);
    }

    const authorized = await auth.authenticate(context.req.header("authorization"), [
      "ADMIN",
      "GESTOR",
    ]);

    if (!authorized.ok) {
      dependencies.logger.warn("nfe_apply_unauthorized", {
        request_id: context.get("requestId"),
        reason: authorized.reason,
      });

      return context.json({ error: { code: "unauthorized" } }, authorized.status);
    }

    const outcome = await confirmNfeApply(nfeImportDeps, authorized.caller, context.req.param("id"));

    if (outcome.status === "not_found") {
      return context.json({ error: { code: "not_found" } }, 404);
    }

    if (outcome.status === "rejected") {
      return context.json({ error: { code: "rejected", message: outcome.reason } }, 409);
    }

    return context.json({ documentId: outcome.documentId, queued: true });
  });

  // --------------------------------------------------------------------
  // Início da autorização de uma conta Mercado Livre.
  //
  // A conta em si (`ml_accounts`) já existe — criada pelo `web` direto sob
  // RLS, só ADMIN escreve. Esta rota só cuida do que exige segredo: o
  // `client_secret` do Mercado Livre nunca pode chegar ao navegador
  // (docs/ARCHITECTURE.md secao 18).
  // --------------------------------------------------------------------
  app.post("/v1/ml-accounts/connect", async (context) => {
    const auth = dependencies.auth;
    const mlAccounts = dependencies.mlAccounts;

    if (auth === undefined || mlAccounts === undefined) {
      return context.json({ error: { code: "not_configured" } }, 503);
    }

    // Só ADMIN: quem autoriza no Mercado Livre precisa ser administrador
    // daquela conta ML específica (D-041) — colaborador do lado de cá que não
    // for ADMIN nem chegaria a essa tela real no Mercado Livre.
    const authorized = await auth.authenticate(context.req.header("authorization"), ["ADMIN"]);

    if (!authorized.ok) {
      dependencies.logger.warn("ml_account_connect_unauthorized", {
        request_id: context.get("requestId"),
        reason: authorized.reason,
      });

      return context.json({ error: { code: "unauthorized" } }, authorized.status);
    }

    const body: unknown = await context.req.json().catch(() => null);
    const mlAccountId =
      typeof body === "object" && body !== null && "mlAccountId" in body && typeof body.mlAccountId === "string"
        ? body.mlAccountId
        : undefined;

    if (mlAccountId === undefined) {
      return context.json({ error: { code: "invalid_payload", message: "mlAccountId obrigatório" } }, 400);
    }

    const outcome = await startConnect(mlAccounts, authorized.caller, mlAccountId);

    if (outcome.status === "not_found") {
      return context.json({ error: { code: "not_found" } }, 404);
    }

    if (outcome.status === "rejected") {
      return context.json({ error: { code: "rejected", message: outcome.reason } }, 409);
    }

    return context.json({ authorizationUrl: outcome.authorizationUrl });
  });

  app.notFound((context) => {
    return context.json(
      {
        error: {
          code: "not_found",
          message: "Recurso não encontrado.",
          request_id: context.get("requestId"),
        },
      },
      404,
    );
  });

  app.onError((error, context) => {
    const requestId = context.get("requestId");

    dependencies.logger.error("unhandled_request_error", {
      request_id: requestId,
      path: context.req.path,
      error,
    });

    // Nunca vazar detalhe interno na resposta. Ver docs/API.md secao 6.
    return context.json(
      {
        error: {
          code: "internal_error",
          message: "Erro interno.",
          request_id: requestId,
        },
      },
      500,
    );
  });

  return app;
}
