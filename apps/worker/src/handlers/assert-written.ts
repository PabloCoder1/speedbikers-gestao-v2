/**
 * Aborta quando uma escrita crítica falhou (D-178).
 *
 * O `AdminClient` é o cliente normal do Supabase: ele **não** transforma erro
 * do PostgREST em exceção só porque a chamada foi aguardada com `await`. Um
 * `await db.from(...).insert(...)` sem ler `.error` segue adiante como se
 * tivesse gravado — e o resto do handler continua, agora sobre uma premissa
 * falsa.
 *
 * Medido em 2026-09-01: `persist-order.ts` fazia isso em três escritas
 * (`orders.upsert`, `order_items.delete`, `order_items.insert`) e o fluxo
 * seguia para emitir eventos de domínio e deduzir estoque de um pedido que
 * podia não existir. `ml-fulfillment-fetch.ts` fazia o mesmo ao gravar o
 * snapshot antes de detectar eventos de Full.
 *
 * Por que LANÇAR e não logar: para escrita de dado de negócio, "falhou e
 * seguiu" é pior que "falhou e parou". Lançar faz o job terminar como
 * `failed` e o Cloud Tasks retentar — e os handlers já são idempotentes por
 * chave (`onConflict`/`idempotency_key`), então repetir é seguro.
 *
 * **A fronteira é o DADO, não a tabela — e D-178 a colocou no lugar errado
 * uma vez.** Escrita de OBSERVABILIDADE loga e continua: `sync_errors` é
 * telemetria, e perder telemetria não pode derrubar o trabalho real.
 * `stock_movements` estava desse lado e **não deveria**: uma linha ali é o
 * que move o saldo. D-187 a passou para cá. O que confundiu foi o 23505 —
 * absorver conflito de `idempotency_key` é idempotência funcionando;
 * absorver falha real é perda de estoque.
 */
export interface SupabaseWriteResult {
  error: { message: string; code?: string } | null;
}

export class CriticalWriteError extends Error {
  public constructor(
    public readonly operation: string,
    public readonly reason: string,
    public readonly code: string | undefined,
  ) {
    super(`escrita crítica falhou em ${operation}: ${reason}`);
    this.name = "CriticalWriteError";
  }
}

/**
 * Devolve o próprio resultado quando deu certo, para poder encadear:
 * `const { data } = assertWritten(await db.from(...).insert(...), "x")`.
 */
export function assertWritten<T extends SupabaseWriteResult>(result: T, operation: string): T {
  if (result.error !== null) {
    throw new CriticalWriteError(operation, result.error.message, result.error.code);
  }

  return result;
}
