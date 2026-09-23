import type { Tom } from "../components/tone";
import type { DiaAds, ResumoAds } from "./ads";
import { participacao, type ResumoFaturamento } from "./faturamento";
import { formatBusinessDate, formatCurrency, formatPercent } from "./format";
import { avaliarVariacao, type Escala, type Polaridade, type Variacao } from "./variacao";

/**
 * Os indicadores da Central do negócio (D-394) e o resumo em texto.
 *
 * Todo número vem pronto de `get_faturamento` e `get_ads_overview` — as mesmas
 * RPCs de `/faturamento`, com as mesmas definições. Este módulo decide três
 * coisas, todas documentadas em `docs/METRICS.md` 5I:
 *
 * 1. **o que se compara** — comissão e custo sobem junto com a receita, então
 *    são comparados pela PARTICIPAÇÃO na receita, não pelo valor em reais;
 * 2. **quando a comparação vale** — resultado e margem só existem nos pedidos
 *    cobertos, e comparar 31% de cobertura com 95% compara amostras, não
 *    períodos; o Ads só compara período que o diário cobre inteiro;
 * 3. **o texto** — cada frase é montada a partir desses números, e só afirma
 *    o que eles sustentam. A decomposição da margem é EXATA: nos pedidos
 *    cobertos, margem = 1 − comissão − frete − custo (todos ÷ receita coberta),
 *    e a tela confere a identidade antes de atribuir qualquer ponto a alguém.
 */

export type Formato = "moeda" | "contagem" | "percentual" | "razao";

export type GrupoIndicador = "vendas" | "rentabilidade" | "ads";

export interface Comparado {
  readonly atual: number | null;
  readonly anterior: number | null;
  readonly formato: Formato;
  readonly escala: Escala;
  readonly polaridade: Polaridade;
  /** Quando o comparado não é o próprio valor: "da receita", "da receita coberta". */
  readonly rotulo: string | null;
}

export interface Indicador {
  readonly id: string;
  readonly grupo: GrupoIndicador;
  readonly metricId: string;
  readonly label: string;
  readonly formula: string;
  readonly valor: number | null;
  readonly formato: Formato;
  readonly comparado: Comparado;
  readonly variacao: Variacao | null;
  /** Por que não há comparação, quando não há. */
  readonly semComparacao: string | null;
  readonly ressalva: string | null;
}

export interface CoberturaAds {
  /** O diário tem linha do primeiro ao último dia do período. */
  readonly completa: boolean;
  /** Último dia com métrica, para a ressalva ("Ads até 21/09"). */
  readonly ate: string | null;
}

export interface EntradaCentral {
  readonly atual: ResumoFaturamento;
  /** `null` = o período anterior não carregou. Não é zero. */
  readonly anterior: ResumoFaturamento | null;
  readonly adsAtual: ResumoAds | null;
  readonly adsAnterior: ResumoAds | null;
  readonly coberturaAdsAtual: CoberturaAds;
  readonly coberturaAdsAnterior: CoberturaAds;
  readonly emAndamento: boolean;
}

/**
 * Abaixo disto uma razão de pedidos cobertos é ruído: com 8 pedidos, um frete
 * fora da curva move a margem inteira. Provisório como os limites do tom
 * (D-148), e declarado na tela quando corta a comparação.
 */
export const AMOSTRA_MINIMA = 20;

/** Diferença de cobertura acima da qual somas de pedidos cobertos deixam de ser comparáveis. */
export const COBERTURA_TOLERADA = 0.05;

/** O diário de Ads cobre `[from, to]` do primeiro ao último dia? */
export function coberturaDoAds(diario: readonly DiaAds[], from: string, to: string): CoberturaAds {
  if (diario.length === 0) return { completa: false, ate: null };

  // O diário vem ordenado por dia da RPC; min/max aqui não soma nada.
  const primeiro = diario[0]?.dia ?? null;
  const ultimo = diario[diario.length - 1]?.dia ?? null;

  return { completa: primeiro !== null && ultimo !== null && primeiro <= from && ultimo >= to, ate: ultimo };
}

function cobertura(r: ResumoFaturamento): number | null {
  return participacao(r.receita_coberta, r.receita_bruta);
}

function comparar(
  base: Omit<Indicador, "variacao" | "semComparacao">,
  semComparacao: string | null,
  semJulgamento: boolean,
): Indicador {
  const c = base.comparado;
  const variacao =
    semComparacao === null ? avaliarVariacao(c.atual, c.anterior, c.polaridade, c.escala, { semJulgamento }) : null;

  // Sem um dos lados, a comparação não existe — e a tela diz por quê, em vez de mostrar só "—".
  const motivo =
    semComparacao ?? (variacao === null ? (c.atual === null ? "sem valor no período" : "sem valor no período anterior") : null);

  return { ...base, variacao, semComparacao: motivo };
}

function motivoDaAmostra(atual: number, anterior: number): string | null {
  if (atual >= AMOSTRA_MINIMA && anterior >= AMOSTRA_MINIMA) return null;

  return `menos de ${String(AMOSTRA_MINIMA)} pedidos cobertos em um dos períodos (${String(atual)} × ${String(anterior)})`;
}

const ANDAMENTO = "dia em andamento: o volume ainda cresce e não é julgado";

export function montarIndicadores(e: EntradaCentral): Indicador[] {
  const a = e.atual;
  const p = e.anterior;
  const semAnterior = p === null ? "o período anterior não carregou" : null;
  const volume = e.emAndamento;

  const amostraCoberta = p === null ? semAnterior : motivoDaAmostra(a.pedidos_cobertos, p.pedidos_cobertos);
  const amostraFrete = p === null ? semAnterior : motivoDaAmostra(a.pedidos_com_custos, p.pedidos_com_custos);

  // Somas de pedidos cobertos (o resultado em reais) só se comparam com
  // coberturas parecidas: 31% contra 95% da receita mediria a captura do
  // frete, não o negócio.
  let coberturaDiferente: string | null = null;

  if (p !== null) {
    const ca = cobertura(a);
    const cp = cobertura(p);

    if (ca === null || cp === null || Math.abs(ca - cp) > COBERTURA_TOLERADA) {
      coberturaDiferente = `cobertura diferente entre os períodos (${formatPercent(ca)} × ${formatPercent(cp)} da receita)`;
    }
  }

  const ads = e.adsAtual;
  const adsP = e.adsAnterior;
  const semAds =
    ads === null
      ? "Ads indisponível"
      : adsP === null
        ? "Ads do período anterior indisponível"
        : !e.coberturaAdsAtual.completa
          ? e.coberturaAdsAtual.ate === null
            ? "sem métrica de Ads no período"
            : `Ads só até ${formatBusinessDate(e.coberturaAdsAtual.ate)} — o Mercado Livre fecha o dia às 10h do dia seguinte`
          : !e.coberturaAdsAnterior.completa
            ? "o período anterior não tem Ads de todos os dias"
            : null;

  const valor = (
    atual: number | null,
    anterior: number | null,
    formato: Formato,
    polaridade: Polaridade,
  ): Comparado => ({ atual, anterior, formato, escala: "valor", polaridade, rotulo: null });

  const fracao = (
    atual: number | null,
    anterior: number | null,
    polaridade: Polaridade,
    rotulo: string | null = null,
  ): Comparado => ({ atual, anterior, formato: "percentual", escala: "fracao", polaridade, rotulo });

  return [
    comparar(
      {
        id: "receita",
        grupo: "vendas",
        metricId: "receita_bruta",
        label: "Faturamento",
        formula: "SUM(quantidade × preço unitário) dos pedidos pagos ou parcialmente reembolsados",
        valor: a.receita_bruta,
        formato: "moeda",
        comparado: valor(a.receita_bruta, p?.receita_bruta ?? null, "moeda", "maior-melhor"),
        ressalva: volume ? ANDAMENTO : null,
      },
      semAnterior,
      volume,
    ),
    comparar(
      {
        id: "pedidos",
        grupo: "vendas",
        metricId: "pedidos",
        label: "Pedidos",
        formula: "COUNT(DISTINCT pedido) das vendas válidas",
        valor: a.pedidos,
        formato: "contagem",
        comparado: valor(a.pedidos, p?.pedidos ?? null, "contagem", "maior-melhor"),
        ressalva: null,
      },
      semAnterior,
      volume,
    ),
    comparar(
      {
        id: "ticket",
        grupo: "vendas",
        metricId: "ticket_medio",
        label: "Ticket médio",
        formula: "receita_bruta ÷ compras (pack, com o pedido como reserva)",
        valor: a.ticket_medio,
        formato: "moeda",
        comparado: valor(a.ticket_medio, p?.ticket_medio ?? null, "moeda", "maior-melhor"),
        ressalva: null,
      },
      semAnterior,
      false,
    ),
    comparar(
      {
        id: "unidades",
        grupo: "vendas",
        metricId: "unidades_vendidas",
        label: "Unidades vendidas",
        formula: "SUM(order_items.quantity) das vendas válidas",
        valor: a.unidades,
        formato: "contagem",
        comparado: valor(a.unidades, p?.unidades ?? null, "contagem", "maior-melhor"),
        ressalva: null,
      },
      semAnterior,
      volume,
    ),
    comparar(
      {
        id: "resultado",
        grupo: "rentabilidade",
        metricId: "resultado_venda",
        label: "Resultado da venda",
        formula: "receita − comissão − frete do vendedor − custo dos produtos, sobre pedidos cobertos",
        valor: a.resultado_venda,
        formato: "moeda",
        comparado: valor(a.resultado_venda, p?.resultado_venda ?? null, "moeda", "maior-melhor"),
        ressalva:
          a.pedidos_cobertos === 0
            ? "nenhum pedido coberto no período"
            : `sobre ${formatPercent(cobertura(a))} da receita · antes de imposto e Ads`,
      },
      amostraCoberta ?? coberturaDiferente,
      volume,
    ),
    comparar(
      {
        id: "margem",
        grupo: "rentabilidade",
        metricId: "margem_venda",
        label: "Margem sobre a venda",
        formula: "resultado_venda ÷ receita dos mesmos pedidos cobertos",
        valor: a.margem_venda,
        formato: "percentual",
        comparado: fracao(a.margem_venda, p?.margem_venda ?? null, "maior-melhor"),
        ressalva: "não é lucro líquido: imposto e Ads ficam fora",
      },
      amostraCoberta,
      false,
    ),
    comparar(
      {
        id: "custo",
        grupo: "rentabilidade",
        metricId: "custo_produtos_vendidos",
        label: "Custo dos produtos",
        formula: "SUM(quantidade × custo na data da venda), sobre pedidos cobertos; comparado pela participação na receita coberta",
        valor: a.custo_produtos,
        formato: "moeda",
        comparado: fracao(
          participacao(a.custo_produtos, a.receita_coberta),
          p === null ? null : participacao(p.custo_produtos, p.receita_coberta),
          "menor-melhor",
          "da receita coberta",
        ),
        ressalva: null,
      },
      amostraCoberta,
      false,
    ),
    comparar(
      {
        id: "comissao",
        grupo: "rentabilidade",
        metricId: "taxas_ml",
        label: "Comissão do Mercado Livre",
        formula: "SUM(order_items.sale_fee × quantity); comparada pela participação na receita (comissao_percentual)",
        valor: a.taxas_ml,
        formato: "moeda",
        comparado: fracao(a.comissao_percentual, p?.comissao_percentual ?? null, "menor-melhor", "da receita"),
        ressalva: "sem taxa fixa, parcelamento nem imposto",
      },
      semAnterior,
      false,
    ),
    comparar(
      {
        id: "frete",
        grupo: "rentabilidade",
        metricId: "frete_medio_pedido",
        label: "Frete médio por pedido",
        formula: "frete_vendedor ÷ pedidos com frete observado",
        valor: a.frete_medio_pedido,
        formato: "moeda",
        comparado: valor(a.frete_medio_pedido, p?.frete_medio_pedido ?? null, "moeda", "menor-melhor"),
        ressalva: "frete gravado desde 14/09/2026, um dia depois da venda",
      },
      amostraFrete,
      false,
    ),
    comparar(
      {
        id: "investimento",
        grupo: "ads",
        metricId: "investimento_ads",
        label: "Investimento em Ads",
        formula: "SUM(daily_ads_campaign_metrics.cost) — Product Ads",
        valor: ads?.investimento ?? null,
        formato: "moeda",
        // Gastar mais não é bom nem ruim por si: quem julga é ROAS e TACoS.
        comparado: valor(ads?.investimento ?? null, adsP?.investimento ?? null, "moeda", "neutra"),
        ressalva: null,
      },
      semAds,
      false,
    ),
    comparar(
      {
        id: "receita_ads",
        grupo: "ads",
        metricId: "receita_ads",
        label: "Vendas com Ads",
        formula: "SUM(total_amount) atribuído pelo Mercado Livre (diretas + indiretas)",
        valor: ads?.receita_ads ?? null,
        formato: "moeda",
        comparado: valor(ads?.receita_ads ?? null, adsP?.receita_ads ?? null, "moeda", "maior-melhor"),
        ressalva: "atribuição do Mercado Livre",
      },
      semAds,
      false,
    ),
    comparar(
      {
        id: "roas",
        grupo: "ads",
        metricId: "roas",
        label: "ROAS",
        formula: "receita_ads ÷ investimento_ads",
        valor: ads?.roas ?? null,
        formato: "razao",
        comparado: valor(ads?.roas ?? null, adsP?.roas ?? null, "razao", "maior-melhor"),
        ressalva: "venda sobre investimento, não lucro",
      },
      semAds,
      false,
    ),
    comparar(
      {
        id: "acos",
        grupo: "ads",
        metricId: "acos",
        label: "ACOS",
        formula: "investimento_ads ÷ receita_ads",
        valor: ads?.acos ?? null,
        formato: "percentual",
        comparado: fracao(ads?.acos ?? null, adsP?.acos ?? null, "menor-melhor"),
        ressalva: null,
      },
      semAds,
      false,
    ),
    comparar(
      {
        id: "tacos",
        grupo: "ads",
        metricId: "tacos",
        label: "TACoS",
        formula: "investimento_ads ÷ receita_bruta das mesmas contas e dias",
        valor: ads?.tacos ?? null,
        formato: "percentual",
        comparado: fracao(ads?.tacos ?? null, adsP?.tacos ?? null, "menor-melhor"),
        ressalva: "todo o Ads contra todo o faturamento",
      },
      semAds,
      false,
    ),
  ];
}

// ─── O resumo em texto ────────────────────────────────────────────────────

export interface Sinal {
  readonly tom: Tom;
  readonly texto: string;
  readonly indicador: string;
}

export interface ResumoCentral {
  readonly frases: readonly string[];
  /** Indicadores que pioraram além da zona neutra, do mais grave ao menos. */
  readonly atencao: readonly Sinal[];
  /** Indicadores que melhoraram além da zona neutra. */
  readonly melhoras: readonly Sinal[];
}

const PONTOS = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

function pontos(fracao: number): string {
  return `${PONTOS.format(Math.abs(fracao) * 100)} p.p.`;
}

const ROAS = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** O mesmo formato de `/faturamento` (`campanhas-ads.tsx`): "4,20x". */
export function formatRoas(roas: number | null): string {
  return roas === null ? "—" : `${ROAS.format(roas)}x`;
}

function porcento(relativa: number): string {
  return formatPercent(Math.abs(relativa));
}

function porId(indicadores: readonly Indicador[], id: string): Indicador | undefined {
  return indicadores.find((i) => i.id === id);
}

/**
 * "alta de 12,8%", "queda de 3,2%" ou "estável". Sem relativa (anterior zero
 * ou negativo) o movimento existe mas não tem porcentagem honesta: diz-se a
 * direção e o porquê, nunca "estável" para quem saiu do zero.
 */
function movimento(v: Variacao): string {
  if (v.relativa === null) {
    if (v.diferenca === 0) return "estável";

    return `${v.direcao === "sobe" ? "alta" : "queda"} sobre um período anterior ${v.anterior === 0 ? "zerado" : "negativo"}`;
  }

  if (!v.relevante) return "estável";

  return `${v.direcao === "sobe" ? "alta" : "queda"} de ${porcento(v.relativa)}`;
}

interface Parcela {
  readonly nome: string;
  /** Contribuição para a variação da margem, em fração: negativa tirou margem. */
  readonly efeito: number;
}

/**
 * A variação da margem repartida entre comissão, frete e custo — exata, não
 * estimada: nos pedidos cobertos, margem = 1 − Σ participações. Se a identidade
 * não fechar nos dois períodos (arredondamento do SQL além de 0,1 p.p., ou um
 * campo nulo), não se atribui nada a ninguém.
 */
export function decomporMargem(atual: ResumoFaturamento, anterior: ResumoFaturamento): Parcela[] | null {
  const partes = (r: ResumoFaturamento): [number, number, number] | null => {
    const receita = r.receita_coberta;

    if (
      receita === null ||
      receita <= 0 ||
      r.taxas_ml_cobertas === null ||
      r.frete_vendedor_coberto === null ||
      r.custo_produtos === null ||
      r.margem_venda === null
    ) {
      return null;
    }

    const cotas: [number, number, number] = [
      r.taxas_ml_cobertas / receita,
      r.frete_vendedor_coberto / receita,
      r.custo_produtos / receita,
    ];

    return Math.abs(1 - cotas[0] - cotas[1] - cotas[2] - r.margem_venda) <= 0.001 ? cotas : null;
  };

  const a = partes(atual);
  const p = partes(anterior);

  if (a === null || p === null) return null;

  return [
    { nome: "comissão", efeito: -(a[0] - p[0]) },
    { nome: "frete", efeito: -(a[1] - p[1]) },
    { nome: "custo dos produtos", efeito: -(a[2] - p[2]) },
  ];
}

const ABERTURA: Readonly<Record<string, string>> = {
  hoje: "Hoje",
  ontem: "Ontem",
  "7d": "Nos últimos 7 dias",
  "15d": "Nos últimos 15 dias",
  "30d": "Nos últimos 30 dias",
  mes: "No mês atual",
  "mes-anterior": "No mês anterior",
};

/** "Frete médio por pedido: alta de 18,0%", "Margem sobre a venda: queda de 2,1 p.p." */
function sinalDe(i: Indicador): Sinal | null {
  const v = i.variacao;

  if (v === null || !v.relevante || v.tom === "neutro") return null;

  const sentido = v.direcao === "sobe" ? "alta" : "queda";
  const quanto = i.comparado.escala === "fracao" ? pontos(v.diferenca) : v.relativa === null ? null : porcento(v.relativa);
  const rotulo = i.comparado.rotulo === null ? "" : ` (participação ${i.comparado.rotulo})`;

  return { tom: v.tom, texto: `${i.label}${rotulo}: ${sentido}${quanto === null ? "" : ` de ${quanto}`}`, indicador: i.id };
}

function gravidade(i: Indicador): number {
  const v = i.variacao;

  if (v === null) return 0;

  return i.comparado.escala === "fracao" ? Math.abs(v.diferenca) * 5 : Math.abs(v.relativa ?? 0);
}

export function montarResumo(
  indicadores: readonly Indicador[],
  e: EntradaCentral,
  preset: string | null,
): ResumoCentral {
  const frases: string[] = [];
  const abertura = ABERTURA[preset ?? ""] ?? "No período";

  // 1. Faturamento.
  const receita = porId(indicadores, "receita");

  if (receita !== undefined) {
    const v = receita.variacao;

    if (e.emAndamento) {
      frases.push(
        v === null
          ? `${abertura}, com o dia em andamento, o faturamento soma ${formatCurrency(receita.valor)}.`
          : `${abertura}, com o dia em andamento, o faturamento soma ${formatCurrency(receita.valor)}; o período de comparação inteiro teve ${formatCurrency(v.anterior)}.`,
      );
    } else if (v === null) {
      frases.push(`${abertura}, o faturamento foi de ${formatCurrency(receita.valor)}.`);
    } else {
      const mov = movimento(v);

      const complemento =
        mov === "estável" ? "estável em relação ao período anterior" : v.relativa === null ? mov : `${mov} sobre o período anterior`;

      frases.push(`${abertura}, o faturamento foi de ${formatCurrency(receita.valor)}, ${complemento}.`);
    }
  }

  // 2. Resultado, quando comparável — e o contraste com o faturamento, que é o
  // que a tela existe para mostrar: vender mais e ganhar menos.
  const resultado = porId(indicadores, "resultado");
  const vr = resultado?.variacao ?? null;
  const vf = receita?.variacao ?? null;

  if (!e.emAndamento && vr !== null && vr.relativa !== null) {
    const contraste =
      vf !== null && vf.relevante && vf.direcao === "sobe" && vr.relevante && vr.direcao === "desce"
        ? ", mesmo com o faturamento em alta"
        : vf !== null && vf.relevante && vf.direcao === "sobe" && vf.relativa !== null && vr.relativa < vf.relativa - COBERTURA_TOLERADA
          ? `, menos que o faturamento`
          : "";

    const mov = movimento(vr);

    frases.push(`O resultado da venda ${mov === "estável" ? "ficou estável" : `teve ${mov}`}${contraste}.`);
  }

  // 3. Margem, com a decomposição exata quando ela fecha.
  const margem = porId(indicadores, "margem");

  if (margem !== undefined) {
    const v = margem.variacao;

    if (margem.valor === null) {
      frases.push("Sem margem no período: nenhum pedido tem frete e custo observados ao mesmo tempo.");
    } else if (v === null) {
      frases.push(`A margem sobre a venda foi de ${formatPercent(margem.valor)}, sem base de comparação (${margem.semComparacao ?? "sem período anterior"}).`);
    } else if (!v.relevante) {
      frases.push(`A margem sobre a venda ficou estável em ${formatPercent(margem.valor)}.`);
    } else {
      const caiu = v.direcao === "desce";
      let frase = `A margem sobre a venda ${caiu ? "caiu" : "subiu"} de ${formatPercent(v.anterior)} para ${formatPercent(margem.valor)}.`;
      const parcelas = e.anterior === null ? null : decomporMargem(e.atual, e.anterior);

      if (parcelas !== null) {
        // As parcelas a favor e contra somam a variação inteira: dizer só as que
        // pesaram faria "frete −0,7 p.p." parecer maior que a queda de 0,5.
        const lista = (sinal: 1 | -1): string[] =>
          parcelas
            .filter((pc) => pc.efeito * sinal >= 0.001)
            .sort((x, y) => Math.abs(y.efeito) - Math.abs(x.efeito))
            .map((pc) => `${pc.nome} (${sinal > 0 ? "+" : "−"}${pontos(pc.efeito)})`);
        const principal = lista(caiu ? -1 : 1);
        const contrario = lista(caiu ? 1 : -1);

        const verbo = caiu ? (principal.length === 1 ? "Pesou" : "Pesaram") : principal.length === 1 ? "Ajudou" : "Ajudaram";

        if (principal.length > 0) frase += ` ${verbo}: ${principal.join(", ")}.`;
        if (principal.length > 0 && contrario.length > 0) {
          frase += ` ${contrario.length === 1 ? "Compensou" : "Compensaram"} em parte: ${contrario.join(", ")}.`;
        }
      }

      frases.push(frase);
    }
  }

  // 4. Ads.
  const investimento = porId(indicadores, "investimento");
  const roas = porId(indicadores, "roas");
  const tacos = porId(indicadores, "tacos");

  if (investimento !== undefined && e.adsAtual !== null) {
    if (e.adsAtual.investimento === 0 && e.adsAtual.campanhas_com_metrica === 0) {
      frases.push("Nenhum investimento em Ads registrado no período.");
    } else if (investimento.variacao === null) {
      frases.push(
        `No Mercado Ads, ${formatCurrency(investimento.valor)} investidos com ROAS de ${formatRoas(roas?.valor ?? null)} — ${investimento.semComparacao ?? "sem comparação"}.`,
      );
    } else {
      const rv = roas?.variacao ?? null;
      const mov = movimento(investimento.variacao);
      let frase = `No Mercado Ads, o investimento ${mov === "estável" ? "ficou estável" : `teve ${mov}`}`;

      if (rv !== null && roas !== undefined && roas.valor !== null) {
        frase += ` e o ROAS foi de ${formatRoas(rv.anterior)} para ${formatRoas(roas.valor)}`;
      }

      frase += ".";

      const tv = tacos?.variacao ?? null;

      if (tv !== null && tv.relevante && tacos !== undefined && tacos.valor !== null) {
        frase += ` O Ads passou de ${formatPercent(tv.anterior)} para ${formatPercent(tacos.valor)} do faturamento.`;
      }

      frases.push(frase);
    }
  }

  const sinais = indicadores
    .slice()
    .sort((x, y) => gravidade(y) - gravidade(x))
    .map(sinalDe)
    .filter((s): s is Sinal => s !== null);

  const ordem: Record<Tom, number> = { perigo: 0, atencao: 1, ok: 2, info: 3, neutro: 4 };

  return {
    frases,
    atencao: sinais.filter((s) => s.tom === "perigo" || s.tom === "atencao").sort((x, y) => ordem[x.tom] - ordem[y.tom]),
    melhoras: sinais.filter((s) => s.tom === "ok"),
  };
}
