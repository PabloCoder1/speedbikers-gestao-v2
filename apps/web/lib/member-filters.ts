/**
 * Filtros de `/usuarios` (D-297), puros e testáveis sem React nem banco.
 *
 * O frame desenha os dois no cabeçalho do painel "Gerenciar Acessos": a caixa
 * de busca ("Buscar usuário ou e-mail…") e o menu "Status ⌄". A mecânica de
 * href é a compartilhada de `./filters`, como em `./purchase-order-filters`;
 * aqui fica o vocabulário próprio.
 *
 * **Filtra em memória, e isso é medido, não preguiça.** A lista de membros não
 * pagina — a RLS já a restringe à organização, e `members.length` É o total
 * (não o tamanho de uma página). Mandar busca ao PostgREST exigiria `.or()`
 * sobre `profiles.full_name` embutido mais o e-mail, que vem de OUTRA fonte
 * (`get_organization_members`, a janela de `auth.users` de D-296): dois
 * recortes em dois lugares para a mesma frase. Com a lista inteira já na mão,
 * o recorte é uma comparação.
 *
 * **O status não é coluna de banco**: é `last_sign_in_at is not null`,
 * traduzido pela janela em `invite_accepted`. Quem não é ADMIN não recebe a
 * janela, então para ele o menu não existe — e o filtro cai em "todos".
 */

import { buildFilterHref } from "./filters";

/**
 * Os dois estados que o frame desenha na coluna Status — e são dois porque o
 * dado é booleano: entrou alguma vez, ou nunca entrou. Um terceiro
 * ("suspenso", "inativo") não tem fonte: não há coluna que o sustente.
 */
export const MEMBER_STATUSES = ["ativo", "pendente"] as const;

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

/** O rótulo do frame, nas duas pontas: coluna Status e menu do painel. */
export function memberStatusLabel(status: MemberStatus): string {
  return status === "ativo" ? "Ativo" : "Convite pendente";
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
 * Sem dobra de acento de propósito: o que o campo busca é nome de pessoa e
 * endereço, e normalizar acento aqui criaria uma segunda regra de comparação —
 * a do PostgREST, que atende as outras telas, não dobra tampouco. Uma regra
 * por repositório vale mais que duas parecidas.
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
