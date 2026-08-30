/**
 * A ponte cobertura→pedido (D-151, última fatia da Fase 5D): `/reposicao`
 * envia os SKUs selecionados como pares `sku=<uuid>:<quantidade>` na URL, e
 * o pedido nasce pré-carregado com a quantidade SUGERIDA — que o humano
 * revisa à vontade antes de criar. O pedido continua nascendo como RASCUNHO
 * e só vira compra pelo ciclo de aprovação de D-055: a ponte encurta o
 * caminho, nunca a decisão.
 */

export interface ReplenishmentPrefill {
  skuId: string;
  quantity: number;
}

const PAIR = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([1-9]\d{0,5})$/;

/** Teto de segurança: acima disso é URL malformada, não seleção legítima. */
const MAX_ITEMS = 100;

/**
 * Par malformado é DESCARTADO em silêncio, não erro: a URL é editável pelo
 * usuário e um par corrompido não deve derrubar os demais. Duplicata de SKU
 * fica com a primeira ocorrência.
 */
export function parseReplenishmentPrefill(raw: string | string[] | undefined): ReplenishmentPrefill[] {
  const values = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : [];
  const seen = new Set<string>();
  const out: ReplenishmentPrefill[] = [];

  for (const value of values) {
    const match = PAIR.exec(value);

    if (match === null) continue;

    const [, skuId, qty] = match as unknown as [string, string, string];

    if (seen.has(skuId)) continue;

    seen.add(skuId);
    out.push({ skuId, quantity: Number.parseInt(qty, 10) });

    if (out.length >= MAX_ITEMS) break;
  }

  return out;
}

export interface OriginMixInput {
  skuId: string | null;
  isImported: boolean | null;
}

export interface OriginMix {
  imported: number;
  national: number;
  unknown: number;
  /** Importado E nacional no MESMO pedido — a regra do PRD é não misturar. */
  mixed: boolean;
}

/**
 * A regra "não misturar nacional e importado" (PRD) como AVISO, nunca
 * bloqueio — decisão de D-151: `is_imported` é origem FISCAL, e D-129/D-139
 * mediram que ela contradiz a rota de compra em parte do catálogo (187 dos
 * 228 NAVETEC constam como "nacionais"). Bloquear em cima de dado
 * sabidamente errado impediria pedidos legítimos; o aviso entrega a regra
 * com a honestidade que o dado permite. Itens sem SKU catalogado ou sem
 * origem cadastrada contam como `unknown` e não disparam a mistura.
 */
export function detectOriginMix(items: readonly OriginMixInput[]): OriginMix {
  let imported = 0;
  let national = 0;
  let unknown = 0;

  for (const item of items) {
    if (item.skuId === null || item.isImported === null) unknown += 1;
    else if (item.isImported) imported += 1;
    else national += 1;
  }

  return { imported, national, unknown, mixed: imported > 0 && national > 0 };
}
