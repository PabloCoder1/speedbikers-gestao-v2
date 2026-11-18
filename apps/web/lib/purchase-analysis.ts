/**
 * A leitura da avaliação de compra (D-720/D-721) na web: contrato conferido de
 * `get_purchase_analysis` e `get_sku_margins`, e a montagem por SKU pelas peças
 * canônicas de `@sb/domain` — a tela e o pedido usam a MESMA função, para que a
 * linha da Reposição e a revisão do pedido nunca discordem.
 *
 * Nada aqui soma venda: os somatórios vêm prontos do SQL. A única conta é a
 * razão (margem) sobre somas já agregadas, pela fórmula do domínio.
 */

import {
  assessPurchaseFit,
  composeSkuReplenishment,
  evaluateSkuMargin,
  type MarketplaceCode,
  type PurchaseFitResult,
  type ReplenishmentSetting,
  type SkuMarginResult,
  type SkuMarginTotals,
  type SkuReplenishmentRow,
} from "@sb/domain";

type Obj = Record<string, unknown>;

const ehObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const ehNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const numOuNulo = (v: unknown): v is number | null => v === null || ehNum(v);
const textoOuNulo = (v: unknown): v is string | null => v === null || typeof v === "string";
const numOuZero = (v: unknown): number => (ehNum(v) ? v : 0);

// ---------------------------------------------------------------------------
// get_sku_margins
// ---------------------------------------------------------------------------

export interface MargemRecorte extends SkuMarginTotals {
  readonly avaliacao: SkuMarginResult;
}

export interface MargemConta extends MargemRecorte {
  readonly marketplace: MarketplaceCode;
  readonly contaId: string;
  readonly conta: string | null;
}

export interface MargemDoSku {
  readonly skuId: string;
  /** Nulo = nenhuma venda válida do SKU no período, em nenhum canal alcançável. */
  readonly total: MargemRecorte | null;
  readonly porMarketplace: readonly (MargemRecorte & { readonly marketplace: MarketplaceCode })[];
  readonly porConta: readonly MargemConta[];
}

export interface LeituraMargens {
  readonly de: string;
  readonly ate: string;
  readonly margemMinima: number;
  readonly lojasShopeeLidas: number;
  readonly lojasTiktok: number;
  readonly contasMl: number;
  readonly porSku: ReadonlyMap<string, MargemDoSku>;
}

const MARKETPLACES = new Set<string>(["MERCADO_LIVRE", "SHOPEE", "TIKTOK_SHOP"]);

function lerTotais(v: unknown): SkuMarginTotals | null {
  if (!ehObj(v)) return null;
  if (!ehNum(v.unidades) || !ehNum(v.pedidos) || !ehNum(v.pedidos_cobertos)) return null;
  if (!numOuNulo(v.receita) || !numOuNulo(v.receita_coberta) || !numOuNulo(v.recebido_coberto) || !numOuNulo(v.custo_coberto)) {
    return null;
  }

  return {
    units: v.unidades,
    orders: v.pedidos,
    revenue: v.receita ?? 0,
    coveredOrders: v.pedidos_cobertos,
    coveredRevenue: v.receita_coberta,
    coveredReceived: v.recebido_coberto,
    coveredCost: v.custo_coberto,
    currentCostOrders: numOuZero(v.pedidos_custo_atual),
  };
}

function recorte(t: SkuMarginTotals): MargemRecorte {
  return { ...t, avaliacao: evaluateSkuMargin(t) };
}

export function lerMargens(dado: unknown): LeituraMargens | null {
  if (!ehObj(dado) || !ehObj(dado.periodo) || !Array.isArray(dado.skus) || !ehNum(dado.margem_minima) || !ehObj(dado.canais)) {
    return null;
  }

  const { de, ate } = dado.periodo;

  if (typeof de !== "string" || typeof ate !== "string") return null;

  const canais = dado.canais;
  const ml = ehObj(canais.mercado_livre) ? canais.mercado_livre : {};
  const shopee = ehObj(canais.shopee) ? canais.shopee : {};
  const tiktok = ehObj(canais.tiktok_shop) ? canais.tiktok_shop : {};
  const porSku = new Map<string, MargemDoSku>();

  for (const s of dado.skus) {
    if (!ehObj(s) || typeof s.sku_id !== "string" || !Array.isArray(s.marketplaces) || !Array.isArray(s.contas)) return null;

    const total = s.total === null ? null : lerTotais(s.total);

    if (s.total !== null && total === null) return null;

    const porMarketplace: (MargemRecorte & { marketplace: MarketplaceCode })[] = [];

    for (const m of s.marketplaces) {
      const t = lerTotais(m);

      if (t === null || !ehObj(m) || typeof m.marketplace !== "string" || !MARKETPLACES.has(m.marketplace)) return null;
      porMarketplace.push({ ...recorte(t), marketplace: m.marketplace as MarketplaceCode });
    }

    const porConta: MargemConta[] = [];

    for (const c of s.contas) {
      const t = lerTotais(c);

      if (t === null || !ehObj(c) || typeof c.marketplace !== "string" || !MARKETPLACES.has(c.marketplace)) return null;
      if (typeof c.conta_id !== "string" || !textoOuNulo(c.conta)) return null;
      porConta.push({ ...recorte(t), marketplace: c.marketplace as MarketplaceCode, contaId: c.conta_id, conta: c.conta });
    }

    porSku.set(s.sku_id, { skuId: s.sku_id, total: total === null ? null : recorte(total), porMarketplace, porConta });
  }

  return {
    de,
    ate,
    margemMinima: dado.margem_minima,
    contasMl: numOuZero(ml.contas),
    lojasShopeeLidas: numOuZero(shopee.lojas_lidas),
    lojasTiktok: numOuZero(tiktok.lojas),
    porSku,
  };
}

// ---------------------------------------------------------------------------
// get_purchase_analysis
// ---------------------------------------------------------------------------

export interface PedidoAberto {
  readonly id: string;
  readonly orderNumber: number;
  readonly status: string;
  readonly quantity: number;
}

export interface LinhaAnalise extends SkuReplenishmentRow {
  readonly naReposicao: boolean;
  readonly purchaseCost: number | null;
  readonly abcClass: string | null;
  readonly isDiscontinued: boolean;
  readonly kind: string;
  readonly daysSinceCreated: number | null;
  readonly daysSinceFirstSale: number | null;
  readonly stockoutDays30: number | null;
  readonly otherOpenQuantity: number;
  readonly otherOpenOrders: readonly PedidoAberto[];
  readonly lastPurchase: { readonly unitCost: number | null; readonly currency: string; readonly at: string; readonly orderNumber: number; readonly supplier: string | null } | null;
  readonly supplierRule: {
    readonly supplierCode: string | null;
    readonly unitCost: number | null;
    readonly currency: string;
    readonly minimumOrderQuantity: number | null;
    readonly packMultiple: number | null;
    readonly leadTimeDays: number | null;
  } | null;
  readonly preferredSupplier: { readonly id: string; readonly name: string } | null;
}

export interface LeituraAnalise {
  readonly data: string;
  readonly newProductDays: number;
  readonly margemMinima: number;
  readonly linhas: readonly LinhaAnalise[];
}

function lerLinhaAnalise(v: unknown): LinhaAnalise | null {
  if (!ehObj(v) || typeof v.sku_id !== "string" || typeof v.sku !== "string") return null;
  if (!textoOuNulo(v.title) || !textoOuNulo(v.supplier_brand) || !numOuNulo(v.purchase_cost)) return null;
  // `na_reposicao` nulo = leitura só dos extras (p_incluir_sugestao falso): os
  // ingredientes vêm da linha da visão, por `comIngredientesDaVisao`.
  if ((v.na_reposicao !== null && typeof v.na_reposicao !== "boolean") || typeof v.is_discontinued !== "boolean") return null;
  if (typeof v.stock_is_virtual !== "boolean") return null;
  if (!numOuNulo(v.stockout_days_30) || !numOuNulo(v.days_since_first_sale) || !numOuNulo(v.days_since_created)) return null;
  if (!ehNum(v.other_open_quantity) || !Array.isArray(v.other_open_orders)) return null;

  const abertos: PedidoAberto[] = [];

  for (const o of v.other_open_orders) {
    if (!ehObj(o) || typeof o.id !== "string" || !ehNum(o.order_number) || typeof o.status !== "string" || !ehNum(o.quantity)) return null;
    abertos.push({ id: o.id, orderNumber: o.order_number, status: o.status, quantity: o.quantity });
  }

  const lp = v.last_purchase;
  const sr = v.supplier_rule;
  const pf = v.preferred_supplier;

  return {
    sku_id: v.sku_id,
    sku: v.sku,
    title: v.title,
    supplier_brand: v.supplier_brand,
    stock_is_virtual: v.stock_is_virtual,
    // Fora da reposição: os ingredientes vêm nulos — a composição recebe zeros
    // e `naReposicao` diz à tela que a avaliação NÃO vale para esta linha.
    local_quantity: numOuZero(v.local_quantity),
    full_quantity: numOuZero(v.full_quantity),
    transito: numOuZero(v.transito),
    reservado: numOuZero(v.reservado),
    units_15d: numOuZero(v.units_15d),
    units_30d: numOuZero(v.units_30d),
    units_60d: numOuZero(v.units_60d),
    units_90d: numOuZero(v.units_90d),
    history_days_90: numOuZero(v.history_days_90),
    naReposicao: v.na_reposicao ?? false,
    purchaseCost: v.purchase_cost,
    abcClass: typeof v.abc_class === "string" ? v.abc_class : null,
    isDiscontinued: v.is_discontinued,
    kind: typeof v.kind === "string" ? v.kind : "PRODUTO",
    daysSinceCreated: v.days_since_created,
    daysSinceFirstSale: v.days_since_first_sale,
    stockoutDays30: v.stockout_days_30,
    otherOpenQuantity: v.other_open_quantity,
    otherOpenOrders: abertos,
    lastPurchase:
      ehObj(lp) && typeof lp.at === "string" && ehNum(lp.order_number)
        ? {
            unitCost: ehNum(lp.unit_cost) ? lp.unit_cost : null,
            currency: typeof lp.currency === "string" ? lp.currency : "BRL",
            at: lp.at,
            orderNumber: lp.order_number,
            supplier: typeof lp.supplier === "string" ? lp.supplier : null,
          }
        : null,
    supplierRule: ehObj(sr)
      ? {
          supplierCode: typeof sr.supplier_code === "string" ? sr.supplier_code : null,
          unitCost: ehNum(sr.unit_cost) ? sr.unit_cost : null,
          currency: typeof sr.currency === "string" ? sr.currency : "BRL",
          minimumOrderQuantity: ehNum(sr.minimum_order_quantity) ? sr.minimum_order_quantity : null,
          packMultiple: ehNum(sr.pack_multiple) ? sr.pack_multiple : null,
          leadTimeDays: ehNum(sr.lead_time_days) ? sr.lead_time_days : null,
        }
      : null,
    preferredSupplier: ehObj(pf) && typeof pf.id === "string" && typeof pf.name === "string" ? { id: pf.id, name: pf.name } : null,
  };
}

export function lerAnalise(dado: unknown): LeituraAnalise | null {
  if (!ehObj(dado) || typeof dado.data !== "string" || !ehNum(dado.new_product_days) || !ehNum(dado.margem_minima)) return null;
  if (!Array.isArray(dado.linhas)) return null;

  const linhas: LinhaAnalise[] = [];

  for (const l of dado.linhas) {
    const linha = lerLinhaAnalise(l);

    if (linha === null) return null;
    linhas.push(linha);
  }

  return { data: dado.data, newProductDays: dado.new_product_days, margemMinima: dado.margem_minima, linhas };
}

/**
 * A linha só-extras completada com os ingredientes que a visão da Reposição já
 * trouxe (`get_replenishment_overview`) — sem segunda varredura do catálogo.
 */
export function comIngredientesDaVisao(
  extra: LinhaAnalise,
  row: SkuReplenishmentRow & { readonly purchase_cost: number | null; readonly abc_class: string | null },
): LinhaAnalise {
  return {
    ...extra,
    local_quantity: row.local_quantity,
    full_quantity: row.full_quantity,
    transito: row.transito,
    reservado: row.reservado,
    stock_is_virtual: row.stock_is_virtual,
    units_15d: row.units_15d,
    units_30d: row.units_30d,
    units_60d: row.units_60d,
    units_90d: row.units_90d,
    history_days_90: row.history_days_90,
    purchaseCost: row.purchase_cost,
    abcClass: row.abc_class,
    naReposicao: true,
  };
}

// ---------------------------------------------------------------------------
// A avaliação por SKU
// ---------------------------------------------------------------------------

export interface AvaliacaoSku {
  readonly linha: LinhaAnalise;
  readonly margem: MargemDoSku | null;
  /** Nulo quando o SKU está fora da reposição: não há base para recomendar. */
  readonly fit: PurchaseFitResult | null;
}

export function avaliarSku(
  linha: LinhaAnalise,
  margem: MargemDoSku | null,
  settings: readonly ReplenishmentSetting[],
  preferencias: { readonly margemMinima: number; readonly newProductDays: number },
  orderedQuantity: number | null,
): AvaliacaoSku {
  if (!linha.naReposicao) return { linha, margem, fit: null };

  const verdict = composeSkuReplenishment(linha, settings);
  const avaliacao = margem?.total?.avaliacao ?? null;

  const fit = assessPurchaseFit({
    verdict,
    units90d: linha.units_90d,
    orderedQuantity,
    otherOpenQuantity: linha.otherOpenQuantity,
    daysSinceFirstSale: linha.daysSinceFirstSale,
    daysSinceCreated: linha.daysSinceCreated,
    stockoutDays30: linha.stockoutDays30,
    isDiscontinued: linha.isDiscontinued,
    margin: avaliacao?.margin ?? null,
    marginQuality: avaliacao?.quality ?? "INDISPONIVEL",
    minimumOrderQuantity: linha.supplierRule?.minimumOrderQuantity ?? null,
    packMultiple: linha.supplierRule?.packMultiple ?? null,
    preferences: { marginFloor: preferencias.margemMinima, newProductDays: preferencias.newProductDays },
  });

  return { linha, margem, fit };
}
