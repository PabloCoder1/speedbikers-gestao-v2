"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

import { createManualStockAdjustment } from "../../actions";


export function AdjustmentForm({ skuId }: { skuId: string }): ReactNode {
  const router = useRouter();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(formData: FormData): Promise<void> {
    setBusy(true);
    setError(null);

    const locationKind = formData.get("locationKind");
    const qtyDeltaRaw = formData.get("qtyDelta");
    const reason = formData.get("reason");

    const qtyDelta = typeof qtyDeltaRaw === "string" ? Number(qtyDeltaRaw) : NaN;

    if (
      (locationKind !== "LOCAL" && locationKind !== "RESERVADO" && locationKind !== "TRANSITO") ||
      Number.isNaN(qtyDelta) ||
      qtyDelta === 0 ||
      typeof reason !== "string" ||
      reason.trim() === ""
    ) {
      setError("Preencha o local, uma quantidade diferente de zero e o motivo.");
      setBusy(false);

      return;
    }

    const result = await createManualStockAdjustment({
      skuId,
      locationKind,
      qtyDelta,
      reason: reason.trim(),
    });

    if (!result.ok) {
      setError(result.message);
      setBusy(false);

      return;
    }

    router.push("/estoque");
  }

  return (
    <form
      action={(formData) => {
        void submit(formData);
      }}
      className="sb-adjust-form"
    >
      <label className="sb-adjust-field">
        <span>Local do movimento</span>
        <select className="sb-input sb-input-full" name="locationKind" defaultValue="LOCAL">
          <option value="LOCAL">Local</option>
          <option value="RESERVADO">Reservado</option>
          <option value="TRANSITO">Em trânsito</option>
        </select>
        <small>Escolha onde a quantidade realmente mudou.</small>
      </label>

      <label className="sb-adjust-field">
        <span>Quantidade do ajuste</span>
        <input className="sb-input sb-input-full" name="qtyDelta" type="number" step="any" required />
        <small>
          Use <b>+</b> para entrada e <b>−</b> para saída.
        </small>
      </label>

      <label className="sb-adjust-field">
        <span>
          Motivo <em>obrigatório</em>
        </span>
        <textarea className="sb-input sb-input-full" name="reason" rows={3} required />
        <small>Ex.: conferência física, devolução, avaria ou correção de inventário.</small>
      </label>

      {error !== null && (
        <p role="alert" className="sb-adjust-form-error">
          {error}
        </p>
      )}

      <div className="sb-adjust-form-footer">
        <span>
          <b>Registro permanente</b>
          <br />
          A alteração ficará disponível no histórico.
        </span>
        <button className="sb-button sb-button-primary" type="submit" disabled={busy}>
          {busy ? "Salvando…" : "Registrar ajuste"}
        </button>
      </div>
    </form>
  );
}
