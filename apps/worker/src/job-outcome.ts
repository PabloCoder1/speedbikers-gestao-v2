/**
 * Resultado de um job e sua tradução para status HTTP.
 *
 * O status HTTP **é** o mecanismo de controle de retry do Cloud Tasks, e a
 * regra é mais simples — e mais dura — do que este arquivo dizia até D-201:
 *
 * > **O Cloud Tasks repete QUALQUER resposta que não seja 2xx.** Ele não
 * > distingue 4xx de 5xx. Só o 2xx encerra a task.
 *
 * A versão anterior afirmava "4xx a descarta sem repetir" e mapeava falha
 * definitiva para 422. **Isso nunca funcionou**, e o custo foi medido em 7
 * dias no Dev (D-201):
 *
 *   job_ids reentregues ..................  535
 *   execucoes extras ..................... 2.234
 *   maior numero de entregas do mesmo job     8
 *
 * Oito é exatamente o `--max-attempts 8` das filas `ml-sync-*`
 * (`infra/cloud-tasks-queues.sh`). Ou seja: toda falha "permanente" queimava o
 * orçamento inteiro da fila. Uma pergunta apagada no Mercado Livre devolve
 * 404, o handler a classifica CORRETAMENTE como `not_retryable` — e ela era
 * buscada oito vezes assim mesmo.
 *
 * Por isso falha definitiva agora responde **200**. Não é "fingir sucesso": é
 * o único jeito de dizer ao Cloud Tasks "não repita". A verdade sobre o job
 * continua registrada onde sempre esteve — `job_runs.status = 'failed'` com
 * `retryable = false` e o motivo — e o corpo da resposta continua dizendo
 * `{"status":"failed"}` para quem lê a resposta em vez do código.
 *
 * A classificação segue docs/API.md secao 6.
 */

export type JobOutcome =
  | { status: "done"; processed?: number }
  | { status: "failed"; retryable: boolean; reason: string };

export const JOB_STATUS = {
  /** Concluído. A task sai da fila. */
  done: 200,
  /**
   * Falha definitiva: repetir não muda o resultado.
   *
   * **200 de propósito** — ver o cabeçalho deste arquivo. Só 2xx faz o Cloud
   * Tasks descartar; um 4xx aqui devolve as 8 reentregas que D-201 mediu.
   */
  permanentFailure: 200,
  /** Falha transitória: rate limit, indisponibilidade, timeout. Repetir. */
  transientFailure: 503,
  /**
   * Envelope inválido: repetir nunca vai resolver, então **200** pelo mesmo
   * motivo da falha definitiva. O corpo diz `{"status":"rejected"}`.
   *
   * Este endpoint é alvo exclusivo do Cloud Tasks, não uma API pública — o
   * código HTTP aqui fala com a fila, não com uma pessoa. Quem depura lê o
   * corpo e o `job_runs`.
   */
  invalidEnvelope: 200,
  /**
   * Tipo de job desconhecido: **repetir**, e isto é uma mudança deliberada.
   *
   * "Desconhecido" pode ser permanente (tipo que não existe) ou **temporário**
   * — a janela entre a `api` passar a enfileirar um tipo novo e o worker novo
   * subir. Descartar na janela perderia trabalho real; repetir custa até 8
   * tentativas com backoff de 10s a 600s, tempo de sobra para o deploy pousar.
   *
   * Antes de D-201 isto respondia 400 e, por causa do defeito que a mesma
   * decisão descreve, era repetido assim mesmo. O comportamento efetivo não
   * muda; o que muda é o código passar a dizer a verdade sobre a intenção.
   */
  unknownJobType: 503,
} as const;

export type JobHttpStatus = (typeof JOB_STATUS)[keyof typeof JOB_STATUS];

export function toHttpStatus(outcome: JobOutcome): JobHttpStatus {
  if (outcome.status === "done") {
    return JOB_STATUS.done;
  }

  return outcome.retryable ? JOB_STATUS.transientFailure : JOB_STATUS.permanentFailure;
}

/**
 * Classifica um erro inesperado de handler.
 *
 * O padrão é **retryable**: diante da dúvida, é melhor tentar de novo do que
 * descartar trabalho. Falha definitiva precisa ser declarada explicitamente
 * pelo handler.
 */
export function toOutcome(error: unknown): JobOutcome {
  return {
    status: "failed",
    retryable: true,
    reason: error instanceof Error ? error.message : "erro desconhecido",
  };
}

/**
 * Quantas vezes o Cloud Tasks já entregou esta task, começando em 1.
 *
 * **O envelope não sabe disso.** `attempt` viaja no CORPO do job, e o Cloud
 * Tasks reentrega o mesmo corpo — então ele marcava `1` nas 2.234 execuções
 * extras que D-201 mediu. Quem sabe é o cabeçalho `X-CloudTasks-TaskRetryCount`,
 * que a fila incrementa a cada reentrega e conta a partir de **0**.
 *
 * Sem o cabeçalho (teste local, chamada manual), cai no valor do envelope —
 * que é o melhor palpite disponível, e não zero.
 */
export function resolveAttempt(header: string | undefined, envelopeAttempt: number): number {
  if (header === undefined) {
    return envelopeAttempt;
  }

  const retries = Number(header);

  if (!Number.isInteger(retries) || retries < 0) {
    return envelopeAttempt;
  }

  return retries + 1;
}
