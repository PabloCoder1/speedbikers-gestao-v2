"use client";

import { useMemo, useState, type ReactNode } from "react";

import { Panel } from "../../../../components/panel";
import { StatePill } from "../../../../components/state-pill";
import { formatRoas } from "../../../../lib/central-indicadores";
import { formatCurrency, formatPercent } from "../../../../lib/format";
import { acosDeEquilibrio, roasDeEquilibrio } from "../../../../lib/sinais-ads";

/**
 * Simulador de ACOS/ROAS de equilíbrio e rentabilidade após publicidade.
 * Disponível mesmo antes de haver semana consolidada, e pré-preenchido com a
 * margem real da operação quando disponível.
 */
export function SimuladorAds({ margemInicial }: { margemInicial?: number | null }): ReactNode {
  const [margemAntesAdsPct, setMargemAntesAdsPct] = useState(
    margemInicial != null && margemInicial > 0 ? Math.round(margemInicial * 1000) / 10 : 22,
  );
  const [investimentoSemanal, setInvestimentoSemanal] = useState(1500);
  const [roasSimulado, setRoasSimulado] = useState(7);

  const analise = useMemo(() => {
    const margem = Math.max(0, margemAntesAdsPct / 100);
    const acosEq = acosDeEquilibrio(margem);
    const roasEq = roasDeEquilibrio(margem);
    const invest = Math.max(0, investimentoSemanal);
    const roas = Math.max(0.01, roasSimulado);

    const vendasAds = invest * roas;
    const acosSimulado = vendasAds > 0 ? invest / vendasAds : null;
    const margemAposAds = acosSimulado !== null ? margem - acosSimulado : null;
    const lucroSemanal = vendasAds * margem - invest;
    const lucroMensal = (lucroSemanal / 7) * 30;

    return {
      acosEq,
      roasEq,
      vendasAds,
      acosSimulado,
      margemAposAds,
      lucroSemanal,
      lucroMensal,
    };
  }, [margemAntesAdsPct, investimentoSemanal, roasSimulado]);

  const tomStatus =
    analise.margemAposAds === null
      ? ("neutro" as const)
      : analise.margemAposAds < 0
        ? ("perigo" as const)
        : analise.margemAposAds < 0.05
          ? ("atencao" as const)
          : ("ok" as const);

  return (
    <details className="sb-recolhivel sb-central-bloco">
      <summary>
        Simulador de ROAS e ACOS de equilíbrio{" "}
        <small>descubra o ROAS mínimo para não ter prejuízo após Ads e projete o lucro líquido da campanha</small>
      </summary>

      <section aria-label="Simulador de ROAS e ACOS de equilíbrio">
        <Panel
          title="Planejador financeiro de campanhas (ROAS × Margem)"
          subtitle="ROAS alto não garante lucro se a margem do produto for menor que o ACOS. Simulação local em memória."
        >
          <div className="sb-panel-body sb-simulador">
            <div className="sb-simulador-controles">
              <label className="sb-simulador-campo">
                <span>Margem antes de Ads (%)</span>
                <input
                  type="number"
                  min="1"
                  max="80"
                  step="0.5"
                  className="sb-input"
                  value={margemAntesAdsPct}
                  onChange={(e) => { setMargemAntesAdsPct(Number(e.target.value) || 0); }}
                />
              </label>

              <label className="sb-simulador-campo">
                <span>Investimento semanal (R$)</span>
                <input
                  type="number"
                  min="0"
                  step="100"
                  className="sb-input"
                  value={investimentoSemanal}
                  onChange={(e) => { setInvestimentoSemanal(Number(e.target.value) || 0); }}
                />
              </label>

              <label className="sb-simulador-campo">
                <span>ROAS desejado / observado (x)</span>
                <input
                  type="number"
                  min="0.5"
                  step="0.5"
                  className="sb-input"
                  value={roasSimulado}
                  onChange={(e) => { setRoasSimulado(Number(e.target.value) || 0); }}
                />
              </label>
            </div>

            <div className="sb-central-tabela">
              <table className="sb-table">
                <thead>
                  <tr>
                    <th className="sb-num">ACOS de equilíbrio</th>
                    <th className="sb-num">ROAS mínimo</th>
                    <th className="sb-num">Vendas atribuídas (7d)</th>
                    <th className="sb-num">ACOS simulado</th>
                    <th className="sb-num">Margem após Ads</th>
                    <th className="sb-num">Lucro estimado (7d / 30d)</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="sb-num">
                      <strong>{formatPercent(analise.acosEq)}</strong>
                    </td>
                    <td className="sb-num">
                      <strong>{formatRoas(analise.roasEq)}</strong>
                    </td>
                    <td className="sb-num">{formatCurrency(analise.vendasAds)}</td>
                    <td className="sb-num">{formatPercent(analise.acosSimulado)}</td>
                    <td className="sb-num">
                      {analise.margemAposAds === null ? (
                        "—"
                      ) : (
                        <StatePill tone={{ tom: tomStatus, label: formatPercent(analise.margemAposAds) }} />
                      )}
                    </td>
                    <td className="sb-num">
                      <strong>{formatCurrency(analise.lucroSemanal)}</strong>
                      <span className="sb-central-motivo">30d: {formatCurrency(analise.lucroMensal)}</span>
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
