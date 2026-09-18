/**
 * O prazo de um atendimento dito como a fila precisa ler (lote 2 do pente fino,
 * 18/09). A coluna SLA mostrava só a data: um prazo vencido ontem e um que vence
 * na semana que vem pareciam iguais, e o detalhe do caso já distinguia os dois.
 *
 * Os limites são os de `get_support_metrics`: vencido é `due_at < agora`; "vence
 * em breve" são as próximas 24 h. O que passa disso fica `neutro`, com a data.
 */

export type DeadlineTone = "perigo" | "atencao" | "neutro";

export interface DeadlineView {
  readonly tone: DeadlineTone;
  /** "vencido há 3 h", "vence em 40 min" — `null` quando a data basta. */
  readonly relative: string | null;
}

const MINUTO = 60_000;
const HORA = 60 * MINUTO;
const DIA = 24 * HORA;

function duracao(ms: number): string {
  if (ms < HORA) return `${String(Math.max(1, Math.floor(ms / MINUTO)))} min`;
  if (ms < DIA) return `${String(Math.floor(ms / HORA))} h`;

  const dias = Math.floor(ms / DIA);

  return `${String(dias)} ${dias === 1 ? "dia" : "dias"}`;
}

export function describeDeadline(dueAt: string, agora: Date = new Date()): DeadlineView {
  const delta = Date.parse(dueAt) - agora.getTime();

  if (Number.isNaN(delta)) return { tone: "neutro", relative: null };

  if (delta < 0) return { tone: "perigo", relative: `vencido há ${duracao(-delta)}` };

  if (delta < DIA) return { tone: "atencao", relative: `vence em ${duracao(delta)}` };

  return { tone: "neutro", relative: null };
}
