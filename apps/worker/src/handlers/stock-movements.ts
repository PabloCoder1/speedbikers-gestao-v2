import type { AdminClient } from "@sb/db";
import type { StockMovementDraft } from "@sb/domain";

import { CriticalWriteError } from "./assert-written.js";

/**
 * Grava os rascunhos de dedução de estoque produzidos por
 * `computeSaleDeductions` (`@sb/domain/inventory`) em `stock_movements`.
 *
 * **Uma linha aqui NÃO é telemetria: é o que move o saldo.** D-178 classificou
 * `stock_movements` junto com `sync_errors` como observabilidade — "perder
 * telemetria não pode derrubar o trabalho real" — e essa fronteira estava no
 * lugar errado. D-187 a corrige: falha de gravação **aborta**.
 *
 * O que confundiu as duas coisas foi o 23505. Absorver conflito de
 * `idempotency_key` é a garantia física do ledger funcionando
 * (docs/DATABASE.md secao 3) — reprocessar o mesmo pedido não deduz o estoque
 * duas vezes, e isso continua igual. Absorver uma falha REAL é outra coisa
 * completamente diferente, e era o que estava acontecendo.
 *
 * **Por que a perda era invisível.** `verify-ledger-integrity` compara a soma
 * de `stock_movements` contra a projeção de `inventory_balances`. Se a linha
 * nunca foi gravada, o trigger `apply_to_balance` nunca disparou: os dois
 * lados ficam sem ela, **concordam**, e a verificação passa. Não havia
 * nenhum lugar do sistema onde essa perda aparecesse.
 *
 * **Por que abortar é seguro nos cinco chamadores.** Todos rodam dentro de
 * job com retry do Cloud Tasks, e a chave de idempotência torna repetir
 * inócuo. Em `nfe-import-apply` abortar é ESTRITAMENTE melhor: o
 * `documents.update({status:"APPLIED"})` vem DEPOIS desta chamada, então
 * lançar impede que a nota seja marcada como aplicada sem os movimentos —
 * hoje ela é marcada, e nunca mais é reprocessada.
 *
 * **Todos os tipos de movimento, não só `VENDA_ML`.** `ENTRADA_NFE`,
 * `SAIDA_NFE`, `AJUSTE_RECONCILIACAO`, `AJUSTE_MANUAL` e os de trânsito
 * movem o saldo pelo mesmo trigger. Uma lista de exceções seria uma lista
 * que ninguém revisa.
 *
 * **`ON CONFLICT DO NOTHING`, não `INSERT` com o 23505 absorvido no cliente**
 * (D-092). A versão anterior deixava o Postgres REJEITAR cada inserção
 * repetida, e cada rejeição virava uma linha ERROR no log do banco. Como a
 * reconciliação horária reprocessa a mesma janela de pedidos, isso produzia
 * ~9.800 ERROS por dia — todos esperados, todos inúteis, e juntos capazes de
 * enterrar um erro de verdade. A garantia não mudou: a constraint UNIQUE
 * continua existindo e continua sendo o que torna a dupla movimentação
 * fisicamente impossível. O que mudou é o Postgres pular em silêncio em vez
 * de gritar.
 */

const UNIQUE_VIOLATION = "23505";

export interface RecordStockMovementsContext {
  organizationId: string;
}

export async function recordStockMovements(
  db: AdminClient,
  context: RecordStockMovementsContext,
  drafts: readonly StockMovementDraft[],
  movementType: string,
  source: { type: string; id: string },
): Promise<void> {
  for (const draft of drafts) {
    const result = await db.from("stock_movements").upsert(
      {
        organization_id: context.organizationId,
        sku_id: draft.skuId,
        location_kind: draft.locationKind ?? "LOCAL",
        qty_delta: draft.qtyDelta,
        movement_type: movementType,
        source_type: source.type,
        source_id: source.id,
        idempotency_key: draft.idempotencyKey,
        occurred_at: draft.occurredAt.toISOString(),
      },
      // `ignoreDuplicates` = DO NOTHING, nunca DO UPDATE: `stock_movements` é
      // append-only (D-019), e reescrever um movimento existente seria
      // exatamente o que o ledger existe para impedir.
      { onConflict: "idempotency_key", ignoreDuplicates: true },
    );

    // A checagem de 23505 fica como rede: `onConflict` cobre a UNIQUE de
    // `idempotency_key`, mas uma constraint futura não coberta por ela ainda
    // chegaria aqui — e continuaria sendo idempotência, não falha.
    if (result.error !== null && result.error.code !== UNIQUE_VIOLATION) {
      // O contexto vai na mensagem em vez de num log separado: um sinal só,
      // com tudo que se precisa para achar a linha que não entrou.
      throw new CriticalWriteError(
        `stock_movements (${movementType}, sku ${draft.skuId}, chave ${draft.idempotencyKey})`,
        result.error.message,
        result.error.code,
      );
    }
  }
}
