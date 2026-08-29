/**
 * As quatro métricas plotáveis do gráfico de `/vendas` (Fase 5C).
 *
 * **Por que isto é interface e não banco:** `get_sales_daily_series`
 * (`20260821210000`) já devolve as QUATRO colunas desde 2026-08-21 —
 * `units_sold`, `gross_revenue`, `orders_count`, `purchases_count` — e a
 * tela plotava uma só. Nenhuma migration, nenhuma consulta nova: o dado já
 * viajava pela rede e era descartado no cliente.
 *
 * **Cada entrada carrega o ID da definição canônica** (`docs/METRICS.md`
 * 5.2), como exige `docs/ARCHITECTURE.md` §15 ("todo número na tela carrega
 * o ID da sua definição de métrica"). Nenhuma métrica nova foi inventada
 * aqui: as quatro estão aprovadas desde 2026-08-21 e a coluna da RPC é a
 * implementação delas.
 *
 * `format` é um DISCRIMINANTE, não uma função: manter este módulo livre de
 * import de React/formatador o deixa testável como dado puro, e quem
 * renderiza escolhe o formatador. Mesma razão pela qual `sku-curation.ts`
 * (D-133) não conhece a tela.
 */
export interface SalesMetric {
  /** Valor aceito em `?metric=` — parte da URL, então é vocabulário do usuário. */
  readonly key: string;
  /** ID da definição canônica em `docs/METRICS.md` 5.2. */
  readonly definitionId: string;
  /** Rótulo do botão de troca. */
  readonly label: string;
  /** Título da seção quando esta métrica está ativa. */
  readonly heading: string;
  /** Coluna correspondente em `get_sales_daily_series`. */
  readonly field: "gross_revenue" | "units_sold" | "orders_count" | "purchases_count";
  readonly format: "currency" | "count";
}

/**
 * Faturamento é constante NOMEADA, não `SALES_METRICS[0]`. O default abaixo
 * aponta para ela por identidade: reordenar o array — coisa que alguém fará
 * um dia para mudar a ordem dos botões — não pode trocar em silêncio qual
 * gráfico `/vendas` abre por padrão.
 */
const FATURAMENTO: SalesMetric = {
  key: "faturamento",
  definitionId: "receita_bruta",
  label: "Faturamento",
  heading: "Receita bruta por dia",
  field: "gross_revenue",
  format: "currency",
};

export const SALES_METRICS: readonly SalesMetric[] = [
  FATURAMENTO,
  {
    key: "unidades",
    definitionId: "unidades_vendidas",
    label: "Unidades",
    heading: "Unidades vendidas por dia",
    field: "units_sold",
    format: "count",
  },
  {
    key: "pedidos",
    definitionId: "pedidos",
    label: "Pedidos",
    heading: "Pedidos por dia",
    field: "orders_count",
    format: "count",
  },
  {
    // "Compras (packs)" e não "packs" sozinho: `pedidos_por_pack` conta a
    // COMPRA do cliente (vários pedidos num pack são uma compra só), e o
    // catálogo chama isso de "Compras por pack". Rotular só "Packs" faria o
    // usuário ler como "quantidade de packs", que é outra coisa.
    key: "packs",
    definitionId: "pedidos_por_pack",
    label: "Compras (packs)",
    heading: "Compras por pack, por dia",
    field: "purchases_count",
    format: "count",
  },
];

/**
 * Faturamento é o default porque era o comportamento ANTES desta fatia — uma
 * URL sem `?metric=` tem de continuar mostrando exatamente o gráfico que
 * mostrava ontem, senão a mudança quebra links salvos e a memória de quem usa
 * a tela todo dia.
 */
export const DEFAULT_SALES_METRIC: SalesMetric = FATURAMENTO;

/**
 * Valor desconhecido cai no default **em silêncio**, sem erro de tela.
 *
 * É o mesmo tratamento que `/vendas` já dá a um slug de conta que não existe
 * ("cai em 'todas as contas' em silêncio — não é erro de rede nem de dado") e
 * que `/importacoes/[id]` dá a status desconhecido. Um parâmetro de URL
 * digitado à mão, ou vindo de um filtro salvo antigo, não é falha do sistema:
 * é entrada inválida com um padrão óbvio.
 */
export function resolveSalesMetric(raw: unknown): SalesMetric {
  if (typeof raw !== "string") {
    return DEFAULT_SALES_METRIC;
  }

  return SALES_METRICS.find((metric) => metric.key === raw) ?? DEFAULT_SALES_METRIC;
}
