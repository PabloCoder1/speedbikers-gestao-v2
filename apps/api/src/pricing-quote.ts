import type { AdminClient } from "@sb/db";
import { freteGratisEfetivo } from "@sb/domain";
import {
  LOGISTICAS_ML,
  MercadoLivreApiError,
  decryptToken,
  quoteFreeShippingCost,
  quoteSaleFixedFee,
  type MercadoLivreClient,
  type ShippingQuote,
} from "@sb/mercado-livre";
import type { Logger } from "@sb/observability";
import { z } from "zod";

import type { Caller } from "./auth.js";

/**
 * Cotação do frete do Mercado Livre para a calculadora de preço (D-359).
 *
 * **A primeira chamada SÍNCRONA ao Mercado Livre feita pela `api`**, e por
 * isso as duas escolhas abaixo são deliberadas:
 *
 * 1. **Leitura curta, sem fila.** É um GET de uma estimativa, que a pessoa
 *    espera na tela. `docs/ARCHITECTURE.md` §5 veta trabalho LONGO inline
 *    ("se pode passar de ~5 s, enfileira"); o cliente HTTP tem retry limitado,
 *    e a rota corta em `TIMEOUT_MS`.
 * 2. **O token é só LIDO, nunca renovado aqui.** O `refresh_token` do Mercado
 *    Livre é de uso único (`docs/MERCADO_LIVRE.md` §6), e quem renova é o
 *    worker, com trava (`apps/worker/src/handlers/ml-token.ts`). Uma segunda
 *    renovação vinda da `api` seria o caminho para desconectar a conta. Token
 *    perto de vencer → 503 "tente de novo em instantes": o worker renova em
 *    todo sync, e a calculadora não vale uma conta desconectada.
 *
 * D-421: duas leituras, em sequência -- a cotação do frete, com o frete grátis
 * da venda (obrigatório a partir de R$ 79; abaixo, a escolha do vendedor), e a
 * tarifa fixa de `listing_prices`, que precisa do peso faturável da primeira.
 * O teto de `TIMEOUT_MS` vale para as duas juntas.
 *
 * Autorização: qualquer papel com acesso à CONTA (é leitura de preço, não
 * escrita). Fronteira de organização e permissão por conta refeitas aqui, como
 * na republicação — o `AdminClient` passa por cima da RLS.
 */

export interface PricingQuoteDeps {
  db: AdminClient;
  logger: Logger;
  encryptionKey: Buffer;
  client: MercadoLivreClient;
  now?: () => Date;
}

/** Margem antes de vencer em que o token já não é usado — a mesma do worker. */
const BUFFER_TOKEN_MS = 5 * 60 * 1000;
export const TIMEOUT_MS = 8_000;

export const pricingQuoteRequestSchema = z.object({
  mlAccountId: z.uuid(),
  alturaCm: z.number().positive().max(300),
  larguraCm: z.number().positive().max(300),
  comprimentoCm: z.number().positive().max(300),
  pesoG: z.number().positive().max(200_000),
  preco: z.number().positive().max(10_000_000),
  tipoAnuncio: z.enum(["classico", "premium"]),
  logistica: z.enum(LOGISTICAS_ML),
  /** Abaixo de R$ 79: o vendedor oferece frete grátis? Ausente = não (a tela antiga não mandava). */
  ofereceFreteGratis: z.boolean().default(false),
});

export type PricingQuoteRequest = z.input<typeof pricingQuoteRequestSchema>;

export type PricingQuoteOutcome =
  | {
      status: "ok";
      cotacao: ShippingQuote;
      /** A tarifa fixa por venda (`listing_prices`); zero quando o Mercado Livre não cobra. */
      tarifaFixa: number;
      /** O frete grátis que valeu na cotação: obrigatório a partir de R$ 79, escolha abaixo. */
      freteGratis: boolean;
    }
  | { status: "not_found" }
  | { status: "unavailable"; reason: string }
  | { status: "error"; reason: string };

export async function quoteMlShipping(
  deps: PricingQuoteDeps,
  caller: Caller,
  request: PricingQuoteRequest,
): Promise<PricingQuoteOutcome> {
  const now = deps.now?.() ?? new Date();

  const account = await deps.db
    .from("ml_accounts")
    .select("id, organization_id, seller_id, status")
    .eq("id", request.mlAccountId)
    .maybeSingle();

  if (account.error !== null) return { status: "error", reason: account.error.message };

  // "Não encontrado" nunca vira "sem permissão" — padrão D-096.
  if (account.data?.organization_id !== caller.organizationId) return { status: "not_found" };

  if (caller.role !== "ADMIN") {
    const permission = await deps.db
      .from("user_account_permissions")
      .select("user_id")
      .eq("user_id", caller.userId)
      .eq("ml_account_id", request.mlAccountId)
      .maybeSingle();

    if (permission.error !== null) return { status: "error", reason: permission.error.message };
    if (permission.data === null) return { status: "not_found" };
  }

  if (account.data.status !== "CONNECTED" || account.data.seller_id === null) {
    return { status: "unavailable", reason: "a conta não está conectada ao Mercado Livre" };
  }

  const credentials = await deps.db
    .from("ml_credentials")
    .select("access_token_ciphertext, access_token_expires_at")
    .eq("ml_account_id", request.mlAccountId)
    .maybeSingle();

  if (credentials.error !== null) return { status: "error", reason: credentials.error.message };
  if (credentials.data === null) return { status: "unavailable", reason: "a conta não tem credenciais gravadas" };

  if (new Date(credentials.data.access_token_expires_at).getTime() - now.getTime() <= BUFFER_TOKEN_MS) {
    return {
      status: "unavailable",
      reason: "o acesso ao Mercado Livre está sendo renovado — tente de novo em alguns minutos",
    };
  }

  let relogio: ReturnType<typeof setTimeout> | undefined;

  const freteGratis = freteGratisEfetivo(request.preco, request.ofereceFreteGratis ?? false);
  const accessToken = decryptToken(credentials.data.access_token_ciphertext, deps.encryptionKey);
  const listingTypeId = request.tipoAnuncio === "premium" ? "gold_pro" : "gold_special";
  const sellerId = account.data.seller_id;

  try {
    const { cotacao, tarifaFixa } = await Promise.race([
      (async () => {
        const cotacao = await quoteFreeShippingCost(deps.client, {
          sellerId,
          accessToken,
          alturaCm: request.alturaCm,
          larguraCm: request.larguraCm,
          comprimentoCm: request.comprimentoCm,
          pesoG: request.pesoG,
          preco: request.preco,
          listingTypeId,
          logistica: request.logistica,
          freteGratis,
        });
        const tarifaFixa = await quoteSaleFixedFee(deps.client, {
          accessToken,
          preco: request.preco,
          listingTypeId,
          logistica: request.logistica,
          pesoFaturavelG: cotacao.pesoFaturavelG ?? request.pesoG,
        });

        return { cotacao, tarifaFixa };
      })(),
      new Promise<never>((_resolve, reject) => {
        relogio = setTimeout(() => {
          reject(new Error("o Mercado Livre demorou para responder"));
        }, TIMEOUT_MS);
      }),
    ]);

    return { status: "ok", cotacao, tarifaFixa, freteGratis };
  } catch (error) {
    const reason =
      error instanceof MercadoLivreApiError
        ? `o Mercado Livre recusou a cotação (HTTP ${String(error.status)})`
        : error instanceof Error
          ? error.message
          : "falha ao cotar o frete";

    deps.logger.warn("pricing_quote_failed", { ml_account_id: request.mlAccountId, reason });

    return { status: "unavailable", reason };
  } finally {
    clearTimeout(relogio);
  }
}
