"use client";

import { useMemo, useState, type ReactNode } from "react";
import { simularCenarioFinanceiro, type BaseSimulacao } from "@sb/domain";

import { Panel } from "../../../components/panel";
import { formatCurrency, formatPercent } from "../../../lib/format";

function comSinalMoeda(valor: number | null): string {
  if (valor === null) return "—";
  const prefixo = valor > 0 ? "+" : valor < 0 ? "−" : "";
  return `${prefixo}${formatCurrency(Math.abs(valor))}`;
}

function comSinalPp(fracao: number | null): string {
  if (fracao === null) return "—";
  const pp = Math.abs(fracao) * 100;
  const prefixo = fracao > 0 ? "+" : fracao < 0 ? "−" : "";
  return `${prefixo}${pp.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} p.p.`;
}

/**
 * Simulador Financeiro (What-If) — Seção 15 da Missão.
 *
 * Permite testar cenários de preço, volume, comissão, imposto, custo de compra,
 * frete, Ads e despesas fixas diretamente sobre o período atual sem alterar
 * nenhum dado real no banco.
 */
export function SimuladorFinanceiro({
  base,
  lacunasParciais = [],
}: {
  base: BaseSimulacao | null;
  lacunasParciais?: readonly string[];
}): ReactNode {
  const [deltaPreco, setDeltaPreco] = useState(0);
  const [deltaVolume, setDeltaVolume] = useState(0);
  const [deltaCusto, setDeltaCusto] = useState(0);
  const [deltaFrete, setDeltaFrete] = useState(0);
  const [deltaAds, setDeltaAds] = useState(0);
  const [deltaComissaoPp, setDeltaComissaoPp] = useState(0);
  const [deltaImpostoPp, setDeltaImpostoPp] = useState(0);
  const [deltaFixas, setDeltaFixas] = useState(0);

  const resultado = useMemo(
    () =>
      base === null
        ? null
        : simularCenarioFinanceiro(base, {
            deltaPreco: deltaPreco / 100,
            deltaVolume: deltaVolume / 100,
            deltaCustoCompra: deltaCusto / 100,
            deltaFrete: deltaFrete / 100,
            deltaAds: deltaAds / 100,
            deltaComissaoPp: deltaComissaoPp / 100,
            deltaImpostoPp: deltaImpostoPp / 100,
            deltaDespesasFixasReais: deltaFixas,
          }),
    [base, deltaPreco, deltaVolume, deltaCusto, deltaFrete, deltaAds, deltaComissaoPp, deltaImpostoPp, deltaFixas],
  );

  const alterado =
    deltaPreco !== 0 ||
    deltaVolume !== 0 ||
    deltaCusto !== 0 ||
    deltaFrete !== 0 ||
    deltaAds !== 0 ||
    deltaComissaoPp !== 0 ||
    deltaImpostoPp !== 0 ||
    deltaFixas !== 0;

  function zerar(): void {
    setDeltaPreco(0);
    setDeltaVolume(0);
    setDeltaCusto(0);
    setDeltaFrete(0);
    setDeltaAds(0);
    setDeltaComissaoPp(0);
    setDeltaImpostoPp(0);
    setDeltaFixas(0);
  }

  return (
    <details className="sb-recolhivel">
      <summary>
        Simulador financeiro (What-If){" "}
        <small>teste impacto de preço, custos, impostos, frete, Ads e despesas sem alterar dados reais</small>
      </summary>

      <Panel
        title="Simulador de cenários financeiros"
        subtitle="Simulação local em memória sobre os números do período selecionado. Nenhum dado real é modificado."
        aside={
          resultado !== null && alterado ? (
            <button type="button" className="sb-button" onClick={zerar}>
              Resetar simulação
            </button>
          ) : undefined
        }
      >
        {resultado === null ? (
          <div className="sb-panel-body">
            <div className="sb-note">
              <span>BASE INSUFICIENTE PARA SIMULAÇÃO</span>
              <p>
                Nenhum pedido deste período tem custo do produto (CMV), comissão e frete observados ao mesmo tempo. Para
                não assumir custo zero silenciosamente nem exibir margem fictícia de 100%, o simulador só é habilitado
                quando há pedidos cobertos na base da DRE.
              </p>
            </div>
          </div>
        ) : (
        <div className="sb-panel-body sb-simulador">
          {lacunasParciais.length > 0 && (
            <div className="sb-note">
              <span>BASE PARCIAL NA SIMULAÇÃO</span>
              <p>
                Ausente(s) no período: {lacunasParciais.join(", ")}. Nesta simulação local eles partem de R$ 0,00 para
                permitir testar cenários — na DRE oficial acima seguem explicitamente sem dado.
              </p>
            </div>
          )}
          <div className="sb-simulador-controles">
            <label className="sb-simulador-campo">
              <span>Preço de venda (%)</span>
              <input
                type="number"
                step="0.5"
                className="sb-input"
                value={deltaPreco}
                onChange={(e) => { setDeltaPreco(Number(e.target.value) || 0); }}
              />
            </label>

            <label className="sb-simulador-campo">
              <span>Volume de vendas (%)</span>
              <input
                type="number"
                step="1"
                className="sb-input"
                value={deltaVolume}
                onChange={(e) => { setDeltaVolume(Number(e.target.value) || 0); }}
              />
            </label>

            <label className="sb-simulador-campo">
              <span>Custo de compra / CMV (%)</span>
              <input
                type="number"
                step="0.5"
                className="sb-input"
                value={deltaCusto}
                onChange={(e) => { setDeltaCusto(Number(e.target.value) || 0); }}
              />
            </label>

            <label className="sb-simulador-campo">
              <span>Custo logístico / frete (%)</span>
              <input
                type="number"
                step="1"
                className="sb-input"
                value={deltaFrete}
                onChange={(e) => { setDeltaFrete(Number(e.target.value) || 0); }}
              />
            </label>

            <label className="sb-simulador-campo">
              <span>Comissão (p.p.)</span>
              <input
                type="number"
                step="0.5"
                className="sb-input"
                value={deltaComissaoPp}
                onChange={(e) => { setDeltaComissaoPp(Number(e.target.value) || 0); }}
              />
            </label>

            <label className="sb-simulador-campo">
              <span>Imposto (p.p.)</span>
              <input
                type="number"
                step="0.5"
                className="sb-input"
                value={deltaImpostoPp}
                onChange={(e) => { setDeltaImpostoPp(Number(e.target.value) || 0); }}
              />
            </label>

            <label className="sb-simulador-campo">
              <span>Investimento em Ads (%)</span>
              <input
                type="number"
                step="5"
                className="sb-input"
                value={deltaAds}
                onChange={(e) => { setDeltaAds(Number(e.target.value) || 0); }}
              />
            </label>

            <label className="sb-simulador-campo">
              <span>Despesas fixas (R$)</span>
              <input
                type="number"
                step="500"
                className="sb-input"
                value={deltaFixas}
                onChange={(e) => { setDeltaFixas(Number(e.target.value) || 0); }}
              />
            </label>
          </div>

          <div className="sb-central-tabela">
            <table className="sb-table">
              <thead>
                <tr>
                  <th>Indicador</th>
                  <th className="sb-num">Cenário atual</th>
                  <th className="sb-num">Cenário simulado</th>
                  <th className="sb-num">Impacto</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>
                    <strong>Faturamento bruto</strong>
                  </td>
                  <td className="sb-num">{formatCurrency(resultado.base.faturamentoBruto)}</td>
                  <td className="sb-num">{formatCurrency(resultado.simulado.faturamentoBruto)}</td>
                  <td className="sb-num">{comSinalMoeda(resultado.impactoFaturamento)}</td>
                </tr>
                <tr>
                  <td>
                    <strong>Margem de contribuição</strong>
                  </td>
                  <td className="sb-num">
                    {formatCurrency(resultado.base.margemContribuicaoValor)} (
                    {formatPercent(resultado.base.margemContribuicaoFracao)})
                  </td>
                  <td className="sb-num">
                    {formatCurrency(resultado.simulado.margemContribuicaoValor)} (
                    {formatPercent(resultado.simulado.margemContribuicaoFracao)})
                  </td>
                  <td className="sb-num">
                    {comSinalMoeda(resultado.impactoMargemContribuicao)} ({comSinalPp(resultado.impactoMargemContribuicaoPp)})
                  </td>
                </tr>
                <tr>
                  <td>
                    <strong>Resultado líquido gerencial</strong>
                  </td>
                  <td className="sb-num">
                    {formatCurrency(resultado.base.resultadoLiquidoGerencial)} (
                    {formatPercent(resultado.base.margemLiquidaFinal)})
                  </td>
                  <td className="sb-num">
                    {formatCurrency(resultado.simulado.resultadoLiquidoGerencial)} (
                    {formatPercent(resultado.simulado.margemLiquidaFinal)})
                  </td>
                  <td className="sb-num">
                    {comSinalMoeda(resultado.impactoResultadoLiquido)} ({comSinalPp(resultado.impactoMargemLiquidaPp)})
                  </td>
                </tr>
                <tr>
                  <td>
                    <strong>Ponto de equilíbrio</strong>
                  </td>
                  <td className="sb-num">
                    {resultado.base.pontoDeEquilibrio.faturamentoEquilibrio === null
                      ? "—"
                      : formatCurrency(resultado.base.pontoDeEquilibrio.faturamentoEquilibrio)}
                  </td>
                  <td className="sb-num">
                    {resultado.simulado.pontoDeEquilibrio.faturamentoEquilibrio === null
                      ? "—"
                      : formatCurrency(resultado.simulado.pontoDeEquilibrio.faturamentoEquilibrio)}
                  </td>
                  <td className="sb-num">
                    {resultado.base.pontoDeEquilibrio.faturamentoEquilibrio !== null &&
                    resultado.simulado.pontoDeEquilibrio.faturamentoEquilibrio !== null
                      ? comSinalMoeda(
                          resultado.simulado.pontoDeEquilibrio.faturamentoEquilibrio -
                            resultado.base.pontoDeEquilibrio.faturamentoEquilibrio,
                        )
                      : "—"}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        )}
      </Panel>
    </details>
  );
}
