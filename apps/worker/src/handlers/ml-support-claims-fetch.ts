import type { AdminClient } from "@sb/db";
import type { MercadoLivreClient } from "@sb/mercado-livre";
import type { Logger } from "@sb/observability";
import { z } from "zod";

import { claimSchema } from "./claim-schema.js";
import { ingestSupportClaim } from "./ingest-support-claim.js";

/**
 * Varredura de reclamações — `GET /post-purchase/v1/claims/search`, contrato
 * confirmado por leitura ao vivo em 2026-08-27 (`docs/MERCADO_LIVRE.md` 2.12).
 *
 * **Duas diferenças importantes em relação à varredura de Perguntas (D-089):**
 *
 * 1. **Aqui existe janela de verdade.** A busca aceita
 *    `range=last_updated:after:...`, filtro que a de Perguntas não tem — foi
 *    justamente a ausência dele que forçou o recorte por `status=UNANSWERED`
 *    lá. Aqui dá para reconciliar de checkpoint em checkpoint, sem varrer o
 *    histórico inteiro e sem a lacuna de "respondida por fora some da busca".
 *
 * 2. **O recorte por vendedor é exigência da própria API, não escolha.** A doc
 *    é explícita: `status=opened` sozinho é "consulta não acotada e custosa",
 *    com "risco de rate limiting ou bloqueio da aplicação". A recomendação
 *    oficial — `players.user_id` + `players.role` — é o que usamos.
 *
 * **Os DOIS papéis são varridos.** O vendedor costuma ser `respondent`, mas em
 * `cancel_sale` é ele quem reclama, e `players.role` é obrigatório junto de
 * `players.user_id` (a API devolve 400 sem ele). Varrer só `respondent`
 * perderia silenciosamente uma categoria inteira de reclamação.
 */

const PAGE_SIZE = 100;
/** `offset + limit` precisa ficar abaixo de 10000 (regra da própria API). */
const MAX_PAGES = 20;
const SELLER_ROLES = ["respondent", "complainant"] as const;

const searchResponseSchema = z.object({
  data: z.array(claimSchema).nullable().optional(),
  results: z.array(claimSchema).nullable().optional(),
  paging: z
    .object({ total: z.number().nullable().optional() })
    .nullable()
    .optional(),
});

export interface FetchSupportClaimsOptions {
  db: AdminClient;
  organizationId: string;
  mlAccountId: string;
  sellerId: number;
  mercadoLivre: MercadoLivreClient;
  accessToken: string;
  /** Início da janela; ISO COM milissegundos, exigência da API. */
  updatedAfter: string;
  logger: Logger;
}

export interface FetchSupportClaimsResult {
  itemsProcessed: number;
  itemsFailed: number;
  remoteTotal: number;
  truncated: boolean;
  latestRecordAt: string | null;
}

export async function fetchSupportClaims(
  options: FetchSupportClaimsOptions,
): Promise<FetchSupportClaimsResult> {
  let itemsProcessed = 0;
  let itemsFailed = 0;
  let remoteTotal = 0;
  let truncated = false;
  let latestRecordAt: string | null = null;
  const seen = new Set<number>();

  for (const role of SELLER_ROLES) {
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const offset = page * PAGE_SIZE;
      // **Sem `sort`, e a ausência é deliberada (D-109).** A primeira versão
      // desta varredura mandava `sort=last_updated:asc` e a API devolveu 400
      // em 100% das 28 execuções. A doc documenta o FORMATO de `sort`
      // (`campo:asc`) mas nunca diz quais campos são ordenáveis — o único
      // exemplo oficial usa `date_created:desc`. `last_updated:asc` foi
      // suposição, e a REGRA ABSOLUTA existe para impedir exatamente isso.
      //
      // A varredura não precisa de ordenação: ela calcula o `max(last_updated)`
      // por conta própria ao percorrer os resultados.
      const query = new URLSearchParams({
        "players.user_id": String(options.sellerId),
        "players.role": role,
        range: `last_updated:after:${options.updatedAfter}`,
        limit: String(PAGE_SIZE),
        offset: String(offset),
      });

      const response = await options.mercadoLivre.request({
        method: "GET",
        path: `/post-purchase/v1/claims/search?${query.toString()}`,
        accessToken: options.accessToken,
        schema: searchResponseSchema,
      });

      // O material oficial mostra o array ora em `data`, ora em `results`.
      // Aceitar os dois é mais barato que apostar num deles (D-097).
      const claims = response.data ?? response.results ?? [];

      remoteTotal += response.paging?.total ?? claims.length;

      for (const claim of claims) {
        // Um claim pode aparecer nas duas varreduras se o vendedor ocupar os
        // dois papéis; ingerir duas vezes seria só desperdício de chamada.
        if (seen.has(claim.id)) {
          continue;
        }

        seen.add(claim.id);

        const ingested = await ingestSupportClaim(
          { db: options.db, mercadoLivre: options.mercadoLivre },
          {
            organizationId: options.organizationId,
            mlAccountId: options.mlAccountId,
            source: "RECONCILIATION",
          },
          options.accessToken,
          String(claim.id),
          claim,
          options.logger,
        );

        if (ingested) {
          itemsProcessed += 1;
        } else {
          itemsFailed += 1;
        }

        const updatedAt = claim.last_updated ?? claim.date_created ?? null;

        if (updatedAt !== null && (latestRecordAt === null || updatedAt > latestRecordAt)) {
          latestRecordAt = updatedAt;
        }
      }

      if (claims.length < PAGE_SIZE) {
        break;
      }

      if (page === MAX_PAGES - 1) {
        // Truncar é reportado, nunca escondido: `done` sobre um recorte é a
        // mentira que D-067 auditou.
        truncated = true;
      }
    }
  }

  return { itemsProcessed, itemsFailed, remoteTotal, truncated, latestRecordAt };
}
