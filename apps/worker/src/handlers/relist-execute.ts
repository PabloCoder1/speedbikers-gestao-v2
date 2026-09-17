import type { AdminClient } from "@sb/db";
import type { RelistBody } from "@sb/domain";
import {
  RELIST_POST_FAILED_REASON,
  RELIST_POST_REJECTED_REASON,
  RELIST_RETRY_REASON,
  buildRelistBody,
  canTransitionRelist,
  collectRelistInventoryIds,
  evaluateRelistPreflight,
  isRelistRejectionStatus,
  isRelistRetryEligible,
} from "@sb/domain";
import type { MercadoLivreClient, MercadoLivreOAuthConfig } from "@sb/mercado-livre";
import { MercadoLivreApiError } from "@sb/mercado-livre";
import type { Logger } from "@sb/observability";
import { redactSecretText } from "@sb/observability";
import { z } from "zod";

import type { JobOutcome } from "../job-outcome.js";
import type { HandlerContext, JobHandler } from "../router.js";
import { ensureAccessToken } from "./ml-token.js";
import { describeFullStock, readRelistFullStock } from "./relist-full-stock.js";
import { ensureRelistMeasurement } from "./relist-measurement.js";

/**
 * `relist.execute` (Fase 9, D-162) — a PRIMEIRA ESCRITA DESTRUTIVA do
 * projeto no Mercado Livre: fecha o pai (irreversível) e emite o
 * POST /relist. Todo o desenho existe para atravessar a janela sem
 * idempotência remota (secao 2.16) sem jamais mentir sobre onde parou:
 *
 * 1. **Re-entrante por ESTADO, nunca por memória**: cada retomada do Cloud
 *    Tasks decide pelo status persistido (D-159). O estado é gravado ANTES
 *    do ato remoto que ele descreve — um crash deixa a operação dizendo a
 *    verdade ("estava fechando", "estava republicando"), nunca um passo
 *    atrás dela.
 * 2. **O preflight roda DE NOVO, na hora** (padrão D-096: revalidar o
 *    remoto no momento do ato): o estado do anúncio muda entre o pedido e a
 *    execução — entrar no Full, ganhar catálogo, ser republicado por fora.
 * 3. **RELISTING retomado vira RELIST_FAILED, sempre**: se o job caiu entre
 *    persistir RELISTING e ler a resposta do POST, não há como saber se o
 *    filho nasceu — e a API não dá como perguntar barato. Chutar "não
 *    nasceu" e repetir o POST poderia criar DOIS filhos. Gente decide.
 * 4. **Falha do POST não re-tenta**: mesma razão do envio de resposta
 *    (D-096) — um 5xx pode significar que o filho existe. RELIST_FAILED.
 *    A RECUSA (4xx exceto 408/429) também para em RELIST_FAILED, mas com
 *    motivo próprio (`POST_RECUSADO`) e o corpo do erro do Mercado Livre
 *    gravado (D-364): o ML leu o pedido e disse não, nenhum filho nasceu.
 * 5. **Filho só é confirmado pelo id DIFERENTE do pai**: o defeito
 *    registrado da própria doc (resposta com variações devolvendo o id do
 *    pai) não é tratado como contrato — resposta ambígua é RELIST_FAILED.
 * 6. **Retomada HUMANA, só depois de recusa comprovada** (D-364): o job com
 *    `retomada: true` — enfileirado pela `api` quando uma pessoa pede —
 *    relê o último evento de falha e reaplica a regra de elegibilidade
 *    (`isRelistRetryEligible`), confere o pai AO VIVO (precisa estar
 *    `closed` e ter estoque), persiste RELIST_FAILED → RELISTING e emite o
 *    POST pelo MESMO código da execução normal. Nada disso acontece sozinho:
 *    RELIST_FAILED sem `retomada` continua noop.
 *
 * O corpo do POST sai de `buildRelistBody` (D-364): com variações, só as que
 * têm estoque, cada uma com o próprio preço; sem estoque nenhum, o POST não
 * sai.
 */

const payloadSchema = z.object({ relistId: z.uuid(), retomada: z.boolean().optional() });

/** PUT /items/{id} {status:"closed"} — contrato confirmado em 2.16. */
const closeItemResponseSchema = z.object({ id: z.string(), status: z.string() });

/** POST /items/{id}/relist — sem status de sucesso documentado; o id é o que importa. */
const relistResponseSchema = z.object({ id: z.string() });

/**
 * Campos do pai usados para montar o corpo do relist — lidos do item AO VIVO.
 * O id de variação vai NUMÉRICO no corpo (doc oficial, D-364): só é aceito
 * dentro do inteiro seguro, para `Number(id)` não trocar de variação.
 */
const parentForRelistSchema = z.object({
  id: z.string(),
  status: z.string(),
  price: z.number(),
  available_quantity: z.number().int(),
  listing_type_id: z.string(),
  variations: z.array(
    z.object({
      id: z
        .union([z.number().int(), z.string().regex(/^\d+$/)])
        .refine((id) => Number.isSafeInteger(Number(id)), "id de variação fora do inteiro seguro"),
      price: z.number(),
      available_quantity: z.number().int(),
    }),
  ),
});

/**
 * Filho lido DEPOIS do POST, para materializar a projeção e remapear.
 * `include_attributes=all` é necessário para `seller_custom_field`, que é
 * apenas pista visual na fila — variation_id renovado nunca é associado a
 * SKU automaticamente (docs/MERCADO_LIVRE.md §2.16, D-163).
 */
const childForRemapSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  price: z.number(),
  currency_id: z.string(),
  available_quantity: z.number().int(),
  category_id: z.string().nullable().optional(),
  variations: z.array(
    z.object({
      id: z.union([z.number().int(), z.string().regex(/^\d+$/)]).transform(String),
      seller_custom_field: z.string().nullable().optional(),
    }),
  ),
});

/** Teto do resumo do corpo de erro do ML — cabe no `failure_reason` e no log. */
const ML_ERROR_SUMMARY_MAX = 800;

export interface RelistExecuteDeps {
  db: AdminClient;
  mercadoLivre: MercadoLivreClient;
  oauth: MercadoLivreOAuthConfig;
  encryptionKey: Buffer;
  now?: () => Date;
}

interface OperationRow {
  id: string;
  organization_id: string;
  ml_account_id: string;
  parent_item_id: string;
  child_item_id: string | null;
  status: string;
  failure_reason: string | null;
  requested_by: string;
}

interface TransitionContext {
  db: AdminClient;
  logger: Logger;
  operation: OperationRow;
}

interface TransitionResult {
  ok: boolean;
  message?: string;
  /** O CAS não casou: o estado mudou sob os pés — outra execução assumiu. */
  casLost?: boolean;
}

/**
 * Persiste uma transição VÁLIDA (máquina de D-159) + o evento append-only.
 * Falha ao persistir o STATUS é falha do passo (o chamador decide); falha
 * só no evento é logada sem derrubar — repetir o job para regravar auditoria
 * repetiria atos remotos, que é o risco maior.
 */
async function transition(
  ctx: TransitionContext,
  from: string,
  to: string,
  patch: Record<string, unknown>,
  reason: string | null,
): Promise<TransitionResult> {
  if (!canTransitionRelist(from as never, to as never)) {
    return { ok: false, message: `transição inválida ${from} → ${to}` };
  }

  // CAS de verdade: o `.eq("status", from)` + `.select` provam que ESTA
  // execução fez a transição. Zero linhas = o estado mudou sob os pés
  // (outra execução, outra decisão) — falhar e reler é o único caminho que
  // não grava evento de uma transição que não aconteceu.
  const updated = await ctx.db
    .from("listing_relists")
    .update({ status: to, ...patch })
    .eq("id", ctx.operation.id)
    .eq("status", from)
    .select("id");

  if (updated.error !== null) {
    return { ok: false, message: updated.error.message };
  }

  if (updated.data.length === 0) {
    return { ok: false, casLost: true, message: `a operação não estava mais em ${from} — transição não aplicada` };
  }

  const event = await ctx.db.from("listing_relist_events").insert({
    organization_id: ctx.operation.organization_id,
    ml_account_id: ctx.operation.ml_account_id,
    relist_id: ctx.operation.id,
    from_status: from,
    to_status: to,
    actor_user_id: null,
    reason,
  });

  if (event.error !== null) {
    ctx.logger.error("relist_event_not_recorded", {
      relist_id: ctx.operation.id,
      to_status: to,
      reason: event.error.message,
    });
  }

  ctx.operation.status = to;

  return { ok: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readText(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * Resumo LEGÍVEL do corpo de erro do Mercado Livre (D-364): `message`,
 * `error` e cada `cause[]` como `code: message`. Nada além desses campos
 * entra — o corpo inteiro poderia trazer o que não se grava —, o texto passa
 * pela redação de segredo da casa e é cortado em ~800 caracteres.
 */
function summarizeMercadoLivreError(body: unknown): string {
  const parts: string[] = [];

  if (isRecord(body)) {
    const message = readText(body.message);
    const error = readText(body.error);

    if (message !== null) {
      parts.push(message);
    }

    if (error !== null && error !== message) {
      parts.push(`(${error})`);
    }

    const causes: unknown[] = Array.isArray(body.cause) ? body.cause : [];
    const causeTexts = causes
      .map((cause) => {
        if (!isRecord(cause)) {
          return readText(cause);
        }

        const text = [readText(cause.code), readText(cause.message)].filter((piece) => piece !== null).join(": ");

        return text === "" ? null : text;
      })
      .filter((text) => text !== null);

    if (causeTexts.length > 0) {
      parts.push(`causas: ${causeTexts.join("; ")}`);
    }
  } else {
    const text = readText(body);

    if (text !== null) {
      parts.push(text);
    }
  }

  const summary = redactSecretText(parts.length === 0 ? "sem corpo de erro legível" : parts.join(" ")).replace(/\s+/gu, " ");

  return summary.length > ML_ERROR_SUMMARY_MAX ? `${summary.slice(0, ML_ERROR_SUMMARY_MAX - 1)}…` : summary;
}

async function remapRelistedOperation(
  deps: RelistExecuteDeps,
  context: HandlerContext,
  operation: OperationRow,
  accessToken: string,
): Promise<JobOutcome> {
  if (operation.child_item_id === null) {
    return {
      status: "failed",
      retryable: false,
      reason: "operação RELISTED sem child_item_id — incoerência estrutural",
    };
  }

  const child = await deps.mercadoLivre.request({
    method: "GET",
    path: `/items/${operation.child_item_id}?include_attributes=all`,
    accessToken,
    schema: childForRemapSchema,
  });

  if (child.id !== operation.child_item_id) {
    return {
      status: "failed",
      retryable: false,
      reason: `o remapeamento recebeu o item ${child.id}, mas esperava ${operation.child_item_id}`,
    };
  }

  const remapped = await deps.db.rpc("complete_listing_relist_remap", {
    p_relist_id: operation.id,
    p_child_title: child.title,
    p_child_status: child.status,
    p_child_price: child.price,
    p_child_currency_id: child.currency_id,
    p_child_available_quantity: child.available_quantity,
    p_child_category_id: child.category_id ?? null,
    p_child_variations: child.variations.map((variation) => ({
      id: variation.id,
      channel_sku: variation.seller_custom_field ?? null,
    })),
  });

  if (remapped.error !== null) {
    return {
      status: "failed",
      retryable: true,
      reason: `falha ao remapear vínculos do relist: ${remapped.error.message}`,
    };
  }

  const result = remapped.data[0];

  context.logger.info("relist_remap_done", {
    relist_id: operation.id,
    parent_item_id: operation.parent_item_id,
    child_item_id: operation.child_item_id,
    item_links_remapped: result?.item_links_remapped ?? 0,
    variation_links_retired: result?.variation_links_retired ?? 0,
    variation_candidates_created: result?.variation_candidates_created ?? 0,
  });

  // Medição 7/15/30 (D-164): registro reusando D-065. Falhar aqui FALHA o
  // job com retry — a retomada entra pelo ramo REMAPPED, que é só esta
  // garantia idempotente, sem repetir nada remoto.
  const measured = await ensureRelistMeasurement(deps, context.logger, {
    id: operation.id,
    organization_id: operation.organization_id,
    ml_account_id: operation.ml_account_id,
    parent_item_id: operation.parent_item_id,
    child_item_id: operation.child_item_id,
    requested_by: operation.requested_by,
  });

  if (!measured.ok) {
    return { status: "failed", retryable: true, reason: measured.message ?? "falha ao registrar a medição" };
  }

  return { status: "done", processed: 1 };
}

/**
 * O POST /relist e tudo o que decide o desfecho dele — o MESMO código para a
 * execução normal e para a retomada humana (D-364). Pré-condição: a operação
 * JÁ está persistida em RELISTING (regra 1).
 */
async function postRelistAndSettle(
  deps: RelistExecuteDeps,
  context: HandlerContext,
  ctx: TransitionContext,
  accessToken: string,
  body: RelistBody,
): Promise<JobOutcome> {
  const operation = ctx.operation;
  let child: { id: string };

  try {
    child = await deps.mercadoLivre.request({
      method: "POST",
      path: `/items/${operation.parent_item_id}/relist`,
      accessToken,
      body,
      schema: relistResponseSchema,
    });
  } catch (error) {
    // RECUSA comprovada (D-364): 4xx fora 408/429 é o Mercado Livre dizendo
    // não ao pedido — nenhum filho nasceu. O corpo do erro é gravado, porque
    // é ele que diz o que corrigir; e a operação fica elegível para retomada
    // HUMANA. Ainda assim nada repete sozinho.
    if (error instanceof MercadoLivreApiError && isRelistRejectionStatus(error.status)) {
      const summary = summarizeMercadoLivreError(error.body);

      context.logger.error("relist_post_rejected", { relist_id: operation.id, status: error.status, summary });

      const marked = await transition(
        ctx,
        "RELISTING",
        "RELIST_FAILED",
        {
          failure_reason: `o Mercado Livre recusou a republicação (HTTP ${String(error.status)}) — nenhum anúncio novo foi criado. Resposta: ${summary}`,
        },
        RELIST_POST_REJECTED_REASON,
      );

      if (!marked.ok) {
        return { status: "failed", retryable: true, reason: marked.message ?? "falha ao registrar RELIST_FAILED" };
      }

      return { status: "done", processed: 1 };
    }

    // Regra 4: NUNCA re-tentar o POST — um 5xx pode significar que o filho
    // nasceu. Pai fechado sem filho confirmado = RELIST_FAILED, gente decide.
    const message = error instanceof Error ? error.message : "falha desconhecida no POST /relist";

    context.logger.error("relist_post_failed", {
      relist_id: operation.id,
      status: error instanceof MercadoLivreApiError ? error.status : null,
      summary: error instanceof MercadoLivreApiError ? summarizeMercadoLivreError(error.body) : message,
    });

    const marked = await transition(
      ctx,
      "RELISTING",
      "RELIST_FAILED",
      { failure_reason: `o POST /relist falhou e não é seguro repetir: ${message}` },
      RELIST_POST_FAILED_REASON,
    );

    if (!marked.ok) {
      return { status: "failed", retryable: true, reason: marked.message ?? "falha ao registrar RELIST_FAILED" };
    }

    return { status: "done", processed: 1 };
  }

  if (child.id === operation.parent_item_id) {
    // O defeito documentado da própria doc (resposta devolvendo o id do
    // pai) — resposta ambígua NUNCA confirma filho (regra 5).
    const marked = await transition(
      ctx,
      "RELISTING",
      "RELIST_FAILED",
      { failure_reason: "a resposta do relist devolveu o próprio id do pai — filho não confirmado" },
      "RESPOSTA_AMBIGUA",
    );

    if (!marked.ok) {
      return { status: "failed", retryable: true, reason: marked.message ?? "falha ao registrar RELIST_FAILED" };
    }

    return { status: "done", processed: 1 };
  }

  const done = await transition(ctx, "RELISTING", "RELISTED", { child_item_id: child.id }, null);

  if (!done.ok) {
    return { status: "failed", retryable: true, reason: done.message ?? "falha ao registrar RELISTED" };
  }

  context.logger.info("relist_execute_done", {
    relist_id: operation.id,
    parent_item_id: operation.parent_item_id,
    child_item_id: child.id,
  });

  operation.child_item_id = child.id;

  // O POST já terminou e o filho foi confirmado. Daqui em diante só há
  // leitura remota + transação local: qualquer falha retorna retryable e a
  // próxima entrega entra pelo ramo RELISTED acima, sem repetir o POST.
  return remapRelistedOperation(deps, context, operation, accessToken);
}

/**
 * Retomada humana de RELIST_FAILED (regra 6, D-364). A `api` já aplicou a
 * regra; aqui ela é aplicada DE NOVO, contra o que está gravado agora — e
 * tudo o que reprovar termina SEM transição e SEM POST.
 */
async function resumeAfterRejection(
  deps: RelistExecuteDeps,
  context: HandlerContext,
  ctx: TransitionContext,
  now: Date,
): Promise<JobOutcome> {
  const operation = ctx.operation;

  const lastFailure = await deps.db
    .from("listing_relist_events")
    .select("reason")
    .eq("relist_id", operation.id)
    .eq("to_status", "RELIST_FAILED")
    .order("occurred_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (lastFailure.error !== null) {
    return { status: "failed", retryable: true, reason: `falha ao ler o último evento de falha: ${lastFailure.error.message}` };
  }

  const lastFailedEventReason = lastFailure.data?.reason ?? null;

  const eligible = isRelistRetryEligible({
    status: operation.status,
    parentItemId: operation.parent_item_id,
    failureReason: operation.failure_reason,
    lastFailedEventReason,
  });

  if (!eligible) {
    context.logger.warn("relist_retry_not_eligible", {
      relist_id: operation.id,
      status: operation.status,
      last_failed_reason: lastFailedEventReason,
    });

    return { status: "done", processed: 0 };
  }

  const tokenResult = await ensureAccessToken(deps, operation.ml_account_id, now);

  if (!tokenResult.ok) {
    return { status: "failed", retryable: tokenResult.retryable, reason: tokenResult.reason };
  }

  const accessToken = tokenResult.accessToken;
  let parentRaw: unknown;

  try {
    parentRaw = await deps.mercadoLivre.request({
      method: "GET",
      path: `/items/${operation.parent_item_id}`,
      accessToken,
      schema: z.unknown(),
    });
  } catch (error) {
    if (error instanceof MercadoLivreApiError && error.errorClass === "not_retryable") {
      context.logger.warn("relist_retry_parent_unavailable", { relist_id: operation.id, status: error.status });

      return { status: "done", processed: 0 };
    }

    throw error;
  }

  const parentParsed = parentForRelistSchema.safeParse(parentRaw);

  if (!parentParsed.success) {
    return { status: "failed", retryable: false, reason: "o anúncio pai não tem os campos que o relist herda" };
  }

  const parent = parentParsed.data;

  // O POST /relist exige o pai fechado (2.16). Pai ativo ou pausado aqui é o
  // remoto contradizendo o que está gravado — não é caso para republicar.
  if (parent.status !== "closed") {
    context.logger.warn("relist_retry_parent_not_closed", { relist_id: operation.id, parent_status: parent.status });

    return { status: "done", processed: 0 };
  }

  const body = buildRelistBody(parent);

  if (body === null) {
    context.logger.warn("relist_retry_without_stock", { relist_id: operation.id, parent_item_id: operation.parent_item_id });

    return { status: "done", processed: 0 };
  }

  // Estado persistido ANTES do POST (regra 1). O motivo antigo sai: se esta
  // tentativa falhar, ela grava o dela.
  const relisting = await transition(ctx, "RELIST_FAILED", "RELISTING", { failure_reason: null }, RELIST_RETRY_REASON);

  if (!relisting.ok) {
    // CAS perdido na retomada é outra execução que ASSUMIU a operação. Falhar
    // com retry faria a próxima entrega achar RELISTING e marcar como
    // interrompido um POST que pode estar em curso.
    if (relisting.casLost === true) {
      context.logger.warn("relist_retry_superseded", { relist_id: operation.id });

      return { status: "done", processed: 0 };
    }

    return { status: "failed", retryable: true, reason: relisting.message ?? "falha ao registrar RELISTING" };
  }

  context.logger.info("relist_retry_started", {
    relist_id: operation.id,
    parent_item_id: operation.parent_item_id,
    last_failed_reason: lastFailedEventReason,
  });

  return postRelistAndSettle(deps, context, ctx, accessToken, body);
}

export function createRelistExecuteHandler(deps: RelistExecuteDeps): JobHandler {
  return async (_envelope, context: HandlerContext): Promise<JobOutcome> => {
    const parsed = payloadSchema.safeParse(context.payload);

    if (!parsed.success) {
      return { status: "failed", retryable: false, reason: "payload inválido para relist.execute" };
    }

    const retomada = parsed.data.retomada === true;
    const now = deps.now?.() ?? new Date();

    const loaded = await deps.db
      .from("listing_relists")
      .select("id, organization_id, ml_account_id, parent_item_id, child_item_id, status, failure_reason, requested_by")
      .eq("id", parsed.data.relistId)
      .maybeSingle();

    if (loaded.error !== null) {
      return { status: "failed", retryable: true, reason: `falha ao ler a operação: ${loaded.error.message}` };
    }

    const operation: OperationRow | null = loaded.data;

    if (operation === null) {
      context.logger.warn("relist_execute_operation_missing", { relist_id: parsed.data.relistId });

      return { status: "done", processed: 0 };
    }

    const ctx: TransitionContext = { db: deps.db, logger: context.logger, operation };

    // Retomada no MEIO da janela perigosa: entre persistir RELISTING e ler a
    // resposta do POST não há como saber se o filho nasceu. Repetir o POST
    // poderia criar dois filhos — gente decide (regra 3 do cabeçalho).
    if (operation.status === "RELISTING") {
      const marked = await transition(
        ctx,
        "RELISTING",
        "RELIST_FAILED",
        { failure_reason: "execução interrompida após o POST /relist ser emitido — impossível saber se o filho nasceu" },
        "EXECUCAO_INTERROMPIDA",
      );

      if (!marked.ok) {
        return { status: "failed", retryable: true, reason: marked.message ?? "falha ao registrar a interrupção" };
      }

      return { status: "done", processed: 1 };
    }

    // D-163 — RELISTED não é mais noop: o ato remoto já terminou e esta
    // retomada executa somente leituras remotas + a transação local de
    // remapeamento. Falhar aqui é seguro para retry; a função é idempotente.
    if (operation.status === "RELISTED") {
      const tokenResult = await ensureAccessToken(deps, operation.ml_account_id, now);

      if (!tokenResult.ok) {
        return { status: "failed", retryable: tokenResult.retryable, reason: tokenResult.reason };
      }

      return remapRelistedOperation(deps, context, operation, tokenResult.accessToken);
    }

    // REMAPPED retomado: o único trabalho possivelmente pendente é a
    // MEDIÇÃO (D-164) — garantia idempotente, sem nenhuma chamada remota.
    if (operation.status === "REMAPPED") {
      if (operation.child_item_id === null) {
        return { status: "failed", retryable: false, reason: "operação REMAPPED sem child_item_id — incoerência estrutural" };
      }

      const measured = await ensureRelistMeasurement(deps, context.logger, {
        id: operation.id,
        organization_id: operation.organization_id,
        ml_account_id: operation.ml_account_id,
        parent_item_id: operation.parent_item_id,
        child_item_id: operation.child_item_id,
        requested_by: operation.requested_by,
      });

      if (!measured.ok) {
        return { status: "failed", retryable: true, reason: measured.message ?? "falha ao registrar a medição" };
      }

      return { status: "done", processed: 0 };
    }

    // Retomada humana (regra 6, D-364): a única saída de RELIST_FAILED.
    if (operation.status === "RELIST_FAILED" && retomada) {
      return resumeAfterRejection(deps, context, ctx, now);
    }

    // Idempotência de retomada: estado que este job não trata é trabalho já
    // resolvido (terminais) — nunca refazer. RELIST_FAILED sem `retomada` cai
    // aqui (gente decide), e `retomada` pedida para qualquer outro estado
    // também: ela nunca fecha pai nem abre caminho novo.
    if (retomada || (operation.status !== "REQUESTED" && operation.status !== "CLOSING" && operation.status !== "CLOSED")) {
      context.logger.info("relist_execute_noop", { relist_id: operation.id, status: operation.status, retomada });

      return { status: "done", processed: 0 };
    }

    const tokenResult = await ensureAccessToken(deps, operation.ml_account_id, now);

    if (!tokenResult.ok) {
      return { status: "failed", retryable: tokenResult.retryable, reason: tokenResult.reason };
    }

    const accessToken = tokenResult.accessToken;

    // O item AO VIVO — base do re-preflight e do corpo do relist. Um item
    // que sumiu do remoto é RELIST_FAILED se já fechamos (pai fechado sem
    // filho), ou PREFLIGHT_FAILED se ainda não tocamos nada.
    let parentRaw: unknown;

    try {
      parentRaw = await deps.mercadoLivre.request({
        method: "GET",
        path: `/items/${operation.parent_item_id}`,
        accessToken,
        schema: z.unknown(),
      });
    } catch (error) {
      if (error instanceof MercadoLivreApiError && error.errorClass === "not_retryable") {
        const to = operation.status === "REQUESTED" ? "PREFLIGHT_FAILED" : "RELIST_FAILED";
        const marked = await transition(
          ctx,
          operation.status,
          to,
          { failure_reason: `o Mercado Livre não devolveu o anúncio pai (${error.message})` },
          "PAI_INDISPONIVEL",
        );

        if (!marked.ok) {
          return { status: "failed", retryable: true, reason: marked.message ?? "falha ao registrar o veredito" };
        }

        return { status: "done", processed: 1 };
      }

      throw error;
    }

    // Re-preflight NA HORA — só enquanto nada remoto foi feito (REQUESTED).
    // Depois de CLOSING, reprovar não desfaz o fechamento; o fluxo segue e
    // as falhas reais aparecem nos próprios passos.
    if (operation.status === "REQUESTED") {
      // D-360: o estoque do Full é relido na hora — ele pode ter recebido
      // unidades desde o pedido. Falha passageira relança antes de qualquer
      // transição; o PUT não sai sem a conferência.
      const fullStock = await readRelistFullStock({
        mercadoLivre: deps.mercadoLivre,
        accessToken,
        inventoryIds: collectRelistInventoryIds(parentRaw),
        logger: context.logger,
        logFields: { relist_id: operation.id, item_id: operation.parent_item_id },
      });
      const preflight = evaluateRelistPreflight(parentRaw, fullStock);

      context.logger.info("relist_execute_preflight", {
        relist_id: operation.id,
        approved: preflight.approved,
        blocks: preflight.blocks.map((block) => block.code),
        warnings: preflight.warnings.map((warning) => warning.code),
        full_stock: describeFullStock(fullStock),
      });

      if (!preflight.approved) {
        const marked = await transition(
          ctx,
          "REQUESTED",
          "PREFLIGHT_FAILED",
          { failure_reason: preflight.blocks.map((block) => block.descricao).join(" ") },
          preflight.blocks.map((block) => block.code).join(","),
        );

        if (!marked.ok) {
          return { status: "failed", retryable: true, reason: marked.message ?? "falha ao registrar o preflight" };
        }

        return { status: "done", processed: 1 };
      }
    }

    const parentParsed = parentForRelistSchema.safeParse(parentRaw);

    if (!parentParsed.success) {
      return { status: "failed", retryable: false, reason: "o anúncio pai não tem os campos que o relist herda" };
    }

    const parent = parentParsed.data;

    // O corpo é montado ANTES de fechar (D-364). Em REQUESTED o preflight já
    // barrou o pai sem estoque, pelo mesmo predicado; chegar aqui sem corpo é
    // retomada de CLOSING/CLOSED — e aí o PUT e o POST não saem.
    const body = buildRelistBody(parent);

    if (body === null) {
      context.logger.error("relist_execute_without_stock", {
        relist_id: operation.id,
        status: operation.status,
        parent_status: parent.status,
      });

      return { status: "failed", retryable: false, reason: "o anúncio pai não tem estoque para republicar — o POST não sai" };
    }

    // ---- FECHAR O PAI ----------------------------------------------------
    if (operation.status === "REQUESTED" || operation.status === "CLOSING") {
      if (parent.status === "closed") {
        // Retomada com o pai já fechado (crash entre o PUT e o registro), ou
        // fechado por fora. De REQUESTED, ainda dá para desistir com
        // segurança? Não: fechado é irreversível — seguir para o relist é o
        // único caminho que não abandona um pai fechado sem filho.
        if (operation.status === "REQUESTED") {
          const closing = await transition(ctx, "REQUESTED", "CLOSING", {}, "PAI_JA_FECHADO");

          if (!closing.ok) {
            return { status: "failed", retryable: true, reason: closing.message ?? "falha ao registrar CLOSING" };
          }
        }
      } else {
        if (operation.status === "REQUESTED") {
          // Estado persistido ANTES do ato que ele descreve (regra 1).
          const closing = await transition(ctx, "REQUESTED", "CLOSING", {}, null);

          if (!closing.ok) {
            return { status: "failed", retryable: true, reason: closing.message ?? "falha ao registrar CLOSING" };
          }
        }

        const closed = await deps.mercadoLivre.request({
          method: "PUT",
          path: `/items/${operation.parent_item_id}`,
          accessToken,
          body: { status: "closed" },
          schema: closeItemResponseSchema,
        });

        if (closed.status !== "closed") {
          // O PUT respondeu mas o pai NÃO fechou — nada destrutivo
          // aconteceu; terminar em CLOSE_FAILED reabre o caminho (D-159).
          const marked = await transition(
            ctx,
            "CLOSING",
            "CLOSE_FAILED",
            { failure_reason: `o fechamento respondeu status "${closed.status}" — o pai continua como estava` },
            "FECHAMENTO_NAO_APLICADO",
          );

          if (!marked.ok) {
            return { status: "failed", retryable: true, reason: marked.message ?? "falha ao registrar CLOSE_FAILED" };
          }

          return { status: "done", processed: 1 };
        }
      }

      const confirmed = await transition(ctx, "CLOSING", "CLOSED", {}, null);

      if (!confirmed.ok) {
        return { status: "failed", retryable: true, reason: confirmed.message ?? "falha ao registrar CLOSED" };
      }
    }

    // ---- REPUBLICAR ------------------------------------------------------
    // RELISTING persistido ANTES do POST (regra 1): daqui em diante, um
    // crash retoma como RELIST_FAILED, nunca como segundo POST.
    const relisting = await transition(ctx, "CLOSED", "RELISTING", {}, null);

    if (!relisting.ok) {
      return { status: "failed", retryable: true, reason: relisting.message ?? "falha ao registrar RELISTING" };
    }

    return postRelistAndSettle(deps, context, ctx, accessToken, body);
  };
}
