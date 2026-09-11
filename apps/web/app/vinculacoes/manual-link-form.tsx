"use client";

import { useState, type ReactNode } from "react";

import { useSkuSearch } from "../../components/use-sku-search";
import { createManualLink } from "./actions";

/**
 * Vinculação manual livre: `Conta + MLB + variation_id? → SKU`, sem depender
 * de existir um `link_candidate` (`docs/PRODUCT_REQUIREMENTS.md`).
 *
 * A busca de SKU lê `skus` direto do navegador sob RLS (Modelo A), mesmo
 * padrão de `candidate-row.tsx`. A escrita vai por Server Action.
 */

export interface AccountOption {
  id: string;
  label: string;
}

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: "0.75rem",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  color: "var(--sb-text-soft)",
  marginBottom: "0.25rem",
};

export function ManualLinkForm({
  accounts,
  initialAccountId,
  initialItemId,
}: {
  accounts: AccountOption[];
  /** Pré-preenchimento vindo da URL (linha de "sem vínculo"), não estado novo. */
  initialAccountId?: string;
  initialItemId?: string;
}): ReactNode {
  const [mlAccountId, setMlAccountId] = useState(
    accounts.some((account) => account.id === initialAccountId) ? (initialAccountId ?? "") : (accounts[0]?.id ?? ""),
  );
  const [itemId, setItemId] = useState(initialItemId ?? "");
  const [variationId, setVariationId] = useState("");
  const skuSearch = useSkuSearch();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    setDone(null);

    const result = await createManualLink({
      mlAccountId,
      itemId,
      variationId,
      skuId: skuSearch.selected?.id ?? "",
    });

    setBusy(false);

    if (!result.ok) {
      setError(result.message);

      return;
    }

    setDone(`${itemId.trim().toUpperCase()} vinculado ao SKU ${skuSearch.selected?.sku ?? ""}.`);
    setItemId("");
    setVariationId("");
    skuSearch.reset();
  }

  return (
    <section
      // Alvo do link "Vincular" de cada linha sem vínculo: a linha pré-preenche
      // o formulário pela URL e o `#` traz a página até ele.
      id="vincular-a-mao"
      style={{
        border: "1px solid var(--sb-border)",
        borderRadius: "var(--sb-radius)",
        background: "var(--sb-surface)",
        padding: "var(--sb-space-3)",
        marginBottom: "var(--sb-space-4)",
      }}
    >
      <h2 style={{ margin: "0 0 var(--sb-space-1)", fontSize: "1rem" }}>Vincular um anúncio à mão</h2>

      <p style={{ margin: "0 0 var(--sb-space-3)", fontSize: "0.8125rem", color: "var(--sb-text-soft)" }}>
        Vale para qualquer anúncio: o da tabela acima (o botão <strong>Vincular</strong> da linha preenche
        conta e MLB aqui) e também o que a fila de candidatos não conhece — ela só vê o que veio da planilha do
        UpSeller.
      </p>

      <div style={{ display: "grid", gap: "var(--sb-space-2)", gridTemplateColumns: "repeat(auto-fit, minmax(11rem, 1fr))" }}>
        <div>
          <label style={labelStyle} htmlFor="manual-link-account">
            Conta
          </label>
          <select
            className="sb-input sb-input-full"
            id="manual-link-account"
            value={mlAccountId}
            onChange={(event) => {
              setMlAccountId(event.target.value);
            }}
          >
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label style={labelStyle} htmlFor="manual-link-item">
            MLB do anúncio
          </label>
          <input
            className="sb-input sb-input-full"
            id="manual-link-item"
            value={itemId}
            placeholder="MLB123456789"
            onChange={(event) => {
              setItemId(event.target.value);
              setDone(null);
            }}
          />
        </div>

        <div>
          <label style={labelStyle} htmlFor="manual-link-variation">
            Variação (opcional)
          </label>
          <input
            className="sb-input sb-input-full"
            id="manual-link-variation"
            value={variationId}
            placeholder="em branco = anúncio inteiro"
            onChange={(event) => {
              setVariationId(event.target.value);
              setDone(null);
            }}
          />
        </div>

        {/*
          O campo que faz a tela ser o que ela é: sem ele `skuSearch.query`
          nunca muda, `selected` fica null para sempre e o botão "Vincular"
          nasce desabilitado — a tela inteira vira leitura. Ele foi apagado sem
          querer em D-284, junto com os `style` inline que a fatia trocava por
          classe.
        */}
        <div>
          <label style={labelStyle} htmlFor="manual-link-sku">
            SKU de destino
          </label>
          <input
            className="sb-input sb-input-full"
            id="manual-link-sku"
            value={skuSearch.query}
            placeholder="buscar SKU…"
            onChange={(event) => {
              setDone(null);
              void skuSearch.search(event.target.value);
            }}
          />
        </div>
      </div>

      {skuSearch.results.length > 0 && skuSearch.selected === null && (
        <ul style={{ listStyle: "none", margin: "var(--sb-space-2) 0 0", padding: 0, display: "flex", flexWrap: "wrap", gap: "0.375rem" }}>
          {skuSearch.results.map((sku) => (
            <li key={sku.id}>
              <button
                className="sb-menu-item"
                type="button"
                onClick={() => {
                  skuSearch.select(sku);
                }}
              >
                {sku.sku}
                {sku.title !== null && <span style={{ color: "var(--sb-text-soft)" }}> · {sku.title}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}

      <div style={{ marginTop: "var(--sb-space-3)", display: "flex", alignItems: "center", gap: "var(--sb-space-2)" }}>
        <button
          className="sb-button sb-button-primary"
          type="button"
          disabled={busy || skuSearch.selected === null || itemId.trim() === ""}
          onClick={() => {
            void submit();
          }}
        >
          {busy ? "Vinculando…" : "Vincular"}
        </button>

        {skuSearch.selected !== null && (
          <span style={{ fontSize: "0.8125rem", color: "var(--sb-text-soft)" }}>
            → SKU <strong>{skuSearch.selected.sku}</strong>
          </span>
        )}
      </div>

      {(error ?? skuSearch.error) !== null && (
        <p role="alert" style={{ margin: "var(--sb-space-2) 0 0", fontSize: "0.8125rem", color: "var(--sb-danger)" }}>
          {error ?? skuSearch.error}
        </p>
      )}

      {done !== null && (
        <p role="status" style={{ margin: "var(--sb-space-2) 0 0", fontSize: "0.8125rem", color: "var(--sb-text-soft)" }}>
          {done}
        </p>
      )}
    </section>
  );
}
