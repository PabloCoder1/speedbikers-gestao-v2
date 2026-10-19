/**
 * O CSV de `/vendas` no "Todos" e na "Shopee" (D-496): as duas tabelas que a
 * tela mostra, no recorte dela, sobre o MESMO contrato (C-53).
 *
 * - **Por dia** (`get_marketplace_sales_daily`): a série do gráfico, um dia por
 *   marketplace e, no "Todos", o total do dia. Só dias com venda, como o banco
 *   devolve — dia sem linha não é preenchido com zero aqui.
 * - **Por conta** (`get_marketplace_sales_summary`): a tabela "Por marketplace e
 *   conta", na ordem dela (o total, e cada marketplace com as contas abaixo).
 *
 * Mesmo formato (`lib/csv.ts`: `;`, vírgula decimal, BOM, CRLF e a defesa contra
 * fórmula) e as palavras da tela: a loja de teste "fora das somas", a loja
 * nunca lida "pedidos ainda não lidos". Ausência é célula vazia, nunca zero
 * (D-067). **Nada é somado aqui:** cada número, o total inclusive, veio do SQL.
 */

import { csvCell, csvDocument, csvNumber } from "./csv";
import { formatBusinessDate, formatDateTime } from "./format";
import { agruparLinhas, type CodigoMarketplace, type DiaDeVendas, type EscopoMulticanal, type LinhaDeVendas } from "./vendas-multicanal";

const NOME_DO_MARKETPLACE: Readonly<Record<CodigoMarketplace, string>> = { ML: "Mercado Livre", SHOPEE: "Shopee" };

/** A linha do total chama-se como o recorte "Todos" da tela. */
const TOTAL = "Todos os marketplaces";

const CABECALHO_DIAS = ["Dia", "Marketplace", "Receita bruta", "Pedidos sem receita conhecida", "Compras", "Unidades"];

/**
 * Ordem do dia: Mercado Livre, Shopee e, por último, o total dele. O total só
 * vai no "Todos": no recorte de um marketplace ele repete a linha desse
 * marketplace.
 */
const ORDEM_NO_DIA: Readonly<Record<string, number>> = { ML: 0, SHOPEE: 1, TOTAL: 2 };

export function diasParaCsv(dias: readonly DiaDeVendas[], escopo: EscopoMulticanal): string {
  const linhas = dias
    .filter((dia) => escopo === "todos" || dia.marketplace !== null)
    .sort(
      (a, b) =>
        a.dia.localeCompare(b.dia) || (ORDEM_NO_DIA[a.marketplace ?? "TOTAL"] ?? 3) - (ORDEM_NO_DIA[b.marketplace ?? "TOTAL"] ?? 3),
    )
    .map((dia) => [
      csvCell(formatBusinessDate(dia.dia)),
      csvCell(dia.marketplace === null ? TOTAL : NOME_DO_MARKETPLACE[dia.marketplace]),
      csvNumber(dia.receita_bruta),
      csvNumber(dia.pedidos_sem_receita),
      csvNumber(dia.compras),
      csvNumber(dia.unidades),
    ]);

  return csvDocument(CABECALHO_DIAS, linhas);
}

const CABECALHO_CONTAS = [
  "Linha",
  "Marketplace",
  "Conta ou loja",
  "Ambiente",
  "Receita bruta",
  "Pedidos sem receita conhecida",
  "Compras",
  "Unidades",
  "Ticket médio",
  "Pedidos do ML",
  "Recebido (Shopee)",
  "Aguardando o financeiro",
  "Atualizado até",
  "Observação",
];

/** O que a tela escreve ao lado do nome da linha, na mesma palavra. */
function observacao(linha: LinhaDeVendas): string {
  if (linha.environment !== null && linha.environment !== "live") return "Teste — fora das somas";
  if (linha.nivel === "CONTA" && linha.compras === null) return "pedidos ainda não lidos";

  return "";
}

function celulasDaLinha(rotulo: string, linha: LinhaDeVendas): string[] {
  const ambiente = linha.environment === null ? "" : linha.environment === "live" ? "Real" : "Teste";

  return [
    csvCell(rotulo),
    csvCell(linha.marketplace === null ? TOTAL : NOME_DO_MARKETPLACE[linha.marketplace]),
    csvCell(linha.nivel === "CONTA" ? (linha.account_name ?? "") : ""),
    csvCell(ambiente),
    csvNumber(linha.receita_bruta),
    csvNumber(linha.pedidos_sem_receita),
    csvNumber(linha.compras),
    csvNumber(linha.unidades),
    csvNumber(linha.ticket_medio),
    csvNumber(linha.pedidos_ml),
    csvNumber(linha.recebido),
    csvNumber(linha.pedidos_sem_recebido),
    csvCell(linha.ultima_atualizacao === null ? "" : formatDateTime(linha.ultima_atualizacao)),
    csvCell(observacao(linha)),
  ];
}

export function contasParaCsv(linhas: readonly LinhaDeVendas[], escopo: EscopoMulticanal): string {
  const { total, grupos } = agruparLinhas(linhas);
  const corpo: string[][] = [];

  // O total só no "Todos": no recorte de um marketplace ele repete a soma dele.
  if (escopo === "todos" && total !== null) corpo.push(celulasDaLinha("Total", total));

  for (const grupo of grupos) {
    // Sem soma (só loja de teste, ou nunca lida), a linha fica e diz por quê, como na tela.
    corpo.push(
      grupo.soma === null
        ? [
            csvCell("Soma do marketplace"),
            csvCell(NOME_DO_MARKETPLACE[grupo.marketplace]),
            ...Array.from({ length: CABECALHO_CONTAS.length - 3 }, () => ""),
            csvCell("nada somável: só loja de teste ou ainda não lida"),
          ]
        : celulasDaLinha("Soma do marketplace", grupo.soma),
    );
    for (const conta of grupo.contas) corpo.push(celulasDaLinha("Conta ou loja", conta));
  }

  return csvDocument(CABECALHO_CONTAS, corpo);
}

/**
 * O endereço do CSV a partir do endereço da TELA (`hrefDeVendas` do recorte
 * atual): o mesmo marketplace, período e contas, trocando só o caminho e
 * dizendo a tabela. Assim o arquivo nunca tem um recorte diferente do que se vê.
 */
export function hrefDaExportacao(hrefDaTela: string, tabela: "dia" | "conta"): string {
  const url = new URL(hrefDaTela, "http://tela.local");

  url.searchParams.set("tabela", tabela);

  return `/vendas/exportar?${url.searchParams.toString()}`;
}

/** Um dia de `get_sales_daily_series`, a série da `/vendas` do Mercado Livre. */
export interface DiaDoMl {
  readonly metric_date: string;
  readonly gross_revenue: number;
  readonly orders_count: number;
  /** Nulo sob o recorte de marca (D-237): o pack não tem marca única. */
  readonly purchases_count: number | null;
  readonly units_sold: number;
}

/** As palavras das métricas da tela do ML (`lib/sales-metric.ts`). */
const CABECALHO_DO_ML = ["Dia", "Faturamento (receita bruta)", "Pedidos", "Compras (packs)", "Unidades"];

/**
 * O CSV do recorte do Mercado Livre (D-602): a série do gráfico, um dia por
 * linha, no recorte da tela -- conta, marca e período. Só os dias com métrica
 * calculada, como a tela diz ("só N dias têm métrica calculada"); compras sob o
 * recorte de marca é célula vazia, nunca zero.
 */
export function diasDoMlParaCsv(dias: readonly DiaDoMl[]): string {
  const linhas = [...dias]
    .sort((a, b) => a.metric_date.localeCompare(b.metric_date))
    .map((dia) => [
      csvCell(formatBusinessDate(dia.metric_date)),
      csvNumber(dia.gross_revenue),
      csvNumber(dia.orders_count),
      csvNumber(dia.purchases_count),
      csvNumber(dia.units_sold),
    ]);

  return csvDocument(CABECALHO_DO_ML, linhas);
}
