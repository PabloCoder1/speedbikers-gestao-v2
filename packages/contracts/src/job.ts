import { z } from "zod";

/**
 * Envelope comum a todo job enfileirado.
 *
 * O payload específico de cada tipo de job é validado pelo handler; aqui fica
 * apenas o que a infraestrutura de fila precisa conhecer.
 */
export const jobEnvelopeSchema = z.object({
  /** Tipo do job, no formato `dominio.entidade.acao`. Ver docs/API.md. */
  jobType: z.string().min(1),

  /** Identificador desta execução. Muda a cada reenfileiramento. */
  jobId: z.uuid(),

  /** Organização dona do trabalho. Ver D-031. */
  organizationId: z.uuid(),

  /**
   * Chave lógica de deduplicação.
   *
   * Dois jobs com a mesma `dedupeKey` representam o mesmo trabalho e devem
   * colapsar num só — é o mecanismo que faz a chave suja do analytics
   * funcionar (ver docs/ARCHITECTURE.md, secao 10).
   */
  dedupeKey: z.string().min(1),

  /** Tentativa atual, começando em 1. */
  attempt: z.number().int().min(1),

  enqueuedAt: z.iso.datetime({ offset: true }),
});

export type JobEnvelope = z.infer<typeof jobEnvelopeSchema>;

/**
 * Limite interno conservador para o identificador da task. A documentação
 * oficial do Cloud Tasks permite 500 caracteres (confirmado em 2026-08-21);
 * manter 200 deixa folga para o caminho completo do recurso e para logs.
 */
const MAX_TASK_NAME_LENGTH = 200;

const UNSAFE_CHARACTERS = /[^A-Za-z0-9_-]+/g;

/** FNV-1a de 32 bits. Determinístico e sem dependência de runtime. */
function hash(value: string): string {
  let acc = 0x811c9dc5;

  for (let index = 0; index < value.length; index += 1) {
    acc ^= value.charCodeAt(index);
    acc = Math.imul(acc, 0x01000193) >>> 0;
  }

  return acc.toString(36);
}

/**
 * Converte uma `dedupeKey` num identificador de task estável e seguro.
 *
 * A mesma chave sempre produz o mesmo nome — é isso que permite à fila
 * descartar o trabalho duplicado. Chaves longas são truncadas com sufixo de
 * hash para continuarem únicas.
 */
export function toTaskName(dedupeKey: string): string {
  const sanitized = dedupeKey.replace(UNSAFE_CHARACTERS, "-").replace(/^-+|-+$/g, "");

  if (sanitized.length === 0) {
    return `job-${hash(dedupeKey)}`;
  }

  if (sanitized.length <= MAX_TASK_NAME_LENGTH) {
    return sanitized;
  }

  const suffix = `-${hash(dedupeKey)}`;

  return `${sanitized.slice(0, MAX_TASK_NAME_LENGTH - suffix.length)}${suffix}`;
}
