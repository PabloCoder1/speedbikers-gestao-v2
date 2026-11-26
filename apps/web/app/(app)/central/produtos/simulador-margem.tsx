"use client";

import { useMemo, useState, type ReactNode } from "react";
import { calcularMargemProduto, calcularPrecoParaMargemDesejada } from "@sb/domain";

import { Panel } from "../../../../components/panel";
import { formatCurrency, formatPercent } from "../../../../lib/format";

/**
 * Simulador de Preço de Venda e Margem Desejada — `/central/produtos`.
 *
 * Usa estritamente a fórmula oficial da empresa (`@sb/domain/financial`):
 *   Margem do Produto (%) = (Valor Líquido Recebido − Custo) × 100 ÷ Valor de Venda
 * Simulação local em memória — não altera preços nem cadastros reais.
 */
export function SimuladorMargemProduto(): ReactNode {
  const [custo, setCusto] = useState(50);
  const [frete, setFrete] = useState(12);
  const [tarifaFixa, setTarifaFixa] = useState(0);
  const [comissaoPct, setComissaoPct] = useState(12);
  const [impostoPct, setImpostoPct] = useState(0);
  const [margemDesejadaPct, setMargemDesejadaPct] = useState(30);

  const simulacao = useMemo(() => {
    const precoSugerido = calcularPrecoParaMargemDesejada({
      custo,
      freteFixo: frete,
      tarifaFixa,
      comissaoFracao: comissaoPct / 100,
      impostoFracao: impostoPct / 100,
      margemDesejadaFracao: margemDesejadaPct / 100,
    });

    if (precoSugerido === null) {
      return { precoSugerido: null, recebido: null, margemConferida: null, comissaoReais: null, impostoReais: null };
    }

    const comissaoReais = Math.round(precoSugerido * (comissaoPct / 100) * 100) / 100;
    const impostoReais = Math.round(precoSugerido * (impostoPct / 100) * 100) / 100;
    const recebido = Math.round((precoSugerido - comissaoReais - impostoReais - frete - tarifaFixa) * 100) / 100;
    const conferencia = calcularMargemProduto({
      valorVenda: precoSugerido,
      valorLiquidoRecebido: recebido,
      custoProduto: custo,
    });

    return {
      precoSugerido,
      recebido,
      comissaoReais,
      impostoReais,
      margemConferida: conferencia,
    };
  }, [custo, frete, tarifaFixa, comissaoPct, impostoPct, margemDesejadaPct]);

  return (
    <details className="sb-recolhivel sb-central-bloco">
      <summary>
        Simulador de preço de venda e margem desejada{" "}
        <small>descubra o preço ideal pela fórmula oficial da empresa</small>
      </summary>

      <Panel
        title="Simulador de preço por margem desejada"
        subtitle="Fórmula oficial: Margem (%) = (Valor Líquido Recebido − Custo do Produto) × 100 ÷ Valor de Venda. Não altera anúncios reais."
      >
        <div className="sb-panel-body sb-simulador">
          <div className="sb-simulador-controles">
            <label className="sb-simulador-campo">
              <span>Custo do produto (R$)</span>
              <input
                type="number"
                step="0.5"
                min="0"
                className="sb-input"
                value={custo}
                onChange={(e) => { setCusto(Number(e.target.value) || 0); }}
              />
            </label>

            <label className="sb-simulador-campo">
              <span>Frete vendedor (R$)</span>
              <input
                type="number"
                step="0.5"
                min="0"
                className="sb-input"
                value={frete}
                onChange={(e) => { setFrete(Number(e.target.value) || 0); }}
              />
            </label>

            <label className="sb-simulador-campo">
              <span>Tarifa fixa (R$)</span>
              <input
                type="number"
                step="0.5"
                min="0"
                className="sb-input"
                value={tarifaFixa}
                onChange={(e) => { setTarifaFixa(Number(e.target.value) || 0); }}
              />
            </label>

            <label className="sb-simulador-campo">
              <span>Comissão (%)</span>
              <input
                type="number"
                step="0.5"
                min="0"
                max="90"
                className="sb-input"
                value={comissaoPct}
                onChange={(e) => { setComissaoPct(Number(e.target.value) || 0); }}
              />
            </label>

            <label className="sb-simulador-campo">
              <span>Imposto (%, opcional)</span>
              <input
                type="number"
                step="0.5"
                min="0"
                max="50"
                className="sb-input"
                value={impostoPct}
                onChange={(e) => { setImpostoPct(Number(e.target.value) || 0); }}
              />
            </label>

            <label className="sb-simulador-campo">
              <span>Margem desejada (%)</span>
              <input
                type="number"
                step="1"
                min="0"
                max="85"
                className="sb-input"
                value={margemDesejadaPct}
                onChange={(e) => { setMargemDesejadaPct(Number(e.target.value) || 0); }}
              />
            </label>
          </div>

          {simulacao.precoSugerido === null ? (
            <p role="alert" className="sb-campo-erro">
              Combinação inviável: a soma de comissão + imposto + margem desejada atingiu ou superou 100% (ou custo ≤ 0).
            </p>
          ) : (
            <div className="sb-central-tabela">
              <table className="sb-table">
                <thead>
                  <tr>
                    <th className="sb-num">Preço de venda sugerido</th>
                    <th className="sb-num">Comissão</th>
                    <th className="sb-num">Imposto</th>
                    <th className="sb-num">Valor líquido recebido</th>
                    <th className="sb-num">Resultado do produto</th>
                    <th className="sb-num">Margem conferida</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="sb-num">
                      <strong>{formatCurrency(simulacao.precoSugerido)}</strong>
                    </td>
                    <td className="sb-num">{formatCurrency(simulacao.comissaoReais)}</td>
                    <td className="sb-num">{formatCurrency(simulacao.impostoReais)}</td>
                    <td className="sb-num">{formatCurrency(simulacao.recebido)}</td>
                    <td className="sb-num">{formatCurrency(simulacao.margemConferida.resultado)}</td>
                    <td className="sb-num">
                      <strong>{formatPercent(simulacao.margemConferida.margemFracao)}</strong>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Panel>
    </details>
  );
}
