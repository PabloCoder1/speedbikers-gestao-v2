"use client";

import { simulateCoverageDays, simulateRequiredQuantity, simulateRuptureDate } from "@sb/domain";
import { useMemo, useState, type ReactNode } from "react";

import { formatBusinessDate, formatCount } from "../../../lib/format";

/**
 * Simulador de decisão (Fase 7, item 10, D-080,
 * `docs/PRODUCT_REQUIREMENTS.md` secao "Simulador de decisão") — cobertura
 * com estoque hipotético, data estimada de ruptura, quantidade necessária
 * para X dias. Cálculo inteiramente no CLIENTE: as três funções de
 * `@sb/domain` são puras (sem I/O), então não há por que ir ao servidor a
 * cada ajuste de premissa — o resultado atualiza junto com o campo.
 *
 * "Toda simulação deve exibir as premissas e nunca ser apresentada como
 * certeza" (requisito original) — por isso os campos de premissa ficam
 * sempre visíveis ao lado do resultado, nunca escondidos atrás de um
 * botão "calcular".
 *
 * Margem/preço fica de fora desta fatia — sem custo cadastrado por SKU
 * (`docs/METRICS.md`), não há base matemática confiável ainda.
 */

const fieldStyle: React.CSSProperties = {
  padding: "0.375rem 0.625rem",
  borderRadius: "var(--sb-radius)",
  border: "1px solid var(--sb-border)",
  background: "transparent",
  color: "inherit",
  fontSize: "0.8125rem",
  width: "8rem",
};

const resultStyle: React.CSSProperties = {
  fontSize: "1.0625rem",
  fontWeight: 700,
};

export function SimulatorPanel({
  asOf,
  initialStockQuantity,
  initialAvgDailySales,
}: {
  asOf: string;
  initialStockQuantity: number;
  initialAvgDailySales: number;
}): ReactNode {
  const [stockQuantity, setStockQuantity] = useState(initialStockQuantity);
  const [avgDailySales, setAvgDailySales] = useState(initialAvgDailySales);
  const [targetDays, setTargetDays] = useState(30);

  const coverage = useMemo(
    () => (stockQuantity >= 0 && avgDailySales >= 0 ? simulateCoverageDays(stockQuantity, avgDailySales) : null),
    [stockQuantity, avgDailySales],
  );

  const rupture = useMemo(
    () => (stockQuantity >= 0 && avgDailySales >= 0 ? simulateRuptureDate(asOf, stockQuantity, avgDailySales) : null),
    [asOf, stockQuantity, avgDailySales],
  );

  const required = useMemo(
    () => (targetDays >= 0 && avgDailySales >= 0 ? simulateRequiredQuantity(targetDays, avgDailySales) : null),
    [targetDays, avgDailySales],
  );

  const coverageDays = coverage?.coverageDays ?? null;
  const ruptureDate = rupture?.ruptureDate ?? null;

  return (
    /*
      Sem moldura própria: desde D11 este componente vive DENTRO do painel
      "Simulador de cobertura" da aba Estoque, e a moldura dupla era
      cartão-dentro-de-cartão. O título também saiu — quem o diz é o painel.
    */
    <div>

      <p style={{ margin: "0 0 var(--sb-space-3)", fontSize: "0.75rem", color: "var(--sb-text-soft)" }}>
        Simulação, não previsão — os campos abaixo partem da venda média observada nos últimos 30 dias, ajuste
        livremente para testar outro cenário.
      </p>

      <div style={{ display: "flex", gap: "var(--sb-space-4)", flexWrap: "wrap", marginBottom: "var(--sb-space-3)" }}>
        <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem", fontSize: "0.75rem" }}>
          Estoque hipotético
          <input
            type="number"
            min={0}
            step="any"
            value={stockQuantity}
            onChange={(event) => {
              setStockQuantity(Number(event.target.value));
            }}
            style={fieldStyle}
          />
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem", fontSize: "0.75rem" }}>
          Venda média diária (premissa)
          <input
            type="number"
            min={0}
            step="any"
            value={avgDailySales}
            onChange={(event) => {
              setAvgDailySales(Number(event.target.value));
            }}
            style={fieldStyle}
          />
        </label>
      </div>

      <div style={{ display: "flex", gap: "var(--sb-space-4)", flexWrap: "wrap", marginBottom: "var(--sb-space-3)" }}>
        <div>
          <div style={{ fontSize: "0.75rem", color: "var(--sb-text-soft)" }}>Cobertura estimada</div>
          <div style={resultStyle}>
            {coverageDays === null ? "indefinida (sem venda na premissa)" : `${String(coverageDays)} dia(s)`}
          </div>
        </div>

        <div>
          <div style={{ fontSize: "0.75rem", color: "var(--sb-text-soft)" }}>Ruptura estimada</div>
          <div style={resultStyle}>{ruptureDate === null ? "—" : formatBusinessDate(ruptureDate)}</div>
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "flex-end", gap: "var(--sb-space-3)", flexWrap: "wrap" }}>
        <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem", fontSize: "0.75rem" }}>
          Dias de cobertura desejados
          <input
            type="number"
            min={0}
            step="any"
            value={targetDays}
            onChange={(event) => {
              setTargetDays(Number(event.target.value));
            }}
            style={fieldStyle}
          />
        </label>

        <div>
          <div style={{ fontSize: "0.75rem", color: "var(--sb-text-soft)" }}>Quantidade necessária</div>
          <div style={resultStyle}>{required === null ? "—" : `${formatCount(required.requiredQuantity)} unidade(s)`}</div>
        </div>
      </div>
    </div>
  );
}
