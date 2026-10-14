import { z } from "zod";

import { ShopeeApiError, type ShopeeClient } from "./client.js";

/**
 * Repasse (D-451) — `v2.payment.get_escrow_list`, conferida na referência
 * oficial em 14/10/2026.
 *
 * - "The accounting list of order": cada pedido cujo escrow foi LIBERADO à
 *   loja numa janela de `escrow_release_time`, com o valor liquidado
 *   (`payout_amount`, "The settlement amount") e o momento da liberação.
 * - `release_time_from`/`release_time_to` obrigatórios; até 100 por página
 *   (padrão 40), `page_no` a partir de 1, `more` diz se há outra página.
 * - A referência não dá janela máxima: a V3 usa 15 dias, o limite das outras
 *   listas do pagamento (`get_wallet_transaction_list`, `get_payout_detail`).
 * - O exemplo da referência traz `payout_amount` inteiro (57334) enquanto a
 *   tabela diz `float` (5733.04): a unidade se confere no sandbox, contra o
 *   `escrow_amount` do mesmo pedido.
 * - Permissão: o app Seller In House System pode chamar.
 *
 * Vale para loja local (a do Brasil). `get_payout_detail`/`get_payout_info`
 * são só de vendedor internacional (CB) e não servem.
 */

/** A janela de uma chamada: a referência não dá máximo; 15 dias como as outras listas do pagamento. */
export const ESCROW_LIST_WINDOW_S = 15 * 24 * 3600;
export const ESCROW_LIST_PAGE_SIZE = 100;

export const shopeeEscrowReleaseSchema = z.object({
  order_sn: z.string().min(1),
  // Ausente fica nulo: a liberação é conhecida, o valor não.
  payout_amount: z.number().nullable().optional(),
  escrow_release_time: z.number().int(),
});

export type ShopeeEscrowRelease = z.infer<typeof shopeeEscrowReleaseSchema>;

const escrowListSchema = z.object({
  response: z.object({
    more: z.boolean(),
    // Página vazia pode vir sem a lista.
    escrow_list: z.array(shopeeEscrowReleaseSchema).nullable().optional(),
  }),
});

export interface EscrowListPage {
  releases: ShopeeEscrowRelease[];
  more: boolean;
}

/**
 * "Nada liberado na janela": `income_not_found` ("The escrow income not
 * found"), `error_not_found` e `error_data` com "data not exist". O mesmo
 * `error_data` também significa "parse data failed" — esse é falha, não
 * vazio. A conferir no sandbox qual a Shopee manda numa janela sem repasse.
 */
export function isEscrowListEmpty(error: unknown): boolean {
  if (!(error instanceof ShopeeApiError) || error.baseCode === null) return false;

  if (error.baseCode === "income_not_found" || error.baseCode === "error_not_found") return true;

  return error.baseCode === "error_data" && /not exist/i.test(error.message);
}

/** Uma página dos repasses liberados na janela (`releaseTimeFrom`/`releaseTimeTo` em epoch, segundos). */
export async function getEscrowListPage(
  client: ShopeeClient,
  shop: { accessToken: string; shopId: number },
  options: { releaseTimeFrom: number; releaseTimeTo: number; pageNo: number },
): Promise<EscrowListPage> {
  const resposta = await client.request({
    method: "GET",
    path: "/api/v2/payment/get_escrow_list",
    shop,
    query: {
      release_time_from: String(options.releaseTimeFrom),
      release_time_to: String(options.releaseTimeTo),
      page_size: String(ESCROW_LIST_PAGE_SIZE),
      page_no: String(options.pageNo),
    },
    schema: escrowListSchema,
  });

  return { releases: resposta.response.escrow_list ?? [], more: resposta.response.more };
}
