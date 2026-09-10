import { computePurchaseSuggestion, type PurchaseSuggestionResult } from "./purchase-suggestion.js";
import {
  resolveReplenishmentPolicy,
  type ReplenishmentSetting,
  type ResolvedReplenishmentPolicy,
} from "./replenishment-policy.js";
import { classifySalesTrend, type SalesTrendResult } from "./sales-trend.js";
import { classifyStockState, type StockStateResult } from "./stock-state.js";
import { computeUsableStock, type UsableStockResult } from "./usable-stock.js";

/**
 * A COMPOSIÇÃO do veredito de reposição de um SKU (D-293).
 *
 * As cinco peças canônicas já existiam — tendência, aproveitável, política,
 * sugestão e estado. O que não existia era o **arranjo delas**, que morava
 * inline em `/reposicao/page.tsx` e agora tem um segundo consumidor: as
 * ferramentas do Copiloto.
 *
 * Extrair aqui é a regra de contenção da casa cumprida ao pé da letra (peça
 * compartilhada quando o segundo consumidor aparece) — e é mais do que estilo:
 * **a resposta do Copiloto e a linha da tela precisam ser o MESMO número.**
 * Duas composições paralelas divergiriam no primeiro ajuste de qualquer uma
 * das cinco peças, e a divergência apareceria como o assistente contradizendo
 * a tela que o operador tem aberta ao lado — a pior forma possível de errar.
 *
 * A entrada é a LINHA CRUA de `get_purchase_suggestions` mais as configurações
 * de reposição da organização; a saída é tudo o que a tela desenha, sem
 * formatação nenhuma.
 */

/**
 * As colunas de `get_purchase_suggestions` que a composição consome — e SÓ
 * elas. `abc_class`, `purchase_cost` e os derivados em SQL ficam de fora de
 * propósito: quem os usa é a apresentação, e o tipo de entrada existe para
 * dizer do que a CONTA depende.
 */
export interface SkuReplenishmentRow {
  readonly sku_id: string;
  readonly sku: string;
  /** Anulável de verdade: `skus.title` aceita NULL, e a tela mostra o SKU no lugar. */
  readonly title: string | null;
  /** Anulável: SKU sem marca de fornecedor cai na política PADRÃO da organização. */
  readonly supplier_brand: string | null;
  readonly local_quantity: number;
  readonly full_quantity: number;
  readonly transito: number;
  readonly reservado: number;
  readonly stock_is_virtual: boolean;
  readonly units_15d: number;
  readonly units_30d: number;
  readonly units_60d: number;
  readonly units_90d: number;
  readonly history_days_90: number;
}

export interface SkuReplenishmentVerdict {
  readonly trend: SalesTrendResult;
  readonly usable: UsableStockResult;
  /** `null` = nenhuma configuração alcança este SKU (D-144) — recusa, nunca default. */
  readonly policy: ResolvedReplenishmentPolicy | null;
  readonly suggestion: PurchaseSuggestionResult;
  readonly stockState: StockStateResult;
}

export function composeSkuReplenishment(
  row: SkuReplenishmentRow,
  settings: readonly ReplenishmentSetting[],
): SkuReplenishmentVerdict {
  const trend = classifySalesTrend({
    units15: row.units_15d,
    units30: row.units_30d,
    units60: row.units_60d,
    units90: row.units_90d,
    historyDays90: row.history_days_90,
  });

  const usable = computeUsableStock({
    localQuantity: row.local_quantity,
    fullQuantity: row.full_quantity,
    transitQuantity: row.transito,
    reservedQuantity: row.reservado,
    stockIsVirtual: row.stock_is_virtual,
  });

  const policy = resolveReplenishmentPolicy(settings, {
    id: row.sku_id,
    supplierBrand: row.supplier_brand,
  });

  return {
    trend,
    usable,
    policy,
    suggestion: computePurchaseSuggestion({ policy, trend, usable }),
    stockState: classifyStockState({ policy, trend, usable }),
  };
}
