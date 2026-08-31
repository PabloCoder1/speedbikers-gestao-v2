import type { AdminClient } from "@sb/db";
import { canTransitionRelist, evaluateRelistPreflight } from "@sb/domain";
import type { MercadoLivreClient, MercadoLivreOAuthConfig } from "@sb/mercado-livre";
import { MercadoLivreApiError } from "@sb/mercado-livre";
import type { Logger } from "@sb/observability";
import { z } from "zod";

import type { JobOutcome } from "../job-outcome.js";
import type { HandlerContext, JobHandler } from "../router.js";
import { ensureAccessToken } from "./ml-token.js";

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
 * 5. **Filho só é confirmado pelo id DIFERENTE do pai**: o defeito
 *    registrado da própria doc (resposta com variações devolvendo o id do
 *    pai) não é tratado como contrato — resposta ambígua é RELIST_FAILED.
 */

const payloadSchema = z.object({ relistId: z.uuid() });

/** PUT /items/{id} {status:"closed"} — contrato confirmado em 2.16. */
const closeItemResponseSchema = z.object({ id: z.string(), status: z.string() });

/** POST /items/{id}/relist — sem status de sucesso documentado; o id é o que importa. */
const relistResponseSchema = z.object({ id: z.string() });

/** Campos do pai usados para herdar o corpo do relist — lidos do item AO VIVO. */
const parentForRelistSchema = z.object({
  id: z.string(),
  status: z.string(),
  price: z.number(),
  available_quantity: z.number().int(),
  listing_type_id: z.string(),
});

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
  status: string;
}

interface TransitionContext {
  db: AdminClient;
  logger: Logger;
  operation: OperationRow;
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
): Promise<{ ok: boolean; message?: string }> {
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
    return { ok: false, message: `a operação não estava mais em ${from} — transição não aplicada` };
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

export function createRelistExecuteHandler(deps: RelistExecuteDeps): JobHandler {
  return async (_envelope, context: HandlerContext): Promise<JobOutcome> => {
    const parsed = payloadSchema.safeParse(context.payload);

    if (!parsed.success) {
      return { status: "failed", retryable: false, reason: "payload inválido para relist.execute" };
    }

    const now = deps.now?.() ?? new Date();

    const loaded = await deps.db
      .from("listing_relists")
      .select("id, organization_id, ml_account_id, parent_item_id, status")
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

    // Idempotência de retomada: estado que este job não trata é trabalho já
    // feito (RELISTED/REMAPPED) ou já resolvido (terminais) — nunca refazer.
    if (operation.status !== "REQUESTED" && operation.status !== "CLOSING" && operation.status !== "CLOSED") {
      context.logger.info("relist_execute_noop", { relist_id: operation.id, status: operation.status });

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
      const preflight = evaluateRelistPreflight(parentRaw);

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

    let child: { id: string };

    try {
      child = await deps.mercadoLivre.request({
        method: "POST",
        path: `/items/${operation.parent_item_id}/relist`,
        accessToken,
        // Herda do pai AO VIVO — o contrato mínimo confirmado em 2.16.
        body: {
          price: parent.price,
          quantity: parent.available_quantity,
          listing_type_id: parent.listing_type_id,
        },
        schema: relistResponseSchema,
      });
    } catch (error) {
      // Regra 4: NUNCA re-tentar o POST — um 5xx pode significar que o filho
      // nasceu. Pai fechado sem filho confirmado = RELIST_FAILED, gente decide.
      const message = error instanceof Error ? error.message : "falha desconhecida no POST /relist";
      const marked = await transition(
        ctx,
        "RELISTING",
        "RELIST_FAILED",
        { failure_reason: `o POST /relist falhou e não é seguro repetir: ${message}` },
        "POST_FALHOU",
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

    return { status: "done", processed: 1 };
  };
}
