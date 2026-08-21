import { randomUUID } from "node:crypto";

import type { Logger } from "@sb/observability";
import { Hono } from "hono";
import { cors } from "hono/cors";

import type { Authenticator } from "./auth.js";
import type { Enqueuer } from "./enqueue.js";
import type { ImportDeps } from "./erp-import.js";
import { confirmApply, isImportKind, receiveUpload } from "./erp-import.js";
import type { IpAllowlistVerifier } from "./ip-allowlist.js";
import type { OidcVerifier } from "./oidc.js";
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
  ipAllowlist?: IpAllowlistVerifier;
  webhook?: WebhookDeps;
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
