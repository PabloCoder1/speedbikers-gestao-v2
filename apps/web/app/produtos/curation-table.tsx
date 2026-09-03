"use client";

import { useState, useTransition, type ReactNode } from "react";

import { formatCount } from "../../lib/format";
import { describeOutcome, MAX_SELECAO, type CurationOutcome } from "../../lib/sku-curation";
import { classifySkus, setSupplierBrand } from "./actions";

/**
 * A mesa de trabalho da curadoria (D-133).
 *
 * Só a SELEÇÃO e a confirmação vivem no cliente. Filtro, ordenação, paginação
 * e contagem ficam na URL e no Postgres — estado de filtro em React mataria os
 * Filtros Salvos e o link de ida vindo de `/cobertura`.
 *
 * Toda escrita passa por um PAINEL DE CONFERÊNCIA que diz a CONSEQUÊNCIA, não
 * só a contagem. É o fluxo canônico das importações do projeto (analisar →
 * conferir → aplicar), e aqui ele existe porque D-127 escreveu que a sugestão
 * é confirmada por gente, NUNCA aplicada sozinha.
 */

export interface CurationRow {
  sku_id: string;
  sku: string;
  title: string | null;
  brand: string | null;
  supplier_brand: string | null;
  supplier_brand_source: string | null;
  stock_is_virtual: boolean;
  stock_is_virtual_set_at: string | null;
  snapshot_available: number | null;
  has_sentinel_signature: boolean | null;
  units_sold_90d: number;
  decision_diverges_from_signature: boolean;
  total_count: number;
}

const th: React.CSSProperties = {
  textAlign: "left",
  padding: "0.5rem 0.75rem",
  borderBottom: "1px solid var(--sb-border)",
  fontSize: "0.75rem",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  color: "var(--sb-text-soft)",
  whiteSpace: "nowrap",
};

const td: React.CSSProperties = {
  padding: "0.5rem 0.75rem",
  borderBottom: "1px solid var(--sb-border)",
  fontSize: "0.875rem",
  verticalAlign: "top",
};

const tdNumber: React.CSSProperties = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" };

const botao: React.CSSProperties = {
  padding: "0.375rem 0.75rem",
  borderRadius: "var(--sb-radius)",
  border: "1px solid var(--sb-border)",
  background: "var(--sb-surface)",
  fontSize: "0.8125rem",
  cursor: "pointer",
};

/** Cor nunca é a única pista — o texto sempre acompanha (status-pill.tsx). */
function Sugestao({ row }: { row: CurationRow }): ReactNode {
  if (row.has_sentinel_signature === null) {
    return <span style={{ color: "var(--sb-text-soft)" }}>Sem retrato do ERP</span>;
  }

  if (row.has_sentinel_signature) {
    return (
      <span style={{ color: "var(--sb-accent-ink)" }}>
        Parece sentinela ({formatCount(row.snapshot_available ?? 0)})
      </span>
    );
  }

  return <span>Não parece ({formatCount(row.snapshot_available ?? 0)})</span>;
}

function Classificacao({ row }: { row: CurationRow }): ReactNode {
  if (row.stock_is_virtual_set_at === null) {
    return <span style={{ color: "var(--sb-text-soft)" }}>não classificado</span>;
  }

  return <strong>{row.stock_is_virtual ? "estoque virtual" : "estoque físico"}</strong>;
}

interface Pendente {
  readonly tipo: "classificar" | "marca";
  readonly decisao?: string;
  readonly marca?: string;
  readonly rotulo: string;
  readonly consequencia: string;
}

export function CurationTable({
  organizationId,
  rows,
  marcasConhecidas,
}: {
  organizationId: string;
  rows: CurationRow[];
  /** Alimenta o `<datalist>`: as marcas que já existem, vindas do summary. */
  marcasConhecidas: string[];
}): ReactNode {
  const [selecionados, setSelecionados] = useState<Set<string>>(new Set());
  const [marca, setMarca] = useState("");
  const [pendente, setPendente] = useState<Pendente | null>(null);
  const [resultado, setResultado] = useState<{ texto: string; erro: boolean; desfazer: string[] } | null>(null);
  const [emCurso, startTransition] = useTransition();

  const ids = [...selecionados];
  const nada = ids.length === 0;
  const excedeu = ids.length > MAX_SELECAO;

  function alternar(id: string): void {
    setSelecionados((antes) => {
      const proximo = new Set(antes);

      if (proximo.has(id)) proximo.delete(id);
      else proximo.add(id);

      return proximo;
    });
  }

  function selecionarPagina(marcar: boolean): void {
    setSelecionados(marcar ? new Set(rows.map((r) => r.sku_id)) : new Set());
  }

  function aplicar(acao: Pendente, alvos: string[], limpaSelecao: boolean): void {
    startTransition(() => {
      void (async () => {
        const r =
          acao.tipo === "classificar"
            ? await classifySkus(organizationId, alvos, acao.decisao ?? "")
            : await setSupplierBrand(organizationId, alvos, acao.marca ?? "");

        setPendente(null);

        if (!r.ok || r.outcome === null) {
          setResultado({ texto: r.message ?? "Não foi possível concluir a ação.", erro: true, desfazer: [] });

          return;
        }

        const outcome: CurationOutcome = r.outcome;

        setResultado({
          texto: describeOutcome(outcome),
          erro: false,
          // Desfazer manda de volta APENAS o que MUDOU — nunca os enviados.
          // Mandar os enviados reverteria decisão que já era de outra pessoa.
          desfazer: acao.tipo === "classificar" ? outcome.changedIds : [],
        });

        if (limpaSelecao) setSelecionados(new Set());
      })();
    });
  }

  const marcaNormalizada = marca.replace(/\s+/g, " ").trim().toUpperCase();

  return (
    <>
      <div
        style={{
          position: "sticky",
          top: 0,
          zIndex: 1,
          background: "var(--sb-surface)",
          borderBottom: "1px solid var(--sb-border)",
          padding: "var(--sb-space-2) 0",
          marginBottom: "var(--sb-space-2)",
          display: "flex",
          gap: "var(--sb-space-2)",
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <strong style={{ fontSize: "0.875rem" }}>{formatCount(ids.length)} selecionado(s)</strong>

        <button
          type="button"
          style={botao}
          disabled={nada || emCurso}
          onClick={() => {
            setPendente({
              tipo: "classificar",
              decisao: "VIRTUAL",
              rotulo: `Marcar ${formatCount(ids.length)} SKU(s) como estoque virtual`,
              consequencia:
                "A Cobertura deixará de calcular dias para eles e não os acusará em ruptura — sem saldo real, um número ali seria resposta errada com cara de precisa.",
            });
          }}
        >
          É virtual
        </button>

        <button
          type="button"
          style={botao}
          disabled={nada || emCurso}
          onClick={() => {
            setPendente({
              tipo: "classificar",
              decisao: "FISICO",
              rotulo: `Marcar ${formatCount(ids.length)} SKU(s) como estoque físico`,
              consequencia:
                "Eles saem da fila de pendentes e a Cobertura volta a calcular dias normalmente para eles.",
            });
          }}
        >
          Não é virtual
        </button>

        <button
          type="button"
          style={botao}
          disabled={nada || emCurso}
          onClick={() => {
            setPendente({
              tipo: "classificar",
              decisao: "INDEFINIDO",
              rotulo: `Devolver ${formatCount(ids.length)} SKU(s) para "não classificado"`,
              consequencia: "Eles voltam para a fila como se ninguém tivesse olhado. Nada é apagado além da decisão.",
            });
          }}
        >
          Limpar classificação
        </button>

        <span style={{ width: "1px", height: "1.5rem", background: "var(--sb-border)" }} />

        <input
          list="marcas-conhecidas"
          value={marca}
          onChange={(e) => {
            setMarca(e.target.value);
          }}
          placeholder="Marca do fornecedor"
          style={{
            padding: "0.375rem 0.5rem",
            borderRadius: "var(--sb-radius)",
            border: "1px solid var(--sb-border)",
            fontSize: "0.875rem",
            minWidth: "12rem",
          }}
        />
        <datalist id="marcas-conhecidas">
          {marcasConhecidas.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>

        <button
          type="button"
          style={botao}
          disabled={nada || emCurso || marcaNormalizada === ""}
          onClick={() => {
            setPendente({
              tipo: "marca",
              marca: marcaNormalizada,
              rotulo: `Atribuir a marca ${marcaNormalizada} a ${formatCount(ids.length)} SKU(s)`,
              consequencia:
                "A marca passa a valer como decisão humana (MANUAL) e não será sobrescrita por nenhuma re-derivação automática.",
            });
          }}
        >
          Aplicar marca
        </button>

        <button
          type="button"
          style={{ ...botao, color: "var(--sb-danger)" }}
          disabled={nada || emCurso}
          onClick={() => {
            // window.confirm APENAS aqui: é a única ação que apaga trabalho
            // humano em vez de substituí-lo.
            if (!window.confirm(`Limpar a marca de ${formatCount(ids.length)} SKU(s)? Isso apaga o preenchimento.`)) {
              return;
            }

            aplicar(
              { tipo: "marca", marca: "", rotulo: "", consequencia: "" },
              ids,
              true,
            );
          }}
        >
          Limpar marca
        </button>
      </div>

      {excedeu && (
        <p role="alert" style={{ color: "var(--sb-danger)", fontSize: "0.8125rem" }}>
          Seleção acima de {formatCount(MAX_SELECAO)} — reduza antes de aplicar.
        </p>
      )}

      {pendente !== null && (
        <div
          role="dialog"
          aria-label="Confirmar"
          style={{
            border: "1px solid var(--sb-accent-ink)",
            borderRadius: "var(--sb-radius)",
            background: "var(--sb-accent-soft)",
            padding: "var(--sb-space-3)",
            marginBottom: "var(--sb-space-3)",
          }}
        >
          <strong style={{ display: "block", marginBottom: "0.25rem" }}>{pendente.rotulo}</strong>
          <p style={{ margin: "0 0 var(--sb-space-2)", fontSize: "0.875rem" }}>{pendente.consequencia}</p>
          <div style={{ display: "flex", gap: "var(--sb-space-2)" }}>
            <button
              type="button"
              style={{ ...botao, background: "var(--sb-accent-ink)", color: "#fff", borderColor: "var(--sb-accent-ink)" }}
              disabled={emCurso}
              onClick={() => {
                aplicar(pendente, ids, true);
              }}
            >
              {emCurso ? "Aplicando…" : "Confirmar"}
            </button>
            <button
              type="button"
              style={botao}
              disabled={emCurso}
              onClick={() => {
                setPendente(null);
              }}
            >
              Cancelar
            </button>
          </div>
        </div>
      )}

      {resultado !== null && (
        <p
          role="status"
          style={{
            margin: "0 0 var(--sb-space-3)",
            padding: "var(--sb-space-2)",
            borderRadius: "var(--sb-radius)",
            background: resultado.erro ? "var(--sb-danger-soft)" : "var(--sb-success-soft)",
            color: resultado.erro ? "var(--sb-danger-ink)" : "var(--sb-success)",
            fontSize: "0.875rem",
            display: "flex",
            gap: "var(--sb-space-2)",
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <span>{resultado.texto}</span>

          {resultado.desfazer.length > 0 && (
            <button
              type="button"
              style={botao}
              disabled={emCurso}
              onClick={() => {
                aplicar(
                  { tipo: "classificar", decisao: "INDEFINIDO", rotulo: "", consequencia: "" },
                  resultado.desfazer,
                  false,
                );
              }}
            >
              Desfazer
            </button>
          )}
        </p>
      )}

      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", width: "100%", minWidth: "62rem" }}>
          <thead>
            <tr>
              <th style={th}>
                <input
                  type="checkbox"
                  aria-label="Selecionar esta página"
                  checked={rows.length > 0 && ids.length === rows.length}
                  onChange={(e) => {
                    selecionarPagina(e.target.checked);
                  }}
                />
              </th>
              <th style={th}>SKU</th>
              {/* NUNCA "Marca": `brand` guarda a CATEGORIA do UpSeller (D-129). */}
              <th style={th}>Categoria (ERP)</th>
              <th style={th}>Marca do fornecedor</th>
              <th style={{ ...th, textAlign: "right" }}>Saldo no ERP</th>
              <th style={{ ...th, textAlign: "right" }}>Vendas 90d</th>
              <th style={th}>Sugestão</th>
              <th style={th}>Classificação</th>
            </tr>
          </thead>

          <tbody>
            {rows.map((row) => (
              <tr
                key={row.sku_id}
                style={row.decision_diverges_from_signature ? { background: "var(--sb-accent-soft)" } : undefined}
              >
                <td style={td}>
                  <input
                    type="checkbox"
                    aria-label={`Selecionar ${row.sku}`}
                    checked={selecionados.has(row.sku_id)}
                    onChange={() => {
                      alternar(row.sku_id);
                    }}
                  />
                </td>
                <td style={td}>
                  <span style={{ fontFamily: "ui-monospace, monospace" }}>{row.sku}</span>
                  {row.title !== null && (
                    <div style={{ color: "var(--sb-text-soft)", fontSize: "0.75rem" }}>{row.title}</div>
                  )}
                  {row.decision_diverges_from_signature && (
                    <div style={{ color: "var(--sb-accent-ink)", fontSize: "0.75rem" }}>
                      Revisar: o ERP não parece mais sentinela
                    </div>
                  )}
                </td>
                <td style={{ ...td, color: "var(--sb-text-soft)" }}>{row.brand ?? "—"}</td>
                <td style={td}>
                  {row.supplier_brand ?? <span style={{ color: "var(--sb-text-soft)" }}>a preencher</span>}
                  {row.supplier_brand !== null && (
                    <div style={{ color: "var(--sb-text-soft)", fontSize: "0.75rem" }}>
                      {row.supplier_brand_source === "MANUAL" ? "manual" : "derivada"}
                    </div>
                  )}
                </td>
                <td style={tdNumber}>
                  {row.snapshot_available === null ? "—" : formatCount(row.snapshot_available)}
                </td>
                <td style={tdNumber}>{formatCount(row.units_sold_90d)}</td>
                <td style={td}>
                  <Sugestao row={row} />
                </td>
                <td style={td}>
                  <Classificacao row={row} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
