import type { AdminClient } from "@sb/db";
import {
  LOGISTICAS_ML,
  MercadoLivreApiError,
  decryptToken,
  quoteFreeShippingCost,
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
});

export type PricingQuoteRequest = z.infer<typeof pricingQuoteRequestSchema>;

export type PricingQuoteOutcome =
  | { status: "ok"; cotacao: ShippingQuote }
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

  try {
    const cotacao = await Promise.race([
      quoteFreeShippingCost(deps.client, {
        sellerId: account.data.seller_id,
        accessToken: decryptToken(credentials.data.access_token_ciphertext, deps.encryptionKey),
        alturaCm: request.alturaCm,
        larguraCm: request.larguraCm,
        comprimentoCm: request.comprimentoCm,
        pesoG: request.pesoG,
        preco: request.preco,
        listingTypeId: request.tipoAnuncio === "premium" ? "gold_pro" : "gold_special",
        logistica: request.logistica,
      }),
      new Promise<never>((_resolve, reject) => {
        relogio = setTimeout(() => {
          reject(new Error("o Mercado Livre demorou para responder"));
        }, TIMEOUT_MS);
      }),
    ]);

    return { status: "ok", cotacao };
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
