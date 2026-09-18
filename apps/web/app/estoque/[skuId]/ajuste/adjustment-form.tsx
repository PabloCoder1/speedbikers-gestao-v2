"use client";

import { useState, useTransition, type ReactNode } from "react";

import { formatCount, formatCurrency } from "../../../../lib/format";
import { formatQtyDelta, locationKindLabel } from "../../../../lib/movement-labels";
import {
  ADJUSTMENT_LOCATIONS,
  ADJUSTMENT_MODES,
  ADJUSTMENT_REASONS,
  NOTE_MAX,
  REFERENCE_MAX,
  adjustmentDelta,
  type AdjustmentLocation,
  type AdjustmentMode,
} from "../../../../lib/stock-adjustment";
import { createManualStockAdjustment } from "../../actions";

const MODES: Readonly<
  Record<AdjustmentMode, { label: string; sign: string; hint: string; qtyLabel: string }>
> = {
  ENTRADA: { label: "Entrada", sign: "+", hint: "Soma ao saldo", qtyLabel: "Quantidade que entra" },
  SAIDA: { label: "Saída", sign: "−", hint: "Tira do saldo", qtyLabel: "Quantidade que sai" },
  BALANCO: { label: "Balanço", sign: "=", hint: "Ajusta à contagem", qtyLabel: "Saldo contado" },
};

const QUICK_STEPS = [1, 5, 10] as const;

export function AdjustmentForm({
  skuId,
  balances,
  unitCost,
  unit,
  authorName,
  authorInitials,
  disabled,
  balanceUnavailable,
}: {
  skuId: string;
  balances: Readonly<Record<AdjustmentLocation, number>>;
  unitCost: number | null;
  unit: string | null;
  authorName: string;
  authorInitials: string;
  disabled: boolean;
  balanceUnavailable: boolean;
}): ReactNode {
  const [pending, startTransition] = useTransition();

  const [mode, setMode] = useState<AdjustmentMode>("ENTRADA");
  const [location, setLocation] = useState<AdjustmentLocation>("LOCAL");
  const [quantityText, setQuantityText] = useState("");
  const [category, setCategory] = useState<string>(ADJUSTMENT_REASONS.ENTRADA[0] ?? "");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const modeInfo = MODES[mode];
  const unidade = unit !== null && unit.trim() !== "" ? unit.trim().toLowerCase() : "un.";

  const current = balances[location];
  const quantity = quantityText.trim() === "" ? NaN : Number(quantityText);
  const quantityValid = Number.isInteger(quantity) && quantity >= 0;
  const delta = quantityValid ? adjustmentDelta(mode, quantity, current) : null;
  const next = delta === null ? null : current + delta;
  const goesNegative = next !== null && next < 0;
  const impact = delta !== null && unitCost !== null ? delta * unitCost : null;

  function chooseMode(value: AdjustmentMode): void {
    setMode(value);
    setCategory(ADJUSTMENT_REASONS[value][0] ?? "");
    setError(null);
    setSuccess(null);
  }

  function step(amount: number): void {
    const base = quantityValid ? quantity : 0;

    setQuantityText(String(Math.max(0, base + amount)));
    setError(null);
  }

  function submit(): void {
    setError(null);
    setSuccess(null);

    if (!quantityValid || (mode !== "BALANCO" && quantity === 0)) {
      setError(
        mode === "BALANCO"
          ? "Informe o saldo contado — um número inteiro, zero ou maior."
          : "Informe uma quantidade inteira maior que zero.",
      );

      return;
    }

    if (delta === null) {
      setError("O saldo contado é igual ao saldo do sistema — não há diferença para ajustar.");

      return;
    }

    startTransition(async () => {
      const result = await createManualStockAdjustment({
        skuId,
        locationKind: location,
        mode,
        quantity,
        category,
        reference,
        note,
      });

      if (!result.ok) {
        setError(result.message);

        return;
      }

      const gravado = result.delta ?? delta;

      setSuccess(
        `Ajuste registrado: ${formatQtyDelta(gravado)} ${unidade} em ${locationKindLabel(location)}.`,
      );
      setQuantityText("");
      setReference("");
      setNote("");
    });
  }

  const submitLabel =
    delta === null
      ? `Registrar ${modeInfo.label.toLowerCase()}`
      : mode === "BALANCO"
        ? `Registrar balanço (${formatQtyDelta(delta)} ${unidade})`
        : `Registrar ${modeInfo.label.toLowerCase()} de ${formatCount(Math.abs(delta))} ${unidade}`;

  return (
    <form
      className={`sb-adjust-form sb-adjust-mode-${mode.toLowerCase()}`}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <fieldset className="sb-adjust-fieldset" disabled={disabled || pending}>
        <legend><span className="sb-adjust-step">1</span> Operação</legend>
        <div className="sb-adjust-modes">
          {ADJUSTMENT_MODES.map((value) => (
            <label
              key={value}
              className={`sb-adjust-mode sb-adjust-mode-${value.toLowerCase()}${mode === value ? " is-active" : ""}`}
            >
              <input
                type="radio"
                name="mode"
                value={value}
                checked={mode === value}
                onChange={() => { chooseMode(value); }}
              />
              <span className="sb-adjust-mode-sign" aria-hidden="true">
                {MODES[value].sign}
              </span>
              <span className="sb-adjust-mode-copy">
                <b>{MODES[value].label}</b>
                <small>{MODES[value].hint}</small>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="sb-adjust-fieldset" disabled={disabled || pending}>
        <legend><span className="sb-adjust-step">2</span> Local</legend>
        <div className="sb-adjust-locations">
          {ADJUSTMENT_LOCATIONS.map((kind) => (
            <label key={kind} className={`sb-adjust-location${location === kind ? " is-active" : ""}`}>
              <input
                type="radio"
                name="locationKind"
                value={kind}
                checked={location === kind}
                onChange={() => {
                  setLocation(kind);
                  setError(null);
                }}
              />
              <span>{locationKindLabel(kind)}</span>
              <strong>{balanceUnavailable ? "—" : formatCount(balances[kind])}</strong>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="sb-adjust-fieldset" disabled={disabled || pending}>
        <legend><span className="sb-adjust-step">3</span> {modeInfo.qtyLabel}</legend>
        <div className="sb-adjust-qty-row">
          <div className="sb-adjust-stepper">
            <button type="button" aria-label="Diminuir 1" onClick={() => { step(-1); }}>
              −
            </button>
            <input
              className="sb-adjust-qty"
              name="quantity"
              inputMode="numeric"
              pattern="[0-9]*"
              autoComplete="off"
              placeholder="0"
              aria-label={modeInfo.qtyLabel}
              value={quantityText}
              onChange={(event) => {
                setQuantityText(event.target.value.replace(/[^\d]/g, ""));
                setError(null);
                setSuccess(null);
              }}
            />
            <button type="button" aria-label="Aumentar 1" onClick={() => { step(1); }}>
              +
            </button>
          </div>
          <div className="sb-adjust-quick">
            {mode === "BALANCO" ? (
              <button type="button" onClick={() => { setQuantityText(String(Math.max(0, current))); }}>
                Usar saldo atual
              </button>
            ) : (
              QUICK_STEPS.map((amount) => (
                <button key={amount} type="button" onClick={() => { step(amount); }}>
                  +{amount}
                </button>
              ))
            )}
          </div>
        </div>
      </fieldset>

      <fieldset className="sb-adjust-fieldset" disabled={disabled || pending}>
        <legend><span className="sb-adjust-step">4</span> Motivo</legend>
        <div className="sb-adjust-reasons">
          {ADJUSTMENT_REASONS[mode].map((item) => (
            <label key={item} className={`sb-adjust-reason${category === item ? " is-active" : ""}`}>
              <input
                type="radio"
                name="category"
                value={item}
                checked={category === item}
                onChange={() => { setCategory(item); }}
              />
              {item}
            </label>
          ))}
        </div>

        <div className="sb-adjust-optional">
          <label className="sb-adjust-field">
            <span>
              Documento ou referência <em>opcional</em>
            </span>
            <input
              className="sb-input sb-input-full"
              name="reference"
              maxLength={REFERENCE_MAX}
              placeholder="Ex.: pedido 2001, NF 1234, contagem 09/2026"
              value={reference}
              onChange={(event) => { setReference(event.target.value); }}
            />
          </label>
          <label className="sb-adjust-field">
            <span>
              Observação <em>opcional</em>
              <small className="sb-adjust-counter">
                {note.length}/{NOTE_MAX}
              </small>
            </span>
            <textarea
              className="sb-input sb-input-full"
              name="note"
              rows={2}
              maxLength={NOTE_MAX}
              placeholder="Detalhe o que aconteceu, se ajudar quem ler depois."
              value={note}
              onChange={(event) => { setNote(event.target.value); }}
            />
          </label>
        </div>
      </fieldset>

      {/* Prévia: a pessoa vê o saldo final antes de gravar — a confirmação
          acontece aqui, sem modal. */}
      <div className={`sb-adjust-preview${goesNegative ? " is-warning" : ""}`} aria-live="polite">
        <div>
          <small>Saldo atual · {locationKindLabel(location)}</small>
          <strong>{balanceUnavailable ? "—" : formatCount(current)}</strong>
        </div>
        <span className="sb-adjust-preview-arrow" aria-hidden="true">
          {delta === null ? "→" : formatQtyDelta(delta)}
        </span>
        <div>
          <small>Saldo após o ajuste</small>
          <strong>{balanceUnavailable || next === null ? "—" : formatCount(next)}</strong>
        </div>
        {!balanceUnavailable && impact !== null && (
          <div className="sb-adjust-preview-impact">
            <small>Variação a custo</small>
            <strong>
              {impact > 0 ? "+" : "−"}
              {formatCurrency(Math.abs(impact))}
            </strong>
          </div>
        )}
      </div>

      {goesNegative && (
        <p className="sb-adjust-warning" role="status">
          Esta saída deixa o saldo de {locationKindLabel(location)} negativo. Confira a contagem antes de registrar.
        </p>
      )}

      {error !== null && (
        <p role="alert" className="sb-adjust-form-error">
          {error}
        </p>
      )}

      {success !== null && (
        <p role="status" className="sb-adjust-form-success">
          ✓ {success}
        </p>
      )}

      <div className="sb-adjust-form-footer">
        <span className="sb-adjust-author">
          <span className="sb-adjust-author-avatar" aria-hidden="true">
            {authorInitials}
          </span>
          <span>
            <small>Registrado por</small>
            <b>{authorName}</b>
          </span>
        </span>
        <button
          className="sb-button sb-button-primary sb-adjust-submit"
          type="submit"
          disabled={disabled || pending || delta === null}
        >
          {pending ? "Registrando…" : submitLabel}
        </button>
      </div>
    </form>
  );
}
