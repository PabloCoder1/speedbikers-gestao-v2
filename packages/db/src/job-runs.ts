import type { AdminClient } from "./admin-client.js";
import type { TablesInsert } from "./types.js";

/**
 * Gravação do histórico de execução de jobs (camada L2).
 *
 * A tabela é append-only e o banco impõe isso com trigger — não existe função
 * de atualizar nem de apagar aqui de propósito.
 */

export type JobRunInsert = TablesInsert<"job_runs">;

export type RecordResult = { ok: true } | { ok: false; reason: string };

/**
 * Grava uma execução.
 *
 * **Nunca lança.** Devolve o resultado para o chamador decidir.
 *
 * O motivo é de desenho: um job que trabalhou corretamente mas cujo registro de
 * observabilidade falhou **não pode** ser reprocessado. Lançar aqui faria o
 * worker devolver 5xx, o Cloud Tasks repetir, e o trabalho ser refeito por uma
 * falha que não tem nada a ver com o trabalho. Observabilidade não pode ditar o
 * resultado da operação que ela observa.
 */
export async function recordJobRun(
  client: AdminClient,
  run: JobRunInsert,
): Promise<RecordResult> {
  const { error } = await client.from("job_runs").insert(run);

  if (error !== null) {
    return { ok: false, reason: error.message };
  }

  return { ok: true };
}
