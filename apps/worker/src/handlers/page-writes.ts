import type { AdminClient, TablesInsert } from "@sb/db";
import type { StockMovementDraft } from "@sb/domain";

import { assertWritten, CriticalWriteError } from "./assert-written.js";

/**
 * As escritas de uma página inteira de pedidos, acumuladas e descarregadas de
 * uma vez (D-190).
 *
 * **Por que existe.** Medido em D-185: o custo de uma ida ao banco é o round
 * trip, não o SQL — as sete idas de um pedido somam 3,95 ms de servidor
 * contra 660,7 ms observados. D-186 e D-188 resolveram as leituras; sobravam
 * quatro escritas POR PEDIDO, que numa página de 50 são 200 idas seriais.
 *
 * **Por que só agora.** O lote de escrita esteve bloqueado por três
 * pré-requisitos, e nenhum era contornável:
 *
 *  - `order_items` era `delete` + `insert` sem transação entre chamadas, e em
 *    lote um insert que falhasse depois do delete deixaria 50 pedidos sem
 *    itens. **D-189** inverteu para `upsert` + exclusão da cauda: não há mais
 *    janela para multiplicar.
 *  - `recordStockMovements` é compartilhada com `nfe-import-apply`, que não
 *    tem retry. **D-187** fez a gravação abortar, e este módulo usa função
 *    PRÓPRIA — a compartilhada não muda de forma.
 *  - o trigger `stock_movements_apply_to_balance` é `AFTER INSERT FOR EACH
 *    ROW` e faz `DO UPDATE` em `inventory_balances`: N linhas num statement
 *    seguram N travas de saldo. Resolvido aqui, ver `ordenaPorSku`.
 */
export interface PageWrites {
  orders: TablesInsert<"orders">[];
  items: TablesInsert<"order_items">[];
  /** Posição a partir da qual apagar, por pedido. Ver `flushPageWrites`. */
  tails: { orderId: number; fromPosition: number }[];
  events: TablesInsert<"domain_events">[];
  movements: { draft: StockMovementDraft; movementType: string; source: { type: string; id: string } }[];
  organizationId: string;
}

export function novaPagina(organizationId: string): PageWrites {
  return { orders: [], items: [], tails: [], events: [], movements: [], organizationId };
}

/**
 * `ON CONFLICT DO UPDATE` **falha** — "cannot affect row a second time" — se a
 * mesma chave aparecer duas vezes no MESMO comando. Sequencialmente isso
 * nunca foi problema: dois upserts do mesmo pedido são dois comandos.
 *
 * O Mercado Livre pagina por offset, e uma order atualizada durante a
 * varredura pode aparecer duas vezes. Manter a ÚLTIMA ocorrência reproduz o
 * que a forma sequencial fazia — a segunda gravação sobrescrevia a primeira.
 */
function ultimaPorChave<T>(linhas: readonly T[], chave: (linha: T) => string): T[] {
  const porChave = new Map<string, T>();

  for (const linha of linhas) {
    porChave.set(chave(linha), linha);
  }

  return [...porChave.values()];
}

/**
 * Ordena os movimentos por SKU antes de gravar — e isto é a correção do
 * terceiro pré-requisito, não arrumação.
 *
 * `stock_movements_apply_to_balance` é `AFTER INSERT FOR EACH ROW` e faz
 * `DO UPDATE` em `inventory_balances`. Um insert de N linhas dispara N
 * execuções do trigger dentro do MESMO statement, cada uma travando a linha
 * de saldo do seu SKU — N travas seguradas ao mesmo tempo, na ordem em que as
 * linhas aparecem. Dois lotes concorrentes com SKUs em comum, em ordens
 * diferentes, formam ciclo: deadlock.
 *
 * Hoje isso é impossível porque cada movimento é um statement próprio, que
 * segura uma trava de cada vez. Ordenar por `sku_id` restaura a garantia: todo
 * lote adquire na mesma ordem, então não há ciclo. Um lote contra um insert de
 * uma linha também não fecha ciclo — quem segura uma trava só nunca espera.
 */
function ordenaPorSku(
  movimentos: readonly { draft: StockMovementDraft; movementType: string; source: { type: string; id: string } }[],
): typeof movimentos {
  return [...movimentos].sort((a, b) => (a.draft.skuId < b.draft.skuId ? -1 : a.draft.skuId > b.draft.skuId ? 1 : 0));
}

/**
 * Descarrega a página. A ORDEM importa e não é escolha de estilo:
 *
 *  1. `orders` antes de `order_items` — `order_items_order_id_fkey` referencia
 *     `orders(id)`, então o item de um pedido que ainda não existe é rejeitado.
 *  2. a exclusão da cauda DEPOIS da gravação dos itens — é a inversão de
 *     D-189, e é o que impede que exista instante sem os itens atuais.
 *  3. os movimentos por último — dependem dos itens terem sido aceitos.
 */
export async function flushPageWrites(db: AdminClient, writes: PageWrites): Promise<void> {
  if (writes.orders.length > 0) {
    assertWritten(
      await db.from("orders").upsert(ultimaPorChave(writes.orders, (row) => String(row.id)), { onConflict: "id" }),
      `orders.upsert em lote (${String(writes.orders.length)} pedidos)`,
    );
  }

  if (writes.items.length > 0) {
    assertWritten(
      await db.from("order_items").upsert(
        ultimaPorChave(writes.items, (row) => `${String(row.order_id)}:${String(row.position)}`),
        { onConflict: "order_id,position" },
      ),
      `order_items.upsert em lote (${String(writes.items.length)} itens)`,
    );
  }

  // Agrupado por posição de corte: quase sempre um grupo só, porque todo
  // pedido tem exatamente 1 item (D-184). Um `gte` uniforme por grupo evita
  // uma chamada por pedido sem precisar supor que a contagem é sempre igual.
  const porCorte = new Map<number, number[]>();

  for (const tail of writes.tails) {
    porCorte.set(tail.fromPosition, [...(porCorte.get(tail.fromPosition) ?? []), tail.orderId]);
  }

  for (const [fromPosition, orderIds] of porCorte) {
    assertWritten(
      await db.from("order_items").delete().in("order_id", orderIds).gte("position", fromPosition),
      `order_items.delete da cauda em lote (${String(orderIds.length)} pedidos, posicao >= ${String(fromPosition)})`,
    );
  }

  if (writes.events.length > 0) {
    // `domain_events` é append-only com `dedup_key` UNIQUE, e grava por
    // `ON CONFLICT DO NOTHING` (D-092) — que, ao contrário de `DO UPDATE`,
    // aceita chave repetida dentro do mesmo comando. Não precisa de dedupe.
    const resultado = await db
      .from("domain_events")
      .upsert(writes.events, { onConflict: "dedup_key", ignoreDuplicates: true });

    if (resultado.error !== null && resultado.error.code !== "23505") {
      // `domain_events` é observabilidade de negócio, não o saldo: a
      // fronteira de D-187 não muda aqui. Mas em lote não há como seguir sem
      // saber o que entrou, então aborta — o job é idempotente por
      // `dedup_key`.
      throw new CriticalWriteError(
        `domain_events.upsert em lote (${String(writes.events.length)} eventos)`,
        resultado.error.message,
        resultado.error.code,
      );
    }
  }

  if (writes.movements.length > 0) {
    const linhas = ordenaPorSku(writes.movements).map(({ draft, movementType, source }) => ({
      organization_id: writes.organizationId,
      sku_id: draft.skuId,
      location_kind: draft.locationKind ?? "LOCAL",
      qty_delta: draft.qtyDelta,
      movement_type: movementType,
      source_type: source.type,
      source_id: source.id,
      idempotency_key: draft.idempotencyKey,
      occurred_at: draft.occurredAt.toISOString(),
    }));

    const resultado = await db
      .from("stock_movements")
      .upsert(linhas, { onConflict: "idempotency_key", ignoreDuplicates: true });

    // Mesma regra de D-187: 23505 é a idempotência funcionando; qualquer
    // outra falha é linha de saldo perdida, e isso aborta.
    if (resultado.error !== null && resultado.error.code !== "23505") {
      throw new CriticalWriteError(
        `stock_movements.upsert em lote (${String(linhas.length)} movimentos)`,
        resultado.error.message,
        resultado.error.code,
      );
    }
  }
}
