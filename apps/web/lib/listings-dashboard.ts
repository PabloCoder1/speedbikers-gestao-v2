/**
 * Regras puras do Dashboard de Anúncios (D-138) — vocabulário de filtro desta
 * tela e os rótulos de estado de vínculo.
 *
 * Mora em `lib/` para ser testável sem React nem banco. A mecânica de href,
 * página e janela vive em `./filters` desde D-141.
 */

import { resolvePageParam, summarizePagedWindow } from "./filters";

/** Tamanho da janela lida do Postgres. A tela NUNCA lê a tabela inteira (D-138). */
export const PAGE_SIZE = 50;

export const LINK_STATE_FILTERS = [
  { key: "all", label: "Todos" },
  { key: "linked", label: "Vinculados" },
  { key: "unlinked", label: "Sem vínculo" },
] as const;

const LINK_STATE_KEYS = new Set(LINK_STATE_FILTERS.map((f) => f.key as string));

/**
 * Estados aceitos no filtro. Lista fechada de propósito: um valor arbitrário
 * viajaria até o `where l.status = p_status` e devolveria zero linhas, que a
 * tela mostraria como "nenhum anúncio corresponde" — indistinguível de um
 * filtro legítimo sem resultado.
 */
const STATUS_KEYS = new Set(["active", "paused", "closed", "under_review"]);

/**
 * Recorte por estoque DO ANÚNCIO (D-242) — `listings.available_quantity`.
 *
 * O frame `Listings` pede as duas pontas: a célula "Sem estoque" na faixa de
 * resumo e o botão "Com estoque" na barra da tabela. A coluna é NOT NULL, então
 * as duas classes particionam o conjunto inteiro — não existe terceira posição
 * silenciosa entre elas.
 *
 * **Não é o saldo do ERP nem o do Full.** São três grãos diferentes, e o único
 * que responde "o anúncio pode vender agora?" é este.
 */
export const STOCK_FILTERS = [
  { key: "all", label: "Qualquer estoque" },
  { key: "in", label: "Com estoque" },
  { key: "out", label: "Sem estoque" },
] as const;

const STOCK_KEYS = new Set(STOCK_FILTERS.map((f) => f.key as string));

export function resolveStockFilter(raw: unknown): string {
  return typeof raw === "string" && STOCK_KEYS.has(raw) ? raw : "all";
}

/**
 * Recorte por Full DO ANÚNCIO (D-243) — a soma do último snapshot por bucket
 * (`inventory_id`) dos últimos 3 dias em `fulfillment_stock_snapshots`, a
 * definição canônica de D-173/D-204; o snapshot carrega o `item_id`.
 * "with" = está no Full hoje (> 0); "without" = não está (sem snapshot OU
 * zerado — a coluna distingue os dois).
 */
export const FULL_FILTERS = [
  { key: "all", label: "Full ou não" },
  { key: "with", label: "No Full" },
  { key: "without", label: "Fora do Full" },
] as const;

const FULL_KEYS = new Set(FULL_FILTERS.map((f) => f.key as string));

export function resolveFullFilter(raw: unknown): string {
  return typeof raw === "string" && FULL_KEYS.has(raw) ? raw : "all";
}

/**
 * Recorte por VENDA na janela (D-308) — o predicado `p_sold` que a RPC já
 * tinha desde D-259 e que nenhuma tela expunha.
 *
 * `docs/PRODUCT_REQUIREMENTS.md` pede "com/sem venda" entre os filtros desta
 * tela desde sempre; o argumento nasceu para a célula "Vendidos sem vínculo"
 * de `/vinculacoes` e ficou só lá.
 *
 * **"Sem venda" é sobre o PERÍODO, nunca "nunca vendeu".** `p_sold` compara
 * `units_sold` agregado entre `p_date_from` e `p_date_to`, então a resposta
 * muda com o seletor de período — e é por isso que os dois controles entraram
 * na mesma fatia: um sem o outro seria uma pergunta pela metade.
 *
 * **A ressalva que o rótulo carrega:** ausência de métrica é lida como
 * ausência de venda (a RPC faz `coalesce(md.units_sold, 0) = 0`), e o
 * recálculo só materializa dias tocados pela reconciliação. Medido no Dev em
 * 2026-09-10: **30 de 30 dias** da janela têm métrica, e 90 de 90 — então hoje
 * a leitura é fiel. Se o pipeline parar, "sem venda" passa a incluir "não
 * calculado", e é isso que a dica do filtro diz em vez de deixar implícito.
 */
export const SOLD_FILTERS = [
  { key: "all", label: "Com ou sem venda" },
  { key: "with", label: "Vendeu no período" },
  { key: "without", label: "Sem venda no período" },
] as const;

const SOLD_KEYS = new Set(SOLD_FILTERS.map((f) => f.key as string));

export function resolveSoldFilter(raw: unknown): string {
  return typeof raw === "string" && SOLD_KEYS.has(raw) ? raw : "all";
}

/*
  O SELETOR DE PERÍODO MUDOU DE CASA (D-311). `PERIOD_PRESETS`,
  `DEFAULT_PERIOD_DAYS` e `resolvePeriodDays` moram em `lib/period.ts` desde
  que a Home virou a TERCEIRA tela a querer um seletor. O motivo é o mesmo que
  D-308 escreveu ao criar o segundo consumidor: "últimos 30 dias" precisa
  querer dizer a mesma coisa em todas as telas — e um vocabulário compartilhado
  não podia continuar morando num módulo batizado por UMA delas.

  A regra que este módulo continua guardando: a janela mexe SÓ nas colunas de
  desempenho — venda, receita, visitas, dias observados, conversão — e no
  predicado `p_sold`. **As contagens da faixa não mudam com ela**: `metricas` e
  `visitas` entram na RPC por `left join`, então trocar o período não tira nem
  põe anúncio no conjunto.
*/

export function resolveLinkStateFilter(raw: unknown): string {
  return typeof raw === "string" && LINK_STATE_KEYS.has(raw) ? raw : "all";
}

export function resolveStatusFilter(raw: unknown): string | null {
  return typeof raw === "string" && STATUS_KEYS.has(raw) ? raw : null;
}

/**
 * Página 1 é o piso. Valor não numérico, zero, negativo ou fracionário cai em
 * 1 — um `offset` negativo seria erro do Postgres, e a RPC já se protege com
 * `greatest(p_offset, 0)`; aqui a defesa é para a tela não exibir "Página -3".
 */
export function resolvePage(raw: unknown): number {
  return resolvePageParam(raw);
}

export interface WindowSummary {
  label: string;
  totalPages: number;
}

/**
 * A frase que impede a tela de repetir o defeito de D-138.
 *
 * A versão anterior de `/anuncios` mostrava 1.000 de 5.085 anúncios e não
 * dizia nada — não havia como distinguir "estes são todos" de "estes são os
 * primeiros". Dizer sempre "N a M de TOTAL" torna o truncamento impossível de
 * passar despercebido, mesmo que um limite futuro volte a ser baixo demais.
 */
export function summarizeWindow(page: number, totalCount: number, rowsOnPage: number): WindowSummary {
  return summarizePagedWindow({
    page,
    totalCount,
    rowsOnPage,
    pageSize: PAGE_SIZE,
    noun: { singular: "anúncio", plural: "anúncios" },
    emptyLabel: "Nenhum anúncio no filtro atual.",
  });
}

export interface LinkStateBadge {
  label: string;
  tone: string;
  hint: string;
}

/**
 * O que aparece na coluna SKU quando não há vínculo direto.
 *
 * Os dois casos NÃO são o mesmo, e foi D-122 que estabeleceu isso medindo:
 * dos 1.917 anúncios com `sku_id` nulo, **1.013 têm vínculo por variação** e
 * só **904** não têm vínculo nenhum. Mostrar "—" nos dois, como a tela fazia,
 * dobra o tamanho aparente da fila de trabalho.
 */
export function linkStateBadge(linkState: string): LinkStateBadge {
  if (linkState === "linked_variation") {
    return {
      label: "por variação",
      tone: "var(--sb-text-soft)",
      hint: "O anúncio tem vínculo em nível de variação, não no anúncio inteiro. Não está pendente.",
    };
  }

  return {
    label: "sem vínculo",
    tone: "var(--sb-danger)",
    hint: "Nenhum vínculo, nem por anúncio nem por variação. Aparece na Central de Vinculações.",
  };
}
