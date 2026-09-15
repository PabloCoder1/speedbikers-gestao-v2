/**
 * "Há 3 dias" — o tempo desde um instante, em português (D-355).
 *
 * Na coluna "Último acesso" o que se procura é quem SUMIU: "15/08/2026 09:42"
 * obriga a fazer a conta de cabeça em cada linha, e "há 1 mês" responde de uma
 * vez. A data exata não se perde — a tela a põe no `title` da célula.
 *
 * `agora` entra por parâmetro para a função ser testável sem relógio falso.
 */

const MINUTO = 60;
const HORA = 60 * MINUTO;
const DIA = 24 * HORA;
const MES = 30 * DIA;
const ANO = 365 * DIA;

const formatador = new Intl.RelativeTimeFormat("pt-BR", { numeric: "auto" });

export function tempoRelativo(iso: string | null, agora: Date = new Date()): string | null {
  if (iso === null) return null;

  const instante = Date.parse(iso);

  if (Number.isNaN(instante)) return null;

  const segundos = Math.round((instante - agora.getTime()) / 1000);
  const distancia = Math.abs(segundos);

  if (distancia < MINUTO) return "agora há pouco";
  if (distancia < HORA) return formatador.format(Math.round(segundos / MINUTO), "minute");
  if (distancia < DIA) return formatador.format(Math.round(segundos / HORA), "hour");
  if (distancia < MES) return formatador.format(Math.round(segundos / DIA), "day");
  if (distancia < ANO) return formatador.format(Math.round(segundos / MES), "month");

  return formatador.format(Math.round(segundos / ANO), "year");
}
