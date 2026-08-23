"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

import { createManualStockAdjustment } from "../../actions";

const inputStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  marginTop: "var(--sb-space-1)",
  padding: "0.5rem",
  borderRadius: "var(--sb-radius)",
  border: "1px solid var(--sb-border)",
  fontSize: "1rem",
};

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
        <select name="locationKind" defaultValue="LOCAL" style={inputStyle}>
          <option value="LOCAL">Local</option>
          <option value="RESERVADO">Reservado</option>
          <option value="TRANSITO">Em trânsito</option>
        </select>
      </label>

      <label style={{ fontSize: "0.875rem", fontWeight: 600 }}>
        Quantidade (positiva = entrada, negativa = saída)
        <input name="qtyDelta" type="number" step="any" required style={inputStyle} />
      </label>

      <label style={{ fontSize: "0.875rem", fontWeight: 600 }}>
        Motivo
        <textarea name="reason" rows={3} required style={{ ...inputStyle, resize: "vertical" }} />
      </label>

      {error !== null && (
        <p role="alert" style={{ margin: 0, fontSize: "0.875rem", color: "var(--sb-danger)" }}>
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={busy}
        style={{
          padding: "0.625rem",
          border: "none",
          borderRadius: "var(--sb-radius)",
          background: "var(--sb-primary)",
          color: "var(--sb-white)",
          fontSize: "1rem",
          fontWeight: 600,
          cursor: busy ? "not-allowed" : "pointer",
          opacity: busy ? 0.6 : 1,
        }}
      >
        {busy ? "Salvando…" : "Registrar ajuste"}
      </button>
    </form>
  );
}
