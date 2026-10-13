import { ShopeeApiError } from "@sb/shopee";
import { z, ZodError } from "zod";

import type { Enqueuer } from "../enqueue.js";
import type { JobOutcome } from "../job-outcome.js";
import type { HandlerContext } from "../router.js";
import type { ShopeeTokenDeps } from "./shopee-token.js";

/**
 * O que os jobs da Shopee (D-426 a D-428) têm em comum: as dependências, a
 * leitura da loja conectada e a classificação da falha.
 */

export interface ShopeeJobDeps extends ShopeeTokenDeps {
  enqueuer: Enqueuer;
  now?: () => Date;
}

export const shopeeShopPayloadSchema = z.object({ shopeeShopId: z.uuid() });

export interface LojaConectada {
  id: string;
  organization_id: string;
  environment: string;
  shop_id: number;
  status: string;
  orders_synced_until: string | null;
}

/**
 * A loja do payload, se CONECTADA e do ambiente do cliente. Loja apagada, em
 * erro ou de outro ambiente encerra a tarefa SEM erro (`done`, 0): reconectar
 * retoma do marco. Falha ao ler é passageira.
 */
export async function lerLojaConectada(
  deps: ShopeeJobDeps,
  context: HandlerContext,
  evento: string,
): Promise<{ loja: LojaConectada } | { outcome: JobOutcome }> {
  const parsed = shopeeShopPayloadSchema.safeParse(context.payload);

  if (!parsed.success) {
    return { outcome: { status: "failed", retryable: false, reason: "payload sem shopeeShopId" } };
  }

  const lida = await deps.db
    .from("shopee_shops")
    // Só colunas que já existiam antes da D-428: um worker publicado antes da
    // migration do catálogo não pode derrubar os pedidos e o financeiro.
    .select("id, organization_id, environment, shop_id, status, orders_synced_until")
    .eq("id", parsed.data.shopeeShopId)
    .maybeSingle();

  if (lida.error !== null) {
    return { outcome: { status: "failed", retryable: true, reason: `falha ao ler a loja: ${lida.error.message}` } };
  }

  const loja = lida.data;

  if (loja?.status !== "CONNECTED" || loja.environment !== deps.client.environment) {
    context.logger.info(evento, {
      shopee_shop_id: parsed.data.shopeeShopId,
      motivo: loja === null ? "loja inexistente" : loja.status !== "CONNECTED" ? "loja não conectada" : "outro ambiente",
    });

    return { outcome: { status: "done", processed: 0 } };
  }

  return { loja };
}

/**
 * Erro da Shopee vira falha da tarefa: passageira em 429, 5xx,
 * `error_server`/`error_network` e em erro que não é da Shopee (rede,
 * timeout); definitiva no resto e na resposta fora do contrato.
 */
export function falhaDaShopee(error: unknown, padrao: string): JobOutcome {
  if (error instanceof ZodError) {
    return { status: "failed", retryable: false, reason: "resposta da Shopee fora do contrato" };
  }

  return {
    status: "failed",
    retryable: !(error instanceof ShopeeApiError) || error.errorClass === "retryable",
    reason: error instanceof Error ? error.message : padrao,
  };
}
