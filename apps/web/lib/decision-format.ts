import { formatCurrency } from "./format";
import { iniciais } from "./initials";

/**
 * Formatação da memória de decisões (Fase 6, D-064/D-065) — extraída de
 * `apps/web/app/acoes/action-card.tsx` em D-228, porque a aba `Decisões` do
 * Dashboard de SKU (um Server Component) precisa do MESMO texto que a Central
 * de Ações mostra, e um módulo `"use client"` não é lugar de onde um Server
 * Component importa função. Um formato, dois lugares: se a forma do snapshot
 * mudar, muda aqui, e as duas telas seguem dizendo a mesma coisa.
 */

/**
 * Comparação BRUTA lado a lado, nunca uma % sintetizada — mesmo raciocínio
 * de `/vendas`: `avg_price_7d`/outros podem faltar (SKU sem venda no
 * período), e o texto imprime "—" em vez de inventar zero.
 *
 * Recebe `unknown` porque `baseline_snapshot`/`outcome_snapshot` chegam como
 * `Json` do banco: o estreitamento acontece AQUI, uma vez, em vez de um cast
 * em cada tela (D-200: cast esconde qual guarda é real).
 */
export function formatDecisionSnapshot(snapshot: unknown): string {
  if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) {
    return "Sem dado.";
  }

  const registro = snapshot as Record<string, unknown>;

  if (Object.keys(registro).length === 0) return "Sem dado (ação sem SKU vinculado).";

  const unitsSold = registro.units_sold_7d;
  const avgPrice = registro.avg_price_7d;
  const stockLocal = registro.stock_local;

  const priceText = typeof avgPrice === "number" ? formatCurrency(avgPrice) : "—";

  return `Vendido (7d): ${String(unitsSold)} · Preço médio: ${priceText} · Estoque local: ${String(stockLocal)}`;
}

/** As três janelas que `diagnostics.measure-decision-outcomes` mede (D-065). */
export const OUTCOME_WINDOWS_DAYS: readonly number[] = [7, 15, 30];

export function outcomeWindowLabel(days: number): string {
  return `${String(days)} dias depois`;
}

/**
 * QUEM DECIDIU, e as quatro respostas que essa pergunta tem (A12, D-320).
 *
 * `action_decisions.created_by` é um `uuid` de `auth.users`; o nome mora em
 * `profiles.full_name`, lido pelos membros da organização. Entre o id e o nome
 * há três maneiras de não chegar a um nome, e cada uma diz uma coisa diferente
 * — por isso a linha não imprime o mesmo "—" para as três:
 *
 * - **a leitura dos membros falhou** (`membros === null`): não se sabe nada, e
 *   dizer "fora da organização" seria afirmar um fato que ninguém mediu;
 * - **o autor não está entre os membros de hoje**: a decisão é da organização
 *   e fica; quem saiu some de `organization_members`, e a policy de `profiles`
 *   (`shares_org_with`) deixa de mostrá-lo. "Fora da organização" é verdade
 *   tanto para quem saiu quanto para quem nunca foi membro;
 * - **o perfil existe e não tem nome** — `full_name` é opcional.
 *
 * O monograma é `?` nos três casos: iniciais de um rótulo como "fora da
 * organização" seriam "FD", letras de uma pessoa que não existe.
 */
export function autorDaDecisao(
  createdBy: string,
  membros: ReadonlyMap<string, string | null> | null,
): { rotulo: string; monograma: string } {
  if (membros === null) return { rotulo: "autor não carregado", monograma: "?" };

  if (!membros.has(createdBy)) return { rotulo: "fora da organização", monograma: "?" };

  const nome = membros.get(createdBy)?.trim() ?? "";

  if (nome === "") return { rotulo: "membro sem nome no perfil", monograma: "?" };

  return { rotulo: nome, monograma: iniciais(nome) };
}
