"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

import { createPurchaseOrder, updatePurchaseOrderDraft } from "../actions";
import { ItemRow } from "./item-row";
import type { DraftItem } from "./item-row";
import { detectOriginMix } from "./prefill";

const inputStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  marginTop: "var(--sb-space-1)",
  padding: "0.5rem",
  borderRadius: "var(--sb-radius)",
  border: "1px solid var(--sb-border)",
  fontSize: "1rem",
};

const th: React.CSSProperties = {
  textAlign: "left",
  padding: "0.375rem",
  fontSize: "0.75rem",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  color: "var(--sb-text-soft)",
};

let keyCounter = 0;

function emptyItem(): DraftItem {
  keyCounter += 1;

  return {
    key: `item-${String(keyCounter)}`,
    skuId: null,
    skuSnapshot: "",
    titleSnapshot: null,
    isImported: null,
    quantityOrdered: "",
    unitCost: "",
  };
}

export interface PurchaseOrderFormInitial {
  supplierId: string | null;
  destinationWarehouseName: string | null;
  notes: string | null;
  /** Data de negócio `YYYY-MM-DD` — já vem cortada de `expected_at`, nunca `new Date(...)` aqui (mesmo raciocínio de `formatBusinessDate`). */
  expectedAt: string | null;
  items: DraftItem[];
}

export function PurchaseOrderForm({
  suppliers,
  orderId,
  initial,
}: {
  suppliers: { id: string; name: string }[];
  /** Presente = editando um rascunho existente; ausente = criando um pedido novo. */
  orderId?: string;
  initial?: PurchaseOrderFormInitial;
}): ReactNode {
  const router = useRouter();
  const isEditing = orderId !== undefined;

  const [supplierId, setSupplierId] = useState(initial?.supplierId ?? "");
  const [destinationWarehouseName, setDestinationWarehouseName] = useState(
    initial?.destinationWarehouseName ?? "",
  );
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [expectedAt, setExpectedAt] = useState(initial?.expectedAt ?? "");
  const [items, setItems] = useState<DraftItem[]>(initial?.items ?? [emptyItem()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function updateItem(key: string, next: DraftItem): void {
    setItems((current) => current.map((item) => (item.key === key ? next : item)));
  }

  function removeItem(key: string): void {
    setItems((current) => (current.length <= 1 ? current : current.filter((item) => item.key !== key)));
  }

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);

    const validItems = items.filter((item) => item.skuSnapshot.trim() !== "" && item.quantityOrdered.trim() !== "");

    if (validItems.length === 0) {
      setError("Adicione ao menos um item com SKU e quantidade.");
      setBusy(false);

      return;
    }

    const input = {
      supplierId: supplierId === "" ? null : supplierId,
      destinationWarehouseName: destinationWarehouseName.trim() === "" ? null : destinationWarehouseName.trim(),
      currency: "BRL",
      notes: notes.trim() === "" ? null : notes.trim(),
      expectedAt: expectedAt === "" ? null : new Date(expectedAt).toISOString(),
      items: validItems.map((item) => ({
        skuId: item.skuId,
        skuSnapshot: item.skuSnapshot.trim(),
        titleSnapshot: item.titleSnapshot,
        quantityOrdered: Number(item.quantityOrdered),
        unitCost: item.unitCost.trim() === "" ? null : Number(item.unitCost),
      })),
    };

    if (isEditing) {
      const result = await updatePurchaseOrderDraft(orderId, input);

      if (!result.ok) {
        setError(result.message ?? "Não foi possível salvar as alterações.");
        setBusy(false);

        return;
      }

      router.push(`/compras/${orderId}`);

      return;
    }

    const result = await createPurchaseOrder(input);

    if (!result.ok || result.id === undefined) {
      setError(result.message ?? "Não foi possível criar o pedido.");
      setBusy(false);

      return;
    }

    router.push(`/compras/${result.id}`);
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      style={{ display: "grid", gap: "var(--sb-space-4)", maxWidth: "56rem" }}
    >
      <div style={{ display: "grid", gap: "var(--sb-space-3)", gridTemplateColumns: "1fr 1fr", maxWidth: "40rem" }}>
        <label style={{ fontSize: "0.875rem", fontWeight: 600 }}>
          Fornecedor
          <select
            value={supplierId}
            onChange={(event) => {
              setSupplierId(event.target.value);
            }}
            style={inputStyle}
          >
            <option value="">Sem fornecedor definido ainda</option>
            {suppliers.map((supplier) => (
              <option key={supplier.id} value={supplier.id}>
                {supplier.name}
              </option>
            ))}
          </select>
        </label>

        <label style={{ fontSize: "0.875rem", fontWeight: 600 }}>
          Armazém de destino
          <input
            value={destinationWarehouseName}
            onChange={(event) => {
              setDestinationWarehouseName(event.target.value);
            }}
            style={inputStyle}
          />
        </label>

        <label style={{ fontSize: "0.875rem", fontWeight: 600 }}>
          Previsão de chegada
          <input
            type="date"
            value={expectedAt}
            onChange={(event) => {
              setExpectedAt(event.target.value);
            }}
            style={inputStyle}
          />
        </label>
      </div>

      <label style={{ fontSize: "0.875rem", fontWeight: 600, maxWidth: "40rem" }}>
        Observações
        <textarea
          value={notes}
          onChange={(event) => {
            setNotes(event.target.value);
          }}
          rows={3}
          style={{ ...inputStyle, resize: "vertical" }}
        />
      </label>

      <div>
        <h2 style={{ fontSize: "1rem", margin: "0 0 var(--sb-space-2)" }}>Itens</h2>

        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", minWidth: "40rem" }}>
            <thead>
              <tr>
                <th style={{ ...th, width: "20rem" }}>SKU</th>
                <th style={{ ...th, width: "8rem" }}>Quantidade</th>
                <th style={{ ...th, width: "8rem" }}>Custo unitário</th>
                <th style={{ ...th, width: "6rem" }} />
              </tr>
            </thead>

            <tbody>
              {items.map((item) => (
                <ItemRow
                  key={item.key}
                  item={item}
                  onChange={(next) => {
                    updateItem(item.key, next);
                  }}
                  onRemove={() => {
                    removeItem(item.key);
                  }}
                />
              ))}
            </tbody>
          </table>
        </div>

        <button
          type="button"
          onClick={() => {
            setItems((current) => [...current, emptyItem()]);
          }}
          style={{
            marginTop: "var(--sb-space-2)",
            padding: "0.375rem 0.75rem",
            borderRadius: "var(--sb-radius)",
            border: "1px solid var(--sb-border)",
            background: "transparent",
            color: "var(--sb-text)",
            fontSize: "0.8125rem",
            cursor: "pointer",
          }}
        >
          + Adicionar item
        </button>
      </div>

      {(() => {
        /*
          "Não misturar nacional e importado" (PRD) como AVISO, nunca
          bloqueio (D-151): `is_imported` é origem FISCAL e D-129/D-139
          mediram que ela contradiz a rota de compra em parte do catálogo —
          bloquear em cima de dado sabidamente errado impediria pedidos
          legítimos. O aviso entrega a regra; a decisão continua humana.
        */
        const mix = detectOriginMix(items);

        if (!mix.mixed) return null;

        return (
          <p
            role="alert"
            style={{
              margin: 0,
              fontSize: "0.8125rem",
              color: "var(--sb-accent-ink)",
              border: "1px solid var(--sb-accent-ink)",
              borderRadius: "var(--sb-radius)",
              padding: "var(--sb-space-2)",
              maxWidth: "40rem",
            }}
          >
            ⚠ Este pedido mistura <strong>{mix.imported} importado(s)</strong> e{" "}
            <strong>{mix.national} nacional(is)</strong>
            {mix.unknown > 0 && <> (mais {mix.unknown} sem origem conhecida)</>} — a regra da operação é não
            misturar importação e compra nacional num mesmo pedido. A origem aqui é a FISCAL do cadastro, que erra
            parte do catálogo (D-129); confira pela rota de compra real antes de criar.
          </p>
        );
      })()}

      {error !== null && (
        <p role="alert" style={{ margin: 0, fontSize: "0.875rem", color: "var(--sb-danger)" }}>
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={busy}
        style={{
          padding: "0.625rem 1rem",
          border: "none",
          borderRadius: "var(--sb-radius)",
          background: "var(--sb-primary)",
          color: "var(--sb-white)",
          fontSize: "1rem",
          fontWeight: 600,
          cursor: busy ? "not-allowed" : "pointer",
          opacity: busy ? 0.6 : 1,
          justifySelf: "start",
        }}
      >
        {busy ? "Salvando…" : isEditing ? "Salvar alterações" : "Criar pedido (rascunho)"}
      </button>
    </form>
  );
}
