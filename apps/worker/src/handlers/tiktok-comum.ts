import { TikTokShopApiError } from "@sb/tiktok-shop";
import { z, ZodError } from "zod";

import type { Enqueuer } from "../enqueue.js";
import type { JobOutcome } from "../job-outcome.js";
import type { HandlerContext } from "../router.js";
import type { TikTokTokenDeps } from "./tiktok-token.js";

/**
 * Infraestrutura comum dos jobs do TikTok Shop no worker (D-833, `M04`):
 * leitura da loja conectada com isolamento multi-tenant estrito e
 * classificação consistente de falhas do cliente `@sb/tiktok-shop`.
 */

export interface TikTokJobDeps extends TikTokTokenDeps {
  enqueuer: Enqueuer;
  now?: () => Date;
}

export const tiktokShopPayloadSchema = z.object({ tiktokShopId: z.uuid() });

export interface LojaTikTokConectada {
  id: string;
  organization_id: string;
  shop_id: string;
  shop_name: string | null;
  region: string | null;
  status: string;
}

/**
 * Lê a loja TikTok Shop do payload sob `service_role`, impondo guarda
 * multi-tenant contra `expectedOrganizationId` (D-814/D-832/D-833).
 *
 * - Payload inválido -> `failed` (`retryable: false`)
 * - Erro transitório de banco -> `failed` (`retryable: true`)
 * - Loja inexistente ou não `CONNECTED` -> `done` (`processed: 0`)
 * - `organization_id` divergente do envelope -> `failed` (`retryable: false`)
 */
export async function lerLojaTikTokConectada(
  deps: Pick<TikTokJobDeps, "db">,
  context: HandlerContext,
  evento: string,
  expectedOrganizationId: string,
): Promise<{ loja: LojaTikTokConectada } | { outcome: JobOutcome }> {
  const parsed = tiktokShopPayloadSchema.safeParse(context.payload);

  if (!parsed.success) {
    return { outcome: { status: "failed", retryable: false, reason: "payload sem tiktokShopId" } };
  }

  const lida = await deps.db
    .from("tiktok_shops")
    .select("id, organization_id, shop_id, shop_name, region, status")
    .eq("id", parsed.data.tiktokShopId)
    .maybeSingle();

  if (lida.error !== null) {
    return { outcome: { status: "failed", retryable: true, reason: `falha ao ler a loja TikTok: ${lida.error.message}` } };
  }

  const loja = lida.data;

  if (loja?.status !== "CONNECTED") {
    context.logger.info(evento, {
      tiktok_shop_id: parsed.data.tiktokShopId,
      motivo: loja === null ? "loja inexistente" : "loja não conectada",
    });

    return { outcome: { status: "done", processed: 0 } };
  }

  if (loja.organization_id !== expectedOrganizationId) {
    return { outcome: { status: "failed", retryable: false, reason: "loja do TikTok Shop pertence a outra organização" } };
  }

  return { loja };
}

/**
 * Classifica falhas do TikTok Shop para o contrato de `JobOutcome`:
 * - `ZodError` ou `RangeError` (contrato/validação) -> `retryable: false`
 * - `TikTokShopApiError` -> `retryable` somente quando `errorClass === "retryable"`
 * - Demais erros (rede/timeout/transporte) -> `retryable: true`
 */
export function falhaDoTikTok(error: unknown, padrao: string): JobOutcome {
  if (error instanceof ZodError) {
    return { status: "failed", retryable: false, reason: "resposta do TikTok Shop fora do contrato" };
  }

  if (error instanceof RangeError) {
    return { status: "failed", retryable: false, reason: error.message };
  }

  if (error instanceof TikTokShopApiError) {
    return {
      status: "failed",
      retryable: error.errorClass === "retryable",
      reason: error.message,
    };
  }

  return {
    status: "failed",
    retryable: true,
    reason: error instanceof Error ? error.message : padrao,
  };
}
