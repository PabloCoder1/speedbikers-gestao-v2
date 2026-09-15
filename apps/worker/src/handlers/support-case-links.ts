import type { AdminClient, TablesInsert } from "@sb/db";

function persistenceError(operation: string, error: { message: string }): Error {
  return new Error(`falha ao ${operation}: ${error.message}`);
}

/**
 * Grava um vínculo de atendimento só quando ele ainda não existe (D-353).
 *
 * As três ingestões (Pergunta, Conversa, Claim) re-persistem o mesmo case a
 * cada varredura — Perguntas e Mensagens de 10 em 10 minutos, Claims de hora
 * em hora — e faziam um INSERT cego que contava com o 23505 para absorver a
 * repetição. O dado ficava certo, mas cada repetição era um ERROR no log do
 * Postgres: 4.001 em 24h em produção, 98% do que o painel mostrava, com
 * qualquer erro real escondido no meio deles, e uma tupla morta por tentativa.
 *
 * Não dá para trocar por `upsert(..., { ignoreDuplicates })`: os quatro
 * índices únicos são PARCIAIS e o `on_conflict` do PostgREST não expressa o
 * predicado (a mesma razão do seed de E2E). A saída é consultar pela chave do
 * índice e só inserir o que falta. O 23505 continua tolerado para a corrida
 * real: webhook e varredura gravando o mesmo case no mesmo instante.
 */
export async function ensureSupportLink(db: AdminClient, row: TablesInsert<"support_case_links">): Promise<void> {
  const byCase = db.from("support_case_links").select("id").eq("support_case_id", row.support_case_id);

  // CHECK `support_case_links_exactly_one_target`: cada linha tem UM alvo,
  // então UM dos quatro índices decide se ela já existe.
  let lookup: typeof byCase | null = null;

  if (typeof row.order_id === "number") {
    lookup = byCase.eq("order_id", row.order_id);
  } else if (typeof row.sku_id === "string") {
    lookup = byCase.eq("sku_id", row.sku_id);
  } else if (typeof row.listing_id === "string") {
    lookup = byCase.eq("listing_id", row.listing_id);
  } else if (typeof row.external_entity_kind === "string" && typeof row.external_entity_id === "string") {
    lookup = byCase.eq("external_entity_kind", row.external_entity_kind).eq("external_entity_id", row.external_entity_id);
  }

  // Sem alvo nenhum o INSERT abaixo é recusado pelo próprio CHECK, com a
  // mensagem do banco — melhor do que uma consulta que nunca acharia nada.
  if (lookup !== null) {
    const existing = await lookup.maybeSingle();

    if (existing.error !== null) {
      throw persistenceError("consultar vínculo do atendimento", existing.error);
    }

    if (existing.data !== null) {
      return;
    }
  }

  const result = await db.from("support_case_links").insert(row);

  // 23505 aqui é só a corrida: outra ingestão gravou o mesmo vínculo entre a
  // consulta e o INSERT.
  if (result.error !== null && result.error.code !== "23505") {
    throw persistenceError("gravar vínculo do atendimento", result.error);
  }
}
