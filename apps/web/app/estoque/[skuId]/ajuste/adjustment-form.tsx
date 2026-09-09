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
      style={{ display: "grid", gap: "var(--sb-space-3)", maxWidth: "28rem" }}
    >
      <label style={{ fontSize: "0.875rem", fontWeight: 600 }}>
        Local
        <select className="sb-input sb-input-full" name="locationKind" defaultValue="LOCAL">
          <option value="LOCAL">Local</option>
          <option value="RESERVADO">Reservado</option>
          <option value="TRANSITO">Em trânsito</option>
        </select>
      </label>

      <label style={{ fontSize: "0.875rem", fontWeight: 600 }}>
        Quantidade (positiva = entrada, negativa = saída)
        <input className="sb-input sb-input-full" name="qtyDelta" type="number" step="any" required />
      </label>

      <label style={{ fontSize: "0.875rem", fontWeight: 600 }}>
        Motivo
        <textarea className="sb-input sb-input-full" name="reason" rows={3} required />
      </label>

      {error !== null && (
        <p role="alert" style={{ margin: 0, fontSize: "0.875rem", color: "var(--sb-danger)" }}>
          {error}
        </p>
      )}

      <button
        className="sb-button sb-button-primary"
        type="submit"
        disabled={busy}
      >
        {busy ? "Salvando…" : "Registrar ajuste"}
      </button>
    </form>
  );
}
