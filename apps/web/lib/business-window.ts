import { shiftBusinessDate, toSalesMetricDate } from "@sb/domain";

/**
 * Os últimos `dias` dias CIVIS de São Paulo, hoje incluído — a janela que as
 * RPCs de métrica recebem como `p_date_from`/`p_date_to` (datas de negócio,
 * D-050).
 *
 * Existe porque seis telas montavam a janela com `toISOString().slice(0, 10)`,
 * que é o dia em UTC: depois das 21h de Brasília "hoje" já era amanhã, e a
 * janela de 30 dias andava um dia — contava um dia sem dado e perdia o mais
 * antigo (lote 1 do pente fino, 18/09). `/diagnostico` e `/faturamento` já
 * usavam o dia de negócio; agora todas usam a mesma função.
 */
export function lastBusinessDays(dias: number, agora: Date = new Date()): { from: string; to: string } {
  const to = toSalesMetricDate(agora);

  return { from: shiftBusinessDate(to, -(Math.max(dias, 1) - 1)), to };
}
