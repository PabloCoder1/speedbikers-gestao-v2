/**
 * Filtros de `/cobertura` (D-236), puros e testáveis sem React nem banco.
 *
 * A MECÂNICA (href, página) vive em `./filters` desde D-141; aqui fica só o
 * vocabulário desta tela — que hoje é **uma dimensão só**, e isso é o ponto.
 *
 * ## Por que não há filtro de conta
 *
 * Não é lacuna: é a regra do item P1, que pede os filtros "preservando a
 * distinção entre estoque físico compartilhado e Full por conta". Cobertura
 * lê `inventory_balances` com `location_kind = 'LOCAL'` — **estoque físico é
 * da organização**, não da conta do Mercado Livre. Um seletor de conta aqui
 * responderia uma pergunta que o dado não tem, e é a mesma decisão que
 * `/estoque/movimentacoes` já registrou.
 *
 * ## Por que a marca é `supplier_brand`
 *
 * `skus.brand` guarda a CATEGORIA do UpSeller (D-129) e diverge da marca real
 * em 2.320 dos 3.554 SKUs — o topo dela é `MANETE`, que é tipo de peça.
 * Filtrar por ela daria resposta plausível e errada.
 */

import { buildFilterHref } from "./filters";

export interface CoverageFilters {
  /** `skus.supplier_brand`, NUNCA `skus.brand` — ver o cabeçalho. */
  brand: string | null;
}

/** Mesma leitura de `stock-filters` e `abc-filters`: vazio e só-espaço viram nulo. */
function readParam(raw: unknown): string | null {
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
}

export function resolveCoverageFilters(query: Record<string, string | string[] | undefined>): CoverageFilters {
  // Marca desconhecida NÃO cai num default: ela vai ao banco e a tela volta
  // vazia, que é a resposta certa para "não há SKU dessa marca". Cair em
  // "todas" faria a tela mostrar o conjunto inteiro dizendo que é de uma marca.
  return { brand: readParam(query.marca) };
}

export function buildCoverageHref(current: CoverageFilters, override: Partial<CoverageFilters>): string {
  const next = { ...current, ...override };

  // `/cobertura` não tem paginação na URL: a tela mostra os N mais urgentes e
  // diz quantos ficaram de fora. Página 1 sempre.
  return buildFilterHref("/cobertura", { marca: next.brand }, 1);
}
