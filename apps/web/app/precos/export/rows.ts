/**
 * O que aparece em cada linha da planilha de `/precos` (D-292).
 *
 * Função PURA, como `app/compras/[id]/export/rows.ts`: decidir o conteúdo sem
 * `exceljs` por perto é o que torna a decisão testável — e aqui há decisões de
 * verdade, não formatação. As três que importam:
 *
 *  1. **o que a tela mostra como link vira TEXTO** — SKU e MLB são identidade,
 *     e uma planilha sem eles não se cruza com nada;
 *  2. **ausência continua nomeada** (D-067): anúncio que saiu do catálogo não
 *     vira título vazio, e `delta_ratio` nulo (preço anterior zero) não vira
 *     0% — os dois recebem o mesmo travessão que a tela usa;
 *  3. **número sai como NÚMERO**, não como texto formatado: quem exporta vai
 *     somar, filtrar e ordenar na planilha. Formatação é do `numFmt`, não do
 *     valor. Foi por isso que a linha da direção virou coluna própria em vez
 *     de um sinal grudado no valor.
 */

export interface PriceChangeExportInput {
  occurred_at: string;
  title: string | null;
  sku: string | null;
  item_id: string;
  status: string | null;
  account_label: string;
  price_before: number;
  price_after: number;
  delta: number;
  delta_ratio: number | null;
}

export interface PriceExportRow {
  occurredAt: string;
  title: string;
  sku: string;
  itemId: string;
  status: string;
  account: string;
  priceBefore: number;
  priceAfter: number;
  delta: number;
  /** Fração (0,15 = 15%), não porcentagem: o `numFmt` da planilha é quem
   *  multiplica. `null` quando o preço anterior era zero. */
  deltaRatio: number | null;
  direction: "AUMENTO" | "REDUÇÃO";
}

/** O mesmo travessão que a tela usa para ausência — nunca string vazia. */
const AUSENTE = "—";

export function buildPriceExportRows(
  rows: readonly PriceChangeExportInput[],
  statusLabel: (code: string) => string,
): PriceExportRow[] {
  return rows.map((row) => ({
    occurredAt: row.occurred_at,
    title: row.title ?? "anúncio fora do catálogo",
    sku: row.sku ?? "sem vínculo",
    itemId: row.item_id,
    status: row.status === null ? AUSENTE : statusLabel(row.status),
    account: row.account_label,
    priceBefore: row.price_before,
    priceAfter: row.price_after,
    delta: row.delta,
    deltaRatio: row.delta_ratio,
    // A MESMA regra da coluna "Direção" da tela: o sinal do delta, e nada
    // mais. Empate não existe — a RPC só emite evento quando o preço mudou.
    direction: row.delta > 0 ? "AUMENTO" : "REDUÇÃO",
  }));
}

/**
 * A frase que descreve o RECORTE dentro da planilha.
 *
 * Ela existe porque o arquivo sai do navegador e vive sozinho depois: sem o
 * recorte escrito, "precos.xlsx" na pasta de Downloads é um monte de linhas
 * sem contexto, e quem abrir daqui a um mês não tem como saber se aquilo é a
 * operação inteira ou uma conta só. É a mesma exigência que a tela cumpre com
 * a janela declarada.
 */
export function describePriceExportFilters(input: {
  dayFrom: string;
  dayTo: string | null;
  accountLabel: string | null;
  direction: string | null;
  search: string | null;
  formatDay: (day: string) => string;
  directionLabel: (code: string) => string;
}): string {
  const partes: string[] = [
    input.dayTo === null
      ? `De ${input.formatDay(input.dayFrom)} até hoje`
      : `De ${input.formatDay(input.dayFrom)} a ${input.formatDay(input.dayTo)}`,
    input.accountLabel === null ? "Todas as contas" : `Conta: ${input.accountLabel}`,
  ];

  if (input.direction !== null) partes.push(`Só ${input.directionLabel(input.direction).toLowerCase()}`);
  if (input.search !== null) partes.push(`Busca: "${input.search}"`);

  return partes.join(" · ");
}

/**
 * O INSTANTE COMO A PLANILHA PRECISA DELE — e este é um defeito que a
 * inspeção do arquivo gerado pegou (D-292).
 *
 * O XLSX não guarda fuso: uma célula de data é um relógio de parede. Escrever
 * `new Date(occurredAt)` faz o Excel mostrar a hora **UTC**, e a mesma
 * alteração aparecia como 17:52 na tela e **20:52 na planilha** — três horas
 * de diferença entre dois lugares que dizem a mesma coisa, que é pior do que
 * não exportar.
 *
 * A conversão é explícita: os componentes do relógio de `America/Sao_Paulo`
 * (o fuso canônico da casa, travado por CHECK em `metric_definitions` desde a
 * Fase 0) são montados como se fossem UTC, porque é assim que o Excel os lê de
 * volta. E a coluna diz o fuso no título, para ninguém precisar deduzir.
 */
const PARTES_SP = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Sao_Paulo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

export function toSpreadsheetInstant(iso: string): Date {
  const partes = new Map(PARTES_SP.formatToParts(new Date(iso)).map((p) => [p.type, p.value]));

  const numero = (tipo: Intl.DateTimeFormatPartTypes): number => Number(partes.get(tipo) ?? "0");

  // `hour` pode vir "24" em algumas plataformas para meia-noite; `Date.UTC`
  // normaliza isso para o dia seguinte às 00h, que é a leitura correta.
  return new Date(
    Date.UTC(numero("year"), numero("month") - 1, numero("day"), numero("hour"), numero("minute"), numero("second")),
  );
}
