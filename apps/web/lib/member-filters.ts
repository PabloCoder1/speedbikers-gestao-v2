/**
 * Filtros de `/usuarios` (D-297), puros e testáveis sem React nem banco.
 *
 * O frame desenha os dois no cabeçalho do painel "Gerenciar Acessos": a caixa
 * de busca ("Buscar usuário ou e-mail…") e o menu "Status ⌄". A mecânica de
 * href é a compartilhada de `./filters`, como em `./purchase-order-filters`;
 * aqui fica o vocabulário próprio.
 *
 * **Filtra em memória, e isso é medido, não preguiça.** A lista de membros não
 * pagina — a RLS já a restringe à organização, e `members.length` É o total.
 * O e-mail e o estado vêm de OUTRA fonte (`get_organization_members`, a janela
 * de `auth.users` de D-296): mandar a busca ao PostgREST seria recortar em dois
 * lugares a mesma frase.
 *
 * **O status não é coluna de banco**: sai da janela — `suspended` (D-354) e
 * `invite_accepted`. Quem não é ADMIN não recebe a janela, então para ele o
 * menu não existe — e o filtro cai em "todos".
 */

import { buildFilterHref } from "./filters";

/**
 * Os três estados que o dado sustenta:
 *
 * - **ativo** — já entrou alguma vez e não está suspenso;
 * - **pendente** — tem vínculo e nunca entrou (convite aberto);
 * - **suspenso** — `auth.users.banned_until` no futuro (D-354). Até D-354 este
 *   estado era recusado por falta de fonte; a suspensão pela `api` é a fonte.
 *
 * "Inativo" continua fora: não há coluna que diga isso, e inventar um corte por
 * tempo sem acesso seria uma regra de negócio que ninguém pediu.
 */
export const MEMBER_STATUSES = ["ativo", "pendente", "suspenso"] as const;

export type MemberStatus = (typeof MEMBER_STATUSES)[number];

export interface MemberFilters {
  status: MemberStatus | null;
  search: string | null;
}

/** Mesma leitura de `purchase-order-filters`: vazio e só-espaço viram nulo. */
function readParam(raw: unknown): string | null {
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
}

/**
 * Estado fora da lista fechada cai em "todos" e NÃO vira recorte: zero linhas
 * seria indistinguível de um filtro legítimo sem resultado (lição de D-242).
 */
export function resolveMemberStatus(raw: unknown): MemberStatus | null {
  if (typeof raw !== "string") return null;

  return (MEMBER_STATUSES as readonly string[]).includes(raw) ? (raw as MemberStatus) : null;
}

export function resolveMemberFilters(
  query: Record<string, string | string[] | undefined>,
): MemberFilters {
  return { status: resolveMemberStatus(query.estado), search: readParam(query.busca) };
}

export function buildMemberHref(current: MemberFilters, override: Partial<MemberFilters>): string {
  const next = { ...current, ...override };

  // "Todos" é a ausência do parâmetro: `/usuarios` limpo continua sendo a
  // mesma página de sempre. A lista não pagina, então a página é sempre 1.
  return buildFilterHref("/usuarios", { estado: next.status, busca: next.search }, 1);
}

/** O rótulo nas duas pontas: coluna Status e menu do painel. */
export function memberStatusLabel(status: MemberStatus): string {
  if (status === "ativo") return "Ativo";
  if (status === "pendente") return "Convite pendente";

  return "Suspenso";
}

/**
 * O tom do selo. Suspenso é ATENÇÃO, não perigo: nesta casa `perigo` é coisa
 * errada acontecendo, e suspender é um ato deliberado de um ADMIN — o selo diz
 * "esta pessoa não entra", não "algo quebrou".
 */
export function memberStatusTone(status: MemberStatus): "ok" | "neutro" | "atencao" {
  if (status === "ativo") return "ok";
  if (status === "pendente") return "neutro";

  return "atencao";
}

export interface MemberMatchInput {
  readonly nome: string | null;
  /** Só existe para ADMIN — a janela de D-296 não responde a mais ninguém. */
  readonly email: string | null;
  readonly status: MemberStatus;
}

/**
 * A busca casa NOME ou E-MAIL, sem caixa.
 *
 * Sem dobra de acento de propósito: normalizar acento aqui criaria uma segunda
 * regra de comparação — a do PostgREST, que atende as outras telas, não dobra
 * tampouco. Uma regra por repositório vale mais que duas parecidas.
 */
export function matchesMemberFilters(row: MemberMatchInput, filters: MemberFilters): boolean {
  if (filters.status !== null && row.status !== filters.status) return false;

  if (filters.search === null) return true;

  const agulha = filters.search.toLowerCase();

  return (
    (row.nome ?? "").toLowerCase().includes(agulha) ||
    (row.email ?? "").toLowerCase().includes(agulha)
  );
}

/**
 * A frase que impede a tabela de mentir sobre o recorte.
 *
 * Sem ela, filtrar 18 membros para 3 deixaria a tela mostrando três linhas sem
 * dizer que quinze foram escondidas — o mesmo defeito que
 * `summarizePagedWindow` existe para evitar na paginação (D-131).
 */
export function summarizeMemberWindow(
  total: number,
  mostrados: number,
  filters: MemberFilters,
): string {
  const recortes = [
    filters.status === null ? null : `status ${memberStatusLabel(filters.status).toLowerCase()}`,
    filters.search === null ? null : `busca “${filters.search}”`,
  ].filter((parte): parte is string => parte !== null);

  if (recortes.length === 0) {
    return mostrados === 1 ? "1 pessoa nesta organização." : `${String(mostrados)} pessoas nesta organização.`;
  }

  const onde = recortes.join(" e ");

  if (mostrados === 0) return `Nenhuma das ${String(total)} pessoas casa com ${onde}.`;

  return `${String(mostrados)} de ${String(total)} pessoas, por ${onde}.`;
}
