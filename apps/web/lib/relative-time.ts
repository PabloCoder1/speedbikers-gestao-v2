/**
 * "há 12 min" — a idade de um registro, para o cartão da Central de Ações
 * (D23) dizer quão fresco ele é.
 *
 * **Só DURAÇÕES, nunca "Hoje" nem "Ontem", e isso é deliberado.** O frame
 * escreve "Hoje, 08:15" e "Ontem" ao lado de "12 min atrás". As duas primeiras
 * dependem de qual dia é *hoje* — e "hoje" só existe dentro de um fuso. É
 * exatamente a armadilha que D-260 pagou: `toISOString()` (UTC) onde a tela
 * usava o dia de negócio deslocou um histórico inteiro para outro dia da
 * semana. Uma duração não tem esse problema: a diferença entre dois instantes
 * é a mesma em qualquer fuso.
 *
 * Acima da janela útil a função devolve `null` e quem chama mostra a data
 * absoluta por `formatBusinessDate`, que já sabe o fuso de negócio. Uma
 * definição de "que dia é hoje" no projeto, não duas.
 */

const MINUTO = 60_000;
const HORA = 60 * MINUTO;
const DIA = 24 * HORA;

/** Acima disso, "há 34 dias" já não informa nada que a data não informe melhor. */
const JANELA_MS = 7 * DIA;

/**
 * `null` quando o instante é ilegível, está no futuro, ou é velho demais para
 * a janela — os três casos em que quem chama deve mostrar a data absoluta.
 *
 * Futuro devolve `null` em vez de "há -3 min": relógio de servidor adiantado
 * em relação ao banco é comum, e a tela não deve inventar uma contagem
 * negativa por causa de alguns segundos de desvio.
 */
export function formatAge(iso: string | null, agora: Date = new Date()): string | null {
  if (iso === null) return null;

  const instante = Date.parse(iso);

  if (Number.isNaN(instante)) return null;

  const delta = agora.getTime() - instante;

  if (delta < 0 || delta > JANELA_MS) return null;

  if (delta < MINUTO) return "agora há pouco";

  if (delta < HORA) {
    const minutos = Math.floor(delta / MINUTO);

    return `há ${String(minutos)} min`;
  }

  if (delta < DIA) {
    const horas = Math.floor(delta / HORA);

    return `há ${String(horas)} h`;
  }

  const dias = Math.floor(delta / DIA);

  // Uma forma para cada número: "há 1 dias" é o defeito que
  // `summarizePagedWindow` já pagou em oito telas (D-131).
  return dias === 1 ? "há 1 dia" : `há ${String(dias)} dias`;
}
