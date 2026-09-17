import type { MercadoLivreClient } from "@sb/mercado-livre";
import type { Logger } from "@sb/observability";
import { z } from "zod";

/**
 * A logística do ENVIO de um pedido (D-352) — o sinal que diz se a venda saiu
 * do galpão do Mercado Livre (Full) ou da loja.
 *
 * **Por que o envio, e não o pedido.** `GET /orders/{id}` traz
 * `shipping: { id }` e nada mais de logística: medido em 4 pedidos reais de
 * 2026-09-17 (`scratchpad/d352/leitura-real/`), e é também o que
 * `order-schema.ts` sempre leu (D-165). `orders.tags` tem 21 valores distintos
 * em 331 mil pedidos e NENHUM diz Full. Quem responde é
 * `GET /shipments/{id}.logistic_type` — na mesma leitura, `"fulfillment"` em 3
 * envios (um deles de anúncio COM variação) e `"cross_docking"` em 1.
 *
 * **O custo é conhecido e já é pago por outro job.** `sync-order-financials.ts`
 * chama `GET /shipments/{id}/costs` uma vez por pedido, ~963 por dia; esta é
 * uma chamada da MESMA ordem de grandeza, e só para o pedido que vai deduzir de
 * fato (`persist-order.ts` decide).
 *
 * **Falhar aqui nunca derruba o job.** Uma leitura que não volta deixa o pedido
 * PENDENTE: ele baixa a loja agora (R2 — nunca presumir Full) e ganha o
 * `ESTORNO_FULL` quando o sinal chegar. Derrubar a página inteira por causa de
 * um envio seria trocar um erro de estoque por uma parada de sincronização, e a
 * pendência já é reversível por desenho.
 */

/**
 * `GET /shipments/{id}` — só `logistic_type`, como todo schema desta casa
 * (`orderSchema`: "só os campos que a V3 usa hoje; estender é aditivo").
 *
 * O campo é OPCIONAL e ANULÁVEL de propósito. Ele veio nos 4 envios medidos,
 * mas um envio sem logística legível não pode virar ZodError: o schema
 * inteiro falharia e o pedido ficaria pendente por um campo que a V3 trata
 * como "não sei" de qualquer jeito.
 */
export const shipmentSchema = z.object({
  logistic_type: z.string().nullable().optional(),
});

export interface CapturedLogistic {
  /** O valor CRU do Mercado Livre, ou `null` quando o envio não disse. */
  readonly logisticType: string | null;
  /** Quando a V3 leu o envio: vira `orders.logistic_captured_at`. */
  readonly capturedAt: Date;
}

/**
 * A captura da logística, como `persistOrder` a consome.
 *
 * O RELÓGIO vem junto de propósito: `logistic_captured_at` também é carimbado
 * quando o sinal chega pelo próprio pedido (`shipping.logistic_type`, sem ida à
 * rede), e um `new Date()` solto lá dentro tiraria do teste a única forma de
 * fixar o instante.
 */
export interface ShipmentLogistics {
  /**
   * Lê o envio. `null` = NÃO leu (falhou): o pedido fica pendente. Um objeto
   * com `logisticType: null` é outra coisa — leu, e o envio não disse.
   */
  readonly read: (shippingId: number, orderId: number) => Promise<CapturedLogistic | null>;
  /** O mesmo relógio que `read` carimba. */
  readonly now: () => Date;
}

export interface ShipmentLogisticsDeps {
  mercadoLivre: MercadoLivreClient;
  accessToken: string;
  logger: Logger;
  now?: (() => Date) | undefined;
}

export function createShipmentLogistics(deps: ShipmentLogisticsDeps): ShipmentLogistics {
  const now = (): Date => deps.now?.() ?? new Date();

  return {
    now,
    read: async (shippingId, orderId) => {
      try {
        const shipment = await deps.mercadoLivre.request({
          method: "GET",
          path: `/shipments/${String(shippingId)}`,
          accessToken: deps.accessToken,
          schema: shipmentSchema,
        });

        return { logisticType: shipment.logistic_type ?? null, capturedAt: now() };
      } catch (error) {
        // Registrado, nunca fatal: o pedido sai pendente e a próxima janela
        // tenta de novo. O `order_id` vai junto porque é por ele que a
        // pendência é procurada depois.
        deps.logger.warn("order_logistic_leitura_falhou", {
          order_id: orderId,
          shipping_id: shippingId,
          motivo: error instanceof Error ? error.message : String(error),
        });

        return null;
      }
    },
  };
}
