"use client";

import { useMemo, useState, type ReactNode } from "react";
import { calcularMargemProduto } from "@sb/domain";

import { Panel } from "../../../../components/panel";
import { formatCurrency, formatPercent } from "../../../../lib/format";

/**
 * Simulador de impacto logístico na margem oficial do produto:
 * Margem (%) = (Valor Líquido Recebido − Custo do Produto) × 100 ÷ Valor de Venda.
 *
 * Mostra quanto um aumento ou redução no frete do vendedor corrói a margem em R$,
 * em pontos percentuais (p.p.) e no mês, e qual preço de venda preserva a margem original.
 */
export function SimuladorImpactoFrete(): ReactNode {
  const [precoVenda, setPrecoVenda] = useState(120);
  const [custoProduto, setCustoProduto] = useState(55);
  const [comissaoPct, setComissaoPct] = useState(12);
  const [freteAtual, setFreteAtual] = useState(18);
  const [freteSimulado, setFreteSimulado] = useState(24);
  const [volumeMensal, setVolumeMensal] = useState(80);

  const analise = useMemo(() => {
    const venda = Math.max(0.01, precoVenda);
    const custo = Math.max(0, custoProduto);
    const taxaComissao = Math.max(0, Math.min(0.8, comissaoPct / 100));
    const comissaoReais = venda * taxaComissao;

    const recebidoAtual = venda - comissaoReais - Math.max(0, freteAtual);
    const recebidoSimulado = venda - comissaoReais - Math.max(0, freteSimulado);

    const atual = calcularMargemProduto({
      valorVenda: venda,
      valorLiquidoRecebido: recebidoAtual,
      custoProduto: custo,
    });
    const simulado = calcularMargemProduto({
      valorVenda: venda,
      valorLiquidoRecebido: recebidoSimulado,
      custoProduto: custo,
    });

    const diferencaFrete = Math.max(0, freteSimulado) - Math.max(0, freteAtual);
    const impactoMensal = -diferencaFrete * Math.max(0, volumeMensal);
    const deltaPp =
      atual.margemFracao !== null && simulado.margemFracao !== null
        ? simulado.margemFracao - atual.margemFracao
        : null;

    // Preço necessário para manter a margem percentual original após o novo frete:
    // margem_orig = (P * (1 - comissao) - frete_novo - custo) / P
    // P * (1 - comissao - margem_orig) = frete_novo + custo
    const denominador =
      atual.margemFracao !== null ? 1 - taxaComissao - atual.margemFracao : 0;
    const precoParaPreservarMargem =
      denominador > 0.01 ? Math.round(((custo + Math.max(0, freteSimulado)) / denominador) * 100) / 100 : null;

    return {
      atual,
      simulado,
      diferencaFrete,
      impactoMensal,
      deltaPp,
      precoParaPreservarMargem,
    };
  }, [precoVenda, custoProduto, comissaoPct, freteAtual, freteSimulado, volumeMensal]);

  return (
    <details className="sb-recolhivel sb-central-bloco">
      <summary>
        Simulador de impacto do frete na margem oficial{" "}
        <small>calcule a corrosão em R$, p.p. e o preço para preservar sua margem</small>
      </summary>

      <section aria-label="Simulador de impacto do frete na margem">
        <Panel
          title="Impacto do frete do vendedor na margem do produto"
          subtitle="Usa a fórmula oficial: Margem (%) = (Valor Líquido Recebido − Custo do Produto) × 100 ÷ Valor de Venda. Não altera dados reais."
        >
          <div className="sb-panel-body sb-simulador">
            <div className="sb-simulador-controles">
              <label className="sb-simulador-campo">
                <span>Preço de venda (R$)</span>
                <input
                  type="number"
                  min="1"
                  step="1"
                  className="sb-input"
                  value={precoVenda}
                  onChange={(e) => { setPrecoVenda(Number(e.target.value) || 0); }}
                />
              </label>

              <label className="sb-simulador-campo">
                <span>Custo do produto (R$)</span>
                <input
                  type="number"
                  min="0"
                  step="1"
                  className="sb-input"
                  value={custoProduto}
                  onChange={(e) => { setCustoProduto(Number(e.target.value) || 0); }}
                />
              </label>

              <label className="sb-simulador-campo">
                <span>Comissão (%)</span>
                <input
                  type="number"
                  min="0"
                  max="50"
                  step="0.5"
                  className="sb-input"
                  value={comissaoPct}
                  onChange={(e) => { setComissaoPct(Number(e.target.value) || 0); }}
                />
              </label>

              <label className="sb-simulador-campo">
                <span>Frete atual (R$)</span>
                <input
                  type="number"
                  min="0"
                  step="0.5"
                  className="sb-input"
                  value={freteAtual}
                  onChange={(e) => { setFreteAtual(Number(e.target.value) || 0); }}
                />
              </label>

              <label className="sb-simulador-campo">
                <span>Novo frete simulado (R$)</span>
                <input
                  type="number"
                  min="0"
                  step="0.5"
                  className="sb-input"
                  value={freteSimulado}
                  onChange={(e) => { setFreteSimulado(Number(e.target.value) || 0); }}
                />
              </label>

              <label className="sb-simulador-campo">
                <span>Volume mensal (unid.)</span>
                <input
                  type="number"
                  min="0"
                  step="10"
                  className="sb-input"
                  value={volumeMensal}
                  onChange={(e) => { setVolumeMensal(Number(e.target.value) || 0); }}
                />
              </label>
            </div>

            <div className="sb-central-tabela">
              <table className="sb-table">
                <thead>
                  <tr>
                    <th className="sb-num">Margem atual</th>
                    <th className="sb-num">Margem com novo frete</th>
                    <th className="sb-num">Variação (p.p.)</th>
                    <th className="sb-num">Impacto mensal</th>
                    <th className="sb-num">Preço para preservar margem</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="sb-num">
                      <strong>{formatPercent(analise.atual.margemFracao)}</strong>
                      <span className="sb-central-motivo">{formatCurrency(analise.atual.resultado)} / unid.</span>
                    </td>
                    <td className="sb-num">
                      <strong>{formatPercent(analise.simulado.margemFracao)}</strong>
                      <span className="sb-central-motivo">{formatCurrency(analise.simulado.resultado)} / unid.</span>
                    </td>
                    <td className="sb-num">
                      {analise.deltaPp === null
                        ? "—"
                        : `${analise.deltaPp > 0 ? "+" : analise.deltaPp < 0 ? "−" : ""}${(Math.abs(analise.deltaPp) * 100).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} p.p.`}
                    </td>
                    <td className="sb-num">
                      <strong>
                        {analise.impactoMensal > 0 ? "+" : analise.impactoMensal < 0 ? "−" : ""}
                        {formatCurrency(Math.abs(analise.impactoMensal))}
                      </strong>
                    </td>
                    <td className="sb-num">
                      <strong>
                        {analise.precoParaPreservarMargem === null
                          ? "—"
                          : formatCurrency(analise.precoParaPreservarMargem)}
                      </strong>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </Panel>
      </section>
    </details>
  );
}
