import type { DomainEventDraft } from "./order-events.js";

/**
 * C-81 — a mudança de preço de um anúncio da Shopee entre duas leituras do
 * catálogo (`shopee.items.hydrate`).
 *
 * O evento é o MESMO `listing.price.changed` do Mercado Livre: a origem vem
 * pela coluna (`shopee_shop_id`, com `ml_account_id` nulo), como nos eventos
 * de loja da Shopee que já existem (`sync.failed`). Quem lê o tipo pela conta
 * do ML (`get_price_changes` até o C-81, a correlação do diagnóstico) não o
 * alcança sem ser ensinado.
 *
 * `price` é o `original_price`: "The original price of the item in the
 * listing currency", enquanto `current_price` "will be the promotion price"
 * quando há promoção (documentação oficial de `get_item_base_info`, lida em
 * 21/10/2026). É o critério do ML, onde a promoção não é mudança de preço; o
 * `current_price` vai junto, só informativo.
 *
 * Só nasce quando `price` muda entre duas leituras com os dois lados lidos.
 * A primeira leitura, a promoção sozinha e a variação criada ou removida não
 * são "mudou": não há um preço anterior do mesmo anúncio para comparar.
 */

export interface ShopeePriceReading {
  readonly itemId: number;
  /** `null` no item sem variação: o preço é do próprio item. */
  readonly modelId: number | null;
  readonly modelName?: string | null;
  readonly itemName?: string | null;
  /** `original_price`. */
  readonly price: number | null;
  /** `current_price`. */
  readonly currentPrice: number | null;
}

export interface ShopeePriceEventsInput {
  readonly shopeeShopId: string;
  /** O nome da loja na hora da leitura: o aviso diz a origem sem outra ida ao banco. */
  readonly shopName: string | null;
  /** O que o banco tinha ANTES desta leitura, lido pelo chamador antes de gravar. */
  readonly previous: readonly ShopeePriceReading[];
  readonly current: readonly ShopeePriceReading[];
  readonly readAt: Date;
}

/** Mesma severidade do `listing.price.changed` do ML (ver `listing-events.ts`). */
const SEVERITY = "informativo" as const;

function chave(reading: ShopeePriceReading): string {
  return `${String(reading.itemId)}:${reading.modelId === null ? "item" : String(reading.modelId)}`;
}

export function detectShopeePriceEvents(input: ShopeePriceEventsInput): DomainEventDraft[] {
  const anteriores = new Map(input.previous.map((reading) => [chave(reading), reading]));
  const readAtKey = input.readAt.toISOString();
  const events: DomainEventDraft[] = [];

  for (const atual of input.current) {
    const anterior = anteriores.get(chave(atual));

    if (anterior?.price == null || atual.price === null) continue;
    if (anterior.price === atual.price) continue;

    const modelo = atual.modelId === null ? "item" : String(atual.modelId);

    events.push({
      eventType: "listing.price.changed",
      entityType: "shopee_item",
      entityId: String(atual.itemId),
      before: {
        price: anterior.price,
        current_price: anterior.currentPrice,
        model_id: atual.modelId,
      },
      after: {
        price: atual.price,
        current_price: atual.currentPrice,
        model_id: atual.modelId,
        model_name: atual.modelName ?? null,
        item_name: atual.itemName ?? null,
        shop_name: input.shopName,
      },
      severity: SEVERITY,
      source: "sync",
      dedupKey: `listing.price.changed:shopee:${input.shopeeShopId}:${String(atual.itemId)}:${modelo}:${readAtKey}`,
      occurredAt: input.readAt,
    });
  }

  return events;
}
