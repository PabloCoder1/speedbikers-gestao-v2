/**
 * Filtros da Curva ABC (D-140), puros e testáveis sem React nem banco.
 *
 * A mecânica compartilhada (href, página, janela) vive em `./filters` desde
 * D-141; aqui fica o vocabulário próprio: critério, período e "sem Full".
 */

import { buildFilterHref, resolvePageParam, summarizePagedWindow } from "./filters";

export const PAGE_SIZE = 200;

export const ABC_CRITERIA = [
  { key: "faturamento", label: "Faturamento", definitionId: "receita_bruta", format: "currency" },
  { key: "unidades", label: "Unidades", definitionId: "unidades_vendidas", format: "count" },
  { key: "pedidos", label: "Pedidos", definitionId: "pedidos", format: "count" },
] as const;

export type AbcCriterion = (typeof ABC_CRITERIA)[number];

/** Presets pedidos pelo requisito. 90 continua o default: classificação ABC precisa de sinal estável. */
export const ABC_PERIODS = [30, 60, 90] as const;

const DEFAULT_PERIOD = 90;

export interface AbcFilters {
  accountSlug: string | null;
  criterion: AbcCriterion;
  days: number;
  onlyWithoutFull: boolean;
  page: number;
}

export function resolveAbcCriterion(raw: unknown): AbcCriterion {
  const found = typeof raw === "string" ? ABC_CRITERIA.find((c) => c.key === raw) : undefined;

  return found ?? ABC_CRITERIA[0];
}

/**
 * Período fora da lista cai no default. Aceitar um número arbitrário deixaria
 * a tela anunciar "últimos 4.000 dias" com uma curva que não tem esse dado.
 */
export function resolveAbcPeriod(raw: unknown): number {
  if (typeof raw !== "string") return DEFAULT_PERIOD;

  const parsed = Number.parseInt(raw, 10);

  return (ABC_PERIODS as readonly number[]).includes(parsed) ? parsed : DEFAULT_PERIOD;
}

export function resolveAbcFilters(query: Record<string, string | string[] | undefined>): AbcFilters {
  return {
    accountSlug: typeof query.conta === "string" && query.conta !== "" ? query.conta : null,
    criterion: resolveAbcCriterion(query.criterio),
    days: resolveAbcPeriod(query.dias),
    // `semFull=1` liga; qualquer outra coisa desliga. A URL antiga usava a
    // mera presença do parâmetro, o que fazia `?semFull=0` LIGAR o filtro.
    onlyWithoutFull: query.semFull === "1",
    page: resolvePageParam(query.pagina),
  };
}

export function buildAbcHref(current: AbcFilters, override: Partial<AbcFilters>): string {
  const next = { ...current, ...override };

  return buildFilterHref(
    "/curva-abc",
    {
      conta: next.accountSlug,
      // Defaults ficam FORA da URL: `/curva-abc` limpo continua sendo a mesma
      // página de sempre, e o link compartilhado só carrega o que foi escolhido.
      criterio: next.criterion.key === ABC_CRITERIA[0].key ? null : next.criterion.key,
      dias: next.days === DEFAULT_PERIOD ? null : String(next.days),
      semFull: next.onlyWithoutFull ? "1" : null,
    },
    override.page === undefined ? 1 : next.page,
  );
}

export interface AbcSummary {
  label: string;
  totalPages: number;
}

/**
 * A frase que impede o defeito de D-140 de voltar: a tela somava as classes em
 * JavaScript sobre um resultado truncado em 1.000 de 1.492 e exibia classe C =
 * 298 quando o real era 790. As contagens agora vêm do Postgres, e esta frase
 * sempre diz quantos SKUs estão fora da página.
 */
export function summarizeAbcWindow(page: number, totalCount: number, rowsOnPage: number): AbcSummary {
  return summarizePagedWindow({
    page,
    totalCount,
    rowsOnPage,
    pageSize: PAGE_SIZE,
    noun: "SKUs na curva",
    emptyLabel: "Nenhum SKU com venda no período e escopo escolhidos.",
  });
}
