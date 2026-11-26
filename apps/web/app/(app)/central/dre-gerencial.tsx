import Link from "next/link";
import type { ReactNode } from "react";
import {
  ROTULO_REGIME_TRIBUTARIO,
  calcularTributosEntidade,
  montarDreGerencial,
  type LinhaDre,
  type OrigemDadoFinanceiro,
} from "@sb/domain";

import { Glossario } from "../../../components/ajuda";
import { KpiStrip, type KpiCellData } from "../../../components/kpi-strip";
import { Panel } from "../../../components/panel";
import { StatePill } from "../../../components/state-pill";
import type { Tom } from "../../../components/tone";
import type { EntradaCentral } from "../../../lib/central-indicadores";
import { CONTEXTO_FISCAL_VAZIO, formatarCnpj, type ContextoFiscalDre } from "../../../lib/custos-fiscal";
import { formatCurrency, formatPercent } from "../../../lib/format";
import { ExportarDreCsv } from "./exportar-dre";
import { SimuladorFinanceiro } from "./simulador-financeiro";

const ORIGEM_LABEL: Readonly<Record<OrigemDadoFinanceiro, { readonly rotulo: string; readonly tom: Tom }>> = {
  real: { rotulo: "real", tom: "ok" },
  estimado: { rotulo: "estimado", tom: "atencao" },
  manual: { rotulo: "manual", tom: "info" },
  calculado: { rotulo: "calculado", tom: "neutro" },
  ausente: { rotulo: "sem dado", tom: "neutro" },
};

export const GLOSSARIO_FINANCEIRO = [
  {
    termo: "Margem do Produto (%)",
    definicao:
      "Fórmula oficial da empresa: (Valor Líquido Recebido − Custo do Produto) × 100 ÷ Valor de Venda. Consolidada sempre pela soma monetária ponderada pelo faturamento, nunca pela média simples das margens individuais.",
  },
  {
    termo: "CMV (Custo das Mercadorias Vendidas)",
    definicao:
      "Soma do custo histórico de aquisição dos produtos vendidos no período (em kits, soma dos componentes × quantidade). Custo desconhecido nunca vira zero silenciosamente.",
  },
  {
    termo: "Margem de Contribuição",
    definicao:
      "Quanto sobra de cada venda após pagar impostos sobre vendas, CMV, comissões, frete do vendedor, despesas variáveis e publicidade (Ads). É o dinheiro que paga as despesas fixas da empresa e forma o lucro.",
  },
  {
    termo: "Resultado Operacional e Margem Líquida",
    definicao:
      "Resultado Operacional = Margem de Contribuição − Despesas Fixas. Margem Líquida Final = Resultado Líquido Gerencial ÷ Faturamento Bruto. Não substitui a Margem do Produto.",
  },
  {
    termo: "Ponto de Equilíbrio",
    definicao:
      "Faturamento mínimo necessário para cobrir integralmente as despesas fixas (Despesas Fixas ÷ Margem de Contribuição %). Se a margem de contribuição for nula ou negativa, não há ponto de equilíbrio alcançável nas condições atuais.",
  },
  {
    termo: "Alíquota Efetiva",
    definicao:
      "Percentual real de tributos sobre o faturamento no regime da empresa (ex.: DAS efetivo no Simples Nacional ou débitos menos créditos no Lucro Real). Estimativa gerencial — não substitui a apuração contábil oficial.",
  },
  {
    termo: "ROAS, ACOS e TACoS",
    definicao:
      "ROAS = Vendas com Ads ÷ Investimento (retorno bruto, não lucro). ACOS = Investimento ÷ Vendas com Ads (inverso do ROAS). TACoS = Investimento ÷ Faturamento Total da operação.",
  },
  {
    termo: "Variação Percentual (%) vs. Pontos Percentuais (p.p.)",
    definicao:
      "São medidas diferentes. Se uma margem sobe de 20% para 25%, houve aumento de 5 pontos percentuais (p.p.) e crescimento relativo de 25% ((25 − 20) ÷ 20).",
  },
  {
    termo: "Regime de Competência vs. Regime de Caixa",
    definicao:
      "Competência registra a venda e a despesa na data do fato gerador (quando ocorreu). Caixa registra na data efetiva do recebimento ou pagamento. Lucro gerencial não é saldo em caixa.",
  },
  {
    termo: "Rateio de Despesas",
    definicao:
      "Critério para distribuir despesas compartilhadas (aluguel, energia, salários, softwares) entre contas ou marketplaces — por faturamento, volume, percentual fixo ou manual — distinguindo sempre despesas diretas de rateadas.",
  },
] as const;

function barraLargura(linha: LinhaDre): string {
  if (linha.percentualSobreBruto === null) return "0%";
  const pct = Math.min(100, Math.max(0, Math.abs(linha.percentualSobreBruto) * 100));
  return `${pct.toFixed(1)}%`;
}

function formatarDeltaMoeda(delta: number): string {
  const sinal = delta > 0 ? "+" : delta < 0 ? "−" : "";
  return `${sinal}${formatCurrency(Math.abs(delta))}`;
}

function formatarDeltaPp(deltaFracao: number): string {
  const sinal = deltaFracao > 0 ? "+" : deltaFracao < 0 ? "−" : "";
  const pp = Math.abs(deltaFracao) * 100;
  return `${sinal}${pp.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} p.p.`;
}

/**
 * Seção de DRE Gerencial Interativa (com comparação contra o período anterior),
 * Ponto de Equilíbrio, Simulador Financeiro e Glossário Financeiro na `/central`.
 *
 * Reutiliza integralmente os dados já carregados em `EntradaCentral` — zero
 * roundtrips extras ao banco. Quando `despesasFixas` ainda não estiverem
 * cadastradas para o período, a DRE informa a lacuna explicitamente em vez de
 * assumir zero.
 */
export function SecaoDreGerencial({
  entrada,
  periodoRotulo = "periodo",
  despesasFixas = null,
  despesasVariaveis = null,
  despesasFixasAnterior = null,
  despesasVariaveisAnterior = null,
  contextoFiscal = CONTEXTO_FISCAL_VAZIO,
}: {
  entrada: EntradaCentral;
  periodoRotulo?: string;
  despesasFixas?: number | null;
  despesasVariaveis?: number | null;
  despesasFixasAnterior?: number | null;
  despesasVariaveisAnterior?: number | null;
  contextoFiscal?: ContextoFiscalDre;
}): ReactNode {
  const r = entrada.atual;
  const baseBruta = r.receita_coberta ?? r.receita_bruta;
  const cobertura = r.receita_bruta > 0 && r.receita_coberta !== null ? r.receita_coberta / r.receita_bruta : null;

  // Investimento em Ads proporcional à receita coberta (mesma regra de `contribuicao` em central-indicadores.ts)
  const adsProporcional =
    entrada.adsZeroLegitimo
      ? 0
      : entrada.adsAtual !== null && entrada.coberturaAdsAtual.completa && r.receita_bruta > 0 && r.receita_coberta !== null
        ? Math.round(((entrada.adsAtual.investimento * r.receita_coberta) / r.receita_bruta) * 100) / 100
        : null;

  // Contexto fiscal multi-CNPJ: quando a conta filtrada está vinculada a um CNPJ com
  // vigência tributária ativa, calcula tributos pelo motor multi-regime (incluindo créditos no Lucro Real).
  const entidadeDaConta = contextoFiscal.entidadeDaConta;
  const apuracaoCnpjAtual =
    entidadeDaConta?.configVigente != null && baseBruta > 0
      ? calcularTributosEntidade({
          config: entidadeDaConta.configVigente,
          faturamentoBruto: baseBruta,
          cmv: r.custo_produtos,
        })
      : null;

  const impostoDreAtual =
    entrada.impostoAtual?.imposto_coberto ?? apuracaoCnpjAtual?.impostoLiquidoVendas ?? null;
  const avisoDivergenciaFiscal =
    entrada.impostoAtual?.imposto_coberto != null &&
    apuracaoCnpjAtual !== null &&
    baseBruta > 0 &&
    Math.abs(entrada.impostoAtual.imposto_coberto / baseBruta - (apuracaoCnpjAtual.aliquotaEfetivaSobreFaturamento ?? 0)) >
      0.002
      ? ` Atenção: a DRE está usando a alíquota global de Metas e imposto; pelo regime específico deste CNPJ, o tributo líquido estimado seria ${formatCurrency(apuracaoCnpjAtual.impostoLiquidoVendas)}.`
      : "";

  const dre = montarDreGerencial({
    faturamentoBruto: baseBruta,
    impostosSobreVendas: impostoDreAtual,
    origemImpostos: impostoDreAtual !== null ? "estimado" : "ausente",
    cmv: r.custo_produtos,
    comissoesMarketplace: r.taxas_ml_cobertas,
    custosLogisticos: r.frete_vendedor_coberto,
    despesasVariaveis,
    investimentoAds: adsProporcional,
    origemAds: entrada.adsZeroLegitimo ? "real" : adsProporcional !== null ? "real" : "ausente",
    despesasFixas,
    coberturaReceita: cobertura,
  });

  // DRE do período anterior (quando carregado) para coluna comparativa "vs. Anterior"
  const rAnt = entrada.anterior;
  const dreAnterior = (() => {
    if (rAnt === null) return null;
    const baseBrutaAnt = rAnt.receita_coberta ?? rAnt.receita_bruta;
    const coberturaAnt =
      rAnt.receita_bruta > 0 && rAnt.receita_coberta !== null ? rAnt.receita_coberta / rAnt.receita_bruta : null;
    const adsAntProporcional = entrada.adsZeroLegitimo
      ? 0
      : entrada.adsAnterior !== null &&
          entrada.coberturaAdsAnterior.completa &&
          rAnt.receita_bruta > 0 &&
          rAnt.receita_coberta !== null
        ? Math.round(((entrada.adsAnterior.investimento * rAnt.receita_coberta) / rAnt.receita_bruta) * 100) / 100
        : null;

    return montarDreGerencial({
      faturamentoBruto: baseBrutaAnt,
      impostosSobreVendas: entrada.impostoAnterior?.imposto_coberto ?? null,
      origemImpostos: entrada.impostoAnterior?.imposto_coberto != null ? "estimado" : "ausente",
      cmv: rAnt.custo_produtos,
      comissoesMarketplace: rAnt.taxas_ml_cobertas,
      custosLogisticos: rAnt.frete_vendedor_coberto,
      despesasVariaveis: despesasVariaveisAnterior,
      investimentoAds: adsAntProporcional,
      origemAds: entrada.adsZeroLegitimo ? "real" : adsAntProporcional !== null ? "real" : "ausente",
      despesasFixas: despesasFixasAnterior,
      coberturaReceita: coberturaAnt,
    });
  })();
  const linhasAnteriorPorId = new Map((dreAnterior?.linhas ?? []).map((l) => [l.id, l]));

  const pe = dre.pontoDeEquilibrio;

  const celulasPe: KpiCellData[] = [
    {
      label: "Margem de contribuição",
      formula: "(Receita líquida − CMV − Comissões − Frete − Ads) ÷ Faturamento",
      value: formatPercent(dre.margemContribuicaoFracao),
      previous: null,
      ressalva: dre.margemContribuicaoValor === null ? "aguardando fechamento de imposto/Ads" : formatCurrency(dre.margemContribuicaoValor),
    },
    {
      label: "Despesas operacionais fixas",
      formula: "Soma das despesas fixas cadastradas para a competência",
      value: pe.despesasFixas === null ? "não cadastradas" : formatCurrency(pe.despesasFixas),
      previous: null,
      ressalva: pe.despesasFixas === null ? "cadastre em Custos e Fiscal" : "competência do período",
      href: "/central/custos",
    },
    {
      label: "Ponto de equilíbrio",
      formula: "Despesas Fixas ÷ Margem de Contribuição (%)",
      value:
        pe.status === "alcancavel"
          ? formatCurrency(pe.faturamentoEquilibrio)
          : pe.status === "margem_nao_positiva"
            ? "inalcançável"
            : "—",
      previous: null,
      ressalva: pe.explicacao,
      ...(pe.status === "margem_nao_positiva" ? { destaque: "perigo" as const } : {}),
    },
    {
      label: "Resultado líquido gerencial",
      formula: "Margem de contribuição − Despesas operacionais fixas",
      value: dre.resultadoLiquidoGerencial === null ? "—" : formatCurrency(dre.resultadoLiquidoGerencial),
      previous: null,
      ressalva:
        dre.margemLiquidaFinal === null
          ? "requer despesas fixas cadastradas"
          : `margem líquida final: ${formatPercent(dre.margemLiquidaFinal)}`,
      ...(dre.resultadoLiquidoGerencial !== null && dre.resultadoLiquidoGerencial < 0
        ? { destaque: "perigo" as const }
        : dre.resultadoLiquidoGerencial !== null && dre.resultadoLiquidoGerencial > 0
          ? { destaque: "ok" as const }
          : {}),
    },
  ];

  const lacunasSimulacao: string[] = [];
  if (impostoDreAtual === null) lacunasSimulacao.push("impostos sobre vendas");
  if (adsProporcional === null) lacunasSimulacao.push("investimento em Ads");
  if (despesasFixas === null) lacunasSimulacao.push("despesas operacionais fixas");

  return (
    <section aria-label="DRE Gerencial e Inteligência Financeira" className="sb-central-bloco" id="dre-gerencial">
      <div className="sb-section-label">
        <span>DRE Gerencial e Ponto de Equilíbrio</span>
        <span className="sb-section-note">
          do faturamento bruto ao resultado líquido gerencial · sem dupla contagem ·{" "}
          {cobertura !== null && cobertura < 0.999
            ? `base coberta (${formatPercent(cobertura)} da receita)`
            : "cobertura integral"}
        </span>
      </div>

      <KpiStrip cells={celulasPe} />

      <div className="sb-central-bloco">
        <Panel
          title="Demonstrativo de Resultado (DRE Gerencial)"
          subtitle="Cada linha declara sua origem (real, estimado, manual ou calculado). Dados ausentes ficam em aberto, nunca zerados."
          aside={
            <div className="sb-custos-acoes">
              <ExportarDreCsv
                linhas={dre.linhas}
                linhasAnterior={dreAnterior?.linhas ?? null}
                periodoRotulo={periodoRotulo}
              />
              <Link className="sb-button" href="/central/custos">
                Gerenciar custos e fiscal
              </Link>
            </div>
          }
        >
          <div className="sb-panel-body">
            <div className="sb-central-tabela">
              <table className="sb-table sb-dre-tabela">
                <thead>
                  <tr>
                    <th>Etapa do resultado</th>
                    <th>Origem</th>
                    <th className="sb-dre-col-barra">Composição</th>
                    <th className="sb-num">Valor (R$)</th>
                    <th className="sb-num">% s/ Bruto</th>
                    <th className="sb-num">vs. Anterior</th>
                  </tr>
                </thead>
                <tbody>
                  {dre.linhas.map((linha) => {
                    const origemInfo = ORIGEM_LABEL[linha.origem];
                    const negativo = linha.valor !== null && linha.valor < 0;
                    const linhaAnt = linhasAnteriorPorId.get(linha.id) ?? null;
                    const deltaReais =
                      linha.valor !== null && linhaAnt !== null && linhaAnt.valor !== null
                        ? Math.round((linha.valor - linhaAnt.valor) * 100) / 100
                        : null;
                    const deltaPp =
                      linha.id !== "faturamento_bruto" &&
                      linha.percentualSobreBruto !== null &&
                      linhaAnt !== null &&
                      linhaAnt.percentualSobreBruto !== null
                        ? linha.percentualSobreBruto - linhaAnt.percentualSobreBruto
                        : null;
                    const rowClass = [
                      linha.destaque ? "sb-dre-destaque" : null,
                      linha.tipo === "subtotal" ? "sb-dre-subtotal" : null,
                      linha.tipo === "resultado" ? "sb-dre-resultado" : null,
                    ]
                      .filter((c): c is string => c !== null)
                      .join(" ");

                    return (
                      <tr key={linha.id} className={rowClass || undefined} title={linha.explicacao}>
                        <td>
                          <strong>{linha.rotulo}</strong>
                          <span className="sb-central-motivo">{linha.explicacao}</span>
                        </td>
                        <td>
                          <StatePill tone={{ tom: origemInfo.tom, label: origemInfo.rotulo }} />
                        </td>
                        <td className="sb-dre-col-barra" aria-hidden="true">
                          <div className="sb-dre-trilha">
                            <span
                              className={`sb-dre-barra sb-dre-barra-${linha.tipo}${negativo && linha.tipo !== "deducao" ? " sb-dre-barra-negativa" : ""}`}
                              style={{ width: barraLargura(linha) }}
                            />
                          </div>
                        </td>
                        <td className={`sb-num${negativo ? " sb-dre-negativo" : ""}`}>
                          {linha.valor === null ? "—" : formatCurrency(linha.valor)}
                        </td>
                        <td className="sb-num">
                          {linha.percentualSobreBruto === null ? "—" : formatPercent(linha.percentualSobreBruto)}
                        </td>
                        <td className="sb-num">
                          {deltaReais === null ? (
                            "—"
                          ) : (
                            <>
                              {formatarDeltaMoeda(deltaReais)}
                              {deltaPp !== null && (
                                <span className="sb-central-motivo">{formatarDeltaPp(deltaPp)}</span>
                              )}
                            </>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {entidadeDaConta !== null ? (
              <div className="sb-note sb-central-bloco">
                <span>
                  REGIME FISCAL DA CONTA · {ROTULO_REGIME_TRIBUTARIO[entidadeDaConta.regime].toUpperCase()}
                </span>
                <p>
                  <strong>{entidadeDaConta.nome}</strong> ({formatarCnpj(entidadeDaConta.cnpj)})
                  {apuracaoCnpjAtual !== null
                    ? ` · alíquota efetiva ${formatPercent(apuracaoCnpjAtual.aliquotaEfetivaSobreFaturamento)}${apuracaoCnpjAtual.creditosAbatidos > 0 ? ` (créditos abatidos: ${formatCurrency(apuracaoCnpjAtual.creditosAbatidos)})` : ""} · ${entidadeDaConta.configVigente?.validadoContabilidade ? "validado pela contabilidade" : "estimativa gerencial"}`
                    : " · sem vigência tributária cadastrada em Custos e Fiscal."}
                  {avisoDivergenciaFiscal}
                </p>
              </div>
            ) : contextoFiscal.totalEntidadesAtivas > 1 ? (
              <div className="sb-note sb-central-bloco">
                <span>OPERAÇÃO MULTI-CNPJ ({String(contextoFiscal.totalEntidadesAtivas)} ENTIDADES ATIVAS)</span>
                <p>
                  No consolidado geral a DRE usa a alíquota de <Link href="/central/metas">Metas e imposto</Link>. Filtre
                  por uma conta específica acima para aplicar ou conferir o regime tributário individualizado do CNPJ
                  vinculado.
                </p>
              </div>
            ) : null}

            {dre.lacunas.length > 0 && (
              <div className="sb-note sb-central-bloco">
                <span>LACUNAS DE DADOS NESTE PERÍODO</span>
                <p>{dre.lacunas.join(" ")}</p>
              </div>
            )}
          </div>
        </Panel>
      </div>

      {baseBruta > 0 && (
        <div className="sb-central-bloco">
          <SimuladorFinanceiro
            base={
              r.custo_produtos !== null && r.taxas_ml_cobertas !== null && r.frete_vendedor_coberto !== null
                ? {
                    faturamentoBruto: baseBruta,
                    impostosSobreVendas: impostoDreAtual ?? 0,
                    cmv: r.custo_produtos,
                    comissoesMarketplace: r.taxas_ml_cobertas,
                    custosLogisticos: r.frete_vendedor_coberto,
                    investimentoAds: adsProporcional ?? 0,
                    despesasFixas: despesasFixas ?? 0,
                    despesasVariaveis: despesasVariaveis ?? 0,
                  }
                : null
            }
            lacunasParciais={lacunasSimulacao}
          />
        </div>
      )}

      <div className="sb-central-bloco">
        <Glossario titulo="Glossário financeiro da Central" termos={GLOSSARIO_FINANCEIRO} />
      </div>
    </section>
  );
}
