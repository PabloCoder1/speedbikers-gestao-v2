/**
 * Filtros da Central Full (D-173) — mesma divisão de D-167/D-172: a MECÂNICA
 * (href, página, resumo da janela) vem de `./filters`; aqui vive só o
 * vocabulário desta tela.
 *
 * `situacao` é conjunto FECHADO, espelho exato do `case` da RPC: valor
 * desconhecido na URL cai para "sem filtro" antes de tocar o banco.
 */

import { buildFilterHref, resolvePageParam, summarizePagedWindow } from "./filters";
import type { Tom } from "../components/tone";

export const PAGE_SIZE = 50;

export const FULL_SITUATIONS = ["saudavel", "parado", "ruptura", "ausente"] as const;

export type FullSituation = (typeof FULL_SITUATIONS)[number];

/**
 * Rótulo e explicação de cada situação. O critério aparece na tela junto do
 * nome — "ruptura" sem a regra ao lado é um julgamento sem base declarada.
 * Função TOTAL: situação desconhecida degrada para o valor cru.
 */
/**
 * Tom do chip de situação do Full — o vocabulário desta tela mapeado nos cinco
 * tons do Figma (`components/tone.ts`). Ruptura é perigo; parado pede atenção;
 * "fora do Full" é ausência, não problema, e fica neutro.
 */
export function fullSituationTom(value: string): Tom {
  switch (value) {
    case "saudavel":
      return "ok";
    case "ruptura":
      return "perigo";
    case "parado":
      return "atencao";
    default:
      return "neutro";
  }
}

export function fullSituationLabel(value: string): string {
  switch (value) {
    case "saudavel":
      return "Saudável";
    case "parado":
      return "Parado";
    case "ruptura":
      return "Ruptura";
    case "ausente":
      return "Fora do Full";
    default:
      return value;
  }
}

export function fullSituationCriterion(value: string): string {
  switch (value) {
    case "saudavel":
      return "tem saldo no Full e vendeu na janela";
    case "parado":
      return "tem saldo no Full e não vendeu nada na janela";
    case "ruptura":
      return "vendeu na janela e está com saldo ZERO no Full";
    case "ausente":
      return "sem saldo no Full e sem venda na janela";
    default:
      return "";
  }
}

export interface FullFilters {
  search: string | null;
  situation: string | null;
  account: string | null;
  page: number;
}

function readParam(raw: unknown): string | null {
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
}

function readMember(raw: unknown, allowed: readonly string[]): string | null {
  const value = readParam(raw);

  return value !== null && allowed.includes(value) ? value : null;
}

export function resolveFullFilters(query: Record<string, string | string[] | undefined>): FullFilters {
  return {
    search: readParam(query.busca),
    situation: readMember(query.situacao, FULL_SITUATIONS),
    // A conta não é conjunto fechado aqui: os ids vêm do banco, e a página
    // descarta um id que não pertença à organização antes de chamar a RPC.
    account: readParam(query.conta),
    page: resolvePageParam(query.pagina),
  };
}

/** Preserva as outras dimensões; conjunto novo volta à página 1 (regra de D-138/D-139). */
export function buildFullHref(current: FullFilters, override: Partial<FullFilters>): string {
  const next = { ...current, ...override };

  return buildFilterHref(
    "/full",
    { busca: next.search, situacao: next.situation, conta: next.account },
    override.page === undefined ? 1 : next.page,
  );
}

export { summarizePagedWindow };
