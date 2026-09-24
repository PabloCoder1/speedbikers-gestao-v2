import type { AdminClient } from "@sb/db";
import type { Logger } from "@sb/observability";
import { z } from "zod";

/**
 * As medidas do PACOTE de um envio (D-405) — o que o Mercado Livre usou para
 * cobrar o frete daquela venda.
 *
 * **De onde vêm.** `GET /shipments/{id}` traz `shipping_items[]`, e cada item
 * leva `dimensions` como texto `"4.0x19.0x26.0,710.0"` (três lados em cm e o
 * peso em gramas) e `dimensions_source.origin`. Medido em 4 envios reais de
 * 17/09/2026 (`d352/leitura-real/`): `"bmp"` no envio que saiu da loja e
 * `"fd"` nos três do Full. O `dimensions` do topo do envio veio NULO nos
 * quatro — a medida mora no item.
 *
 * **Custo zero de API.** A leitura já acontece: é a mesma de `logistic_type`
 * (D-352), por pedido que vai deduzir e na varredura de logística. Esta camada
 * só deixa de jogar fora o que a resposta já traz.
 *
 * **Nunca derruba nada.** O campo entra no schema do envio como `unknown` e é
 * lido aqui à parte: uma forma inesperada vira `null`, e não um `ZodError`
 * que deixaria o pedido pendente de logística. A gravação registra a falha e
 * segue — perder uma medida não pode parar a baixa de estoque.
 */

export interface PacoteDoEnvio {
  /** Quantos itens o envio tem. Só com UM as medidas são do anúncio. */
  readonly itens: number;
  readonly itemId: string | null;
  /** O texto do Mercado Livre como veio, para auditoria. */
  readonly medidas: string | null;
  readonly pesoG: number | null;
  readonly volumeCm3: number | null;
  readonly maiorLadoCm: number | null;
  /** `dimensions_source.origin` cru: `"bmp"`, `"fd"`… */
  readonly origem: string | null;
}

const itemDoEnvioSchema = z.object({
  id: z.string().nullable().optional(),
  quantity: z.number().nullable().optional(),
  dimensions: z.string().nullable().optional(),
  dimensions_source: z.object({ origin: z.string().nullable().optional() }).nullable().optional(),
});

/** `"4.0x19.0x26.0,710.0"`: três lados em cm e o peso em gramas. */
const MEDIDAS = /^\s*(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*$/;

interface Medidas {
  readonly pesoG: number;
  readonly volumeCm3: number;
  readonly maiorLadoCm: number;
}

export function lerMedidas(texto: string | null | undefined): Medidas | null {
  if (texto === null || texto === undefined) return null;

  const m = MEDIDAS.exec(texto);

  if (m === null) return null;

  const lados = [Number(m[1]), Number(m[2]), Number(m[3])];
  const pesoG = Number(m[4]);

  // Lado ou peso zero não é medida: é campo vazio escrito como número.
  if (lados.some((lado) => !(lado > 0)) || !(pesoG > 0)) return null;

  return {
    pesoG,
    volumeCm3: Math.round(lados.reduce((produto, lado) => produto * lado, 1) * 100) / 100,
    maiorLadoCm: Math.max(...lados),
  };
}

/**
 * O pacote do envio, lido de `shipping_items`. `null` quando o campo não veio
 * ou não tem a forma conhecida. Com mais de um item, o pacote é de todos
 * juntos: as medidas ficam nulas e só a contagem é gravada.
 */
export function pacoteDoEnvio(shippingItems: unknown): PacoteDoEnvio | null {
  const lista = z.array(itemDoEnvioSchema).safeParse(shippingItems);

  if (!lista.success || lista.data.length === 0) return null;

  if (lista.data.length > 1) {
    return { itens: lista.data.length, itemId: null, medidas: null, pesoG: null, volumeCm3: null, maiorLadoCm: null, origem: null };
  }

  const [item] = lista.data;
  const medidas = lerMedidas(item?.dimensions);

  return {
    itens: 1,
    itemId: item?.id ?? null,
    medidas: item?.dimensions ?? null,
    pesoG: medidas?.pesoG ?? null,
    volumeCm3: medidas?.volumeCm3 ?? null,
    maiorLadoCm: medidas?.maiorLadoCm ?? null,
    origem: item?.dimensions_source?.origin ?? null,
  };
}

export interface ContextoDoPacote {
  readonly organizationId: string;
  readonly mlAccountId: string;
}

/**
 * Grava o pacote do pedido em `shipment_packages`. Devolve se gravou; a falha
 * é REGISTRADA e engolida — nunca lançada.
 */
export async function gravarPacoteDoEnvio(
  db: AdminClient,
  contexto: ContextoDoPacote,
  orderId: number,
  shippingId: number,
  pacote: PacoteDoEnvio,
  logger: Logger,
  agora: Date = new Date(),
): Promise<boolean> {
  try {
    const resultado = await db.from("shipment_packages").upsert(
      {
        order_id: orderId,
        organization_id: contexto.organizationId,
        ml_account_id: contexto.mlAccountId,
        shipping_id: shippingId,
        item_id: pacote.itemId,
        items_in_shipment: pacote.itens,
        dimensions_raw: pacote.medidas,
        weight_g: pacote.pesoG,
        volume_cm3: pacote.volumeCm3,
        largest_side_cm: pacote.maiorLadoCm,
        dimensions_origin: pacote.origem,
        captured_at: agora.toISOString(),
      },
      { onConflict: "order_id" },
    );

    if (resultado.error !== null) {
      logger.warn("shipment_package_nao_gravado", { order_id: orderId, motivo: resultado.error.message });

      return false;
    }

    return true;
  } catch (error) {
    logger.warn("shipment_package_nao_gravado", {
      order_id: orderId,
      motivo: error instanceof Error ? error.message : String(error),
    });

    return false;
  }
}
