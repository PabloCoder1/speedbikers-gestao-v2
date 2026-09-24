import { MercadoLivreApiError } from "@sb/mercado-livre";
import type { MercadoLivreClient } from "@sb/mercado-livre";
import type { Logger } from "@sb/observability";
import { ZodError, z } from "zod";

import { pacoteDoEnvio, type PacoteDoEnvio } from "./shipment-package.js";

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
 * **Falhar aqui nunca derruba o job de PEDIDOS** (`read`). Uma leitura que não
 * volta deixa o pedido PENDENTE: ele baixa a loja agora (R2 — nunca presumir
 * Full) e ganha o `ESTORNO_FULL` quando o sinal chegar. Derrubar a página
 * inteira por causa de um envio seria trocar um erro de estoque por uma parada
 * de sincronização, e a pendência já é reversível por desenho.
 *
 * **A varredura precisa de mais que "leu ou não leu"** (`readShipmentLogistic` +
 * `classifyShipmentFailure`): ela lê centenas de envios seguidos na mesma cota
 * por conta que o webhook usa, e "falhou" junta três coisas que pedem respostas
 * opostas — a conta em 429 (parar a rodada), o envio que não existe (resposta
 * definitiva) e o envio que o Mercado Livre recusa por outro motivo (tentar de
 * novo na próxima rodada).
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
  // D-405: as medidas do pacote, lidas À PARTE por `pacoteDoEnvio`. `unknown`
  // de propósito: uma forma inesperada aqui não pode reprovar o envio inteiro
  // e deixar o pedido pendente de logística.
  shipping_items: z.unknown().optional(),
});

export interface CapturedLogistic {
  /** O valor CRU do Mercado Livre, ou `null` quando o envio não disse. */
  readonly logisticType: string | null;
  /** Quando a V3 leu o envio: vira `orders.logistic_captured_at`. */
  readonly capturedAt: Date;
  /** D-405: o pacote do envio, da MESMA leitura. Ausente quando o envio não foi lido (404). */
  readonly pacote?: PacoteDoEnvio | null;
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
  /**
   * D-405: quem recebe o pacote do envio lido, para gravar. Opcional: sem ele a
   * leitura segue igual. Chamado DEPOIS da leitura bem-sucedida, e uma falha
   * dele é registrada e engolida — nunca muda a resposta da logística.
   */
  aoLerPacote?: ((orderId: number, shippingId: number, pacote: PacoteDoEnvio) => Promise<void>) | undefined;
}

/**
 * Lê o envio e LANÇA a falha — para quem precisa decidir o que fazer com ela (a
 * varredura, via `classifyShipmentFailure`). `createShipmentLogistics().read` é
 * esta mesma leitura com a falha engolida e registrada.
 */
export async function readShipmentLogistic(
  deps: Pick<ShipmentLogisticsDeps, "mercadoLivre" | "accessToken" | "now">,
  shippingId: number,
): Promise<CapturedLogistic> {
  const shipment = await deps.mercadoLivre.request({
    method: "GET",
    path: `/shipments/${String(shippingId)}`,
    accessToken: deps.accessToken,
    schema: shipmentSchema,
  });

  return {
    logisticType: shipment.logistic_type ?? null,
    capturedAt: deps.now?.() ?? new Date(),
    pacote: pacoteDoEnvio(shipment.shipping_items),
  };
}

/**
 * O que a varredura faz com uma leitura de envio que falhou (D-352).
 *
 *  - `interromper`: a falha é da CONTA ou da rede, não do envio — 429/5xx que
 *    já esgotaram as tentativas do cliente HTTP, 401 (token) e erro de
 *    transporte. Seguir para o próximo pedido gastaria mais 4 tentativas com
 *    backoff em cada um, na cota que o webhook também usa, e empurraria a
 *    rodada para além do prazo do Cloud Tasks. Para a rodada; o que já foi
 *    gravado fica (é idempotente) e a fila repete com backoff.
 *  - `inexistente`: 404 — o envio não existe. Não há sinal a esperar: é
 *    RESPOSTA, como o envio lido sem `logistic_type`, e a captura é carimbada
 *    com o tipo nulo (a venda baixa a loja, o lado conservador). Sem isso o
 *    pedido voltaria a cada 6 h para sempre, na frente da fila.
 *  - `pular`: qualquer outra recusa (400, 403, corpo fora do contrato) — do
 *    envio, não da conta, e sem prova de que seja definitiva. O pedido fica
 *    pendente e volta na próxima rodada, contado em `falhas`. O 403 fica aqui
 *    e não em `inexistente` de propósito: um 403 da CONTA inteira (app sem
 *    permissão) carimbaria todo o backlog como NÃO-Full para sempre (R5).
 */
export type ShipmentFailureAction = "interromper" | "inexistente" | "pular";

export function classifyShipmentFailure(error: unknown): ShipmentFailureAction {
  if (error instanceof MercadoLivreApiError) {
    if (error.status === 404) return "inexistente";
    if (error.errorClass !== "not_retryable" || error.status === 401) return "interromper";

    return "pular";
  }

  if (error instanceof ZodError) return "pular";

  // Erro de transporte (`fetch` rejeitado, DNS, conexão): não é do envio.
  return "interromper";
}

export function createShipmentLogistics(deps: ShipmentLogisticsDeps): ShipmentLogistics {
  const now = (): Date => deps.now?.() ?? new Date();

  return {
    now,
    read: async (shippingId, orderId) => {
      let capturada: CapturedLogistic;

      try {
        capturada = await readShipmentLogistic(deps, shippingId);
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

      if (capturada.pacote != null && deps.aoLerPacote !== undefined) {
        try {
          await deps.aoLerPacote(orderId, shippingId, capturada.pacote);
        } catch (error) {
          deps.logger.warn("shipment_package_nao_gravado", {
            order_id: orderId,
            motivo: error instanceof Error ? error.message : String(error),
          });
        }
      }

      return capturada;
    },
  };
}
