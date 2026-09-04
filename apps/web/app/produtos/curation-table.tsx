"use client";

import Link from "next/link";
import { useState, useTransition, type ReactNode } from "react";

import { TOM } from "../../components/tone";
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
 *
 * ## Composição (auditoria de fidelidade)
 *
 * O frame `ProductsCuration` é um cartão cujo CABEÇALHO é a barra de lote:
 * "Selecionar Todos" à esquerda; à direita a contagem e DUAS ações agrupadas —
 * "Classificar Estoque ⌄" e "Definir Marca" — esmaecidas até haver seleção.
 * Eram sete controles em fila. Agora as três decisões de estoque moram num
 * menu e a marca num campo com o seu botão; o vocabulário (É virtual / Não é
 * virtual / Limpar classificação / Aplicar marca / Limpar marca) é o mesmo, e
 * o e2e continua clicando pelos mesmos nomes.
 *
 * A tabela é a `.sb-table` do design system (consts inline de 12/14px saíram),
 * o estado é chip (`.sb-status` com o tom de `tone.ts`, como o `Badge` do
 * frame), o nome do produto é LINK para o dashboard do SKU (o destino que o
 * drawer do frame aponta — o drawer em si continua adiado), e a quinta coluna
 * do frame, "Anúncios", chegou com dado real (D-245).
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
  listing_count: number;
}

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

/**
 * "Tipo de Estoque" do frame: um chip por estado — `info` para o decidido,
 * `atencao` para o indefinido ("Requer revisão" no frame). O texto continua
 * dizendo tudo; o tom só reforça.
 */
function Classificacao({ row }: { row: CurationRow }): ReactNode {
  if (row.stock_is_virtual_set_at === null) {
    return (
      <span className="sb-status" style={TOM.atencao}>
        não classificado
      </span>
    );
  }

  return (
    <span className="sb-status" style={TOM.info}>
      {row.stock_is_virtual ? "estoque virtual" : "estoque físico"}
    </span>
  );
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
  cabecalho,
}: {
  organizationId: string;
  rows: CurationRow[];
  /** Alimenta o `<datalist>`: as marcas que já existem, vindas do summary. */
  marcasConhecidas: string[];
  /** A linha de contagens do cabeçalho do cartão ("retrato de … · N de M"). */
  cabecalho: string;
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

  /**
   * As três decisões de estoque, num menu só — o "Classificar Estoque ⌄" do
   * frame. Cada item abre o painel de conferência com a CONSEQUÊNCIA.
   */
  const decisoes = [
    {
      rotulo: "É virtual",
      decisao: "VIRTUAL",
      titulo: (n: number) => `Marcar ${formatCount(n)} SKU(s) como estoque virtual`,
      consequencia:
        "A Cobertura deixará de calcular dias para eles e não os acusará em ruptura — sem saldo real, um número ali seria resposta errada com cara de precisa.",
    },
    {
      rotulo: "Não é virtual",
      decisao: "FISICO",
      titulo: (n: number) => `Marcar ${formatCount(n)} SKU(s) como estoque físico`,
      consequencia: "Eles saem da fila de pendentes e a Cobertura volta a calcular dias normalmente para eles.",
    },
    {
      rotulo: "Limpar classificação",
      decisao: "INDEFINIDO",
      titulo: (n: number) => `Devolver ${formatCount(n)} SKU(s) para "não classificado"`,
      consequencia: "Eles voltam para a fila como se ninguém tivesse olhado. Nada é apagado além da decisão.",
    },
  ] as const;

  return (
    <section className="sb-panel" aria-label="Catálogo e ações em lote">
      <div className="sb-panel-head">
        <div style={{ minWidth: 0 }}>
          <h2>Catálogo</h2>
          <p>{cabecalho}</p>
        </div>
      </div>

      {/*
        A barra de lote é o cabeçalho do cartão, como no frame: seleção à
        esquerda; contagem e as duas ações à direita, esmaecidas sem seleção.
      */}
      <div className="sb-bulk-bar">
        <label className="sb-bulk-select">
          <input
            type="checkbox"
            aria-label="Selecionar esta página"
            checked={rows.length > 0 && ids.length === rows.length}
            onChange={(e) => {
              selecionarPagina(e.target.checked);
            }}
          />
          Selecionar todos
        </label>

        <span className="sb-bulk-count">{formatCount(ids.length)} selecionado(s)</span>

        <span className="sb-bulk-actions">
          {/*
            `<details>` fechado por clique fora não existe nativamente; o menu
            fecha quando um item é escolhido (o painel de conferência toma o
            lugar). É o mesmo `.sb-menu` dos filtros — só que com botões, porque
            aqui a escolha é estado do cliente, não URL.
          */}
          <details className="sb-menu">
            <summary className="sb-button sb-button-sm" aria-disabled={nada || emCurso}>
              Classificar estoque
              <span aria-hidden="true" className="sb-menu-chevron">
                ⌄
              </span>
            </summary>
            <div className="sb-menu-panel">
              {decisoes.map((d) => (
                <button
                  key={d.decisao}
                  type="button"
                  className="sb-menu-item"
                  disabled={nada || emCurso}
                  onClick={(e) => {
                    e.currentTarget.closest("details")?.removeAttribute("open");
                    setPendente({
                      tipo: "classificar",
                      decisao: d.decisao,
                      rotulo: d.titulo(ids.length),
                      consequencia: d.consequencia,
                    });
                  }}
                >
                  {d.rotulo}
                </button>
              ))}
            </div>
          </details>

          <input
            list="marcas-conhecidas"
            className="sb-input sb-input-sm"
            value={marca}
            onChange={(e) => {
              setMarca(e.target.value);
            }}
            placeholder="Marca do fornecedor"
            aria-label="Marca do fornecedor"
          />
          <datalist id="marcas-conhecidas">
            {marcasConhecidas.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>

          <button
            type="button"
            className="sb-button sb-button-sm"
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
            className="sb-button sb-button-sm"
            style={{ color: "var(--sb-danger)" }}
            disabled={nada || emCurso}
            onClick={() => {
              // window.confirm APENAS aqui: é a única ação que apaga trabalho
              // humano em vez de substituí-lo.
              if (!window.confirm(`Limpar a marca de ${formatCount(ids.length)} SKU(s)? Isso apaga o preenchimento.`)) {
                return;
              }

              aplicar({ tipo: "marca", marca: "", rotulo: "", consequencia: "" }, ids, true);
            }}
          >
            Limpar marca
          </button>
        </span>
      </div>

      {excedeu && (
        <p role="alert" className="sb-panel-body" style={{ color: "var(--sb-danger)", fontSize: "0.6875rem" }}>
          Seleção acima de {formatCount(MAX_SELECAO)} — reduza antes de aplicar.
        </p>
      )}

      {pendente !== null && (
        // O painel de conferência: borda esquerda no tom de atenção, como o
        // cartão de diagnóstico do design system — e não uma caixa amarela
        // inteira. O botão de confirmar é o primário do sistema.
        <div
          role="dialog"
          aria-label="Confirmar"
          className="sb-panel-body"
          style={{ borderLeft: "4px solid var(--sb-accent)", background: "var(--sb-bg-soft)" }}
        >
          <strong style={{ display: "block", marginBottom: "0.25rem", fontSize: "0.75rem" }}>{pendente.rotulo}</strong>
          <p style={{ margin: "0 0 var(--sb-space-2)", fontSize: "0.6875rem", color: "var(--sb-text-soft)" }}>
            {pendente.consequencia}
          </p>
          <div style={{ display: "flex", gap: "var(--sb-space-2)" }}>
            <button
              type="button"
              className="sb-button sb-button-primary"
              disabled={emCurso}
              onClick={() => {
                aplicar(pendente, ids, true);
              }}
            >
              {emCurso ? "Aplicando…" : "Confirmar"}
            </button>
            <button
              type="button"
              className="sb-button"
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
          className="sb-panel-body"
          style={{
            margin: 0,
            background: resultado.erro ? "var(--sb-danger-soft)" : "var(--sb-success-soft)",
            color: resultado.erro ? "var(--sb-danger-ink)" : "var(--sb-success)",
            fontSize: "0.6875rem",
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
              className="sb-button sb-button-sm"
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

      {rows.length === 0 ? (
        <p className="sb-empty">Nenhum SKU neste recorte. Tire um filtro ou busque outro termo.</p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="sb-table" style={{ minWidth: "62rem" }}>
            <thead>
              <tr>
                <th style={{ width: "2.5rem" }} />
                <th>Produto / SKU</th>
                {/* NUNCA "Marca": `brand` guarda a CATEGORIA do UpSeller (D-129). */}
                <th>Categoria (ERP)</th>
                <th>Marca do fornecedor</th>
                <th className="sb-num">Saldo no ERP</th>
                <th className="sb-num">Vendas 90d</th>
                <th className="sb-num">Anúncios</th>
                <th>Sugestão</th>
                <th>Classificação</th>
              </tr>
            </thead>

            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.sku_id}
                  style={row.decision_diverges_from_signature ? { background: "var(--sb-accent-soft)" } : undefined}
                >
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Selecionar ${row.sku}`}
                      checked={selecionados.has(row.sku_id)}
                      onChange={() => {
                        alternar(row.sku_id);
                      }}
                    />
                  </td>
                  <td>
                    {/* Título em cima e SKU em monoespaçado embaixo — a célula
                        "Produto / SKU" do frame, clicável: leva ao dashboard do
                        SKU, o destino que o drawer do frame aponta. */}
                    <Link className="sb-entity" href={`/skus/${row.sku_id}`}>
                      {row.title ?? row.sku}
                    </Link>
                    <span style={{ display: "block", fontFamily: "var(--sb-mono)", fontSize: "0.625rem", color: "var(--sb-text-soft)" }}>
                      SKU {row.sku}
                    </span>
                    {row.decision_diverges_from_signature && (
                      <div style={{ color: "var(--sb-accent-ink)", fontSize: "0.625rem" }}>
                        Revisar: o ERP não parece mais sentinela
                      </div>
                    )}
                  </td>
                  <td style={{ color: "var(--sb-text-soft)" }}>{row.brand ?? "—"}</td>
                  <td>
                    {row.supplier_brand ?? (
                      // "Requer revisão" no frame: marca ausente é chip de atenção.
                      <span className="sb-status" style={TOM.atencao}>
                        a preencher
                      </span>
                    )}
                    {row.supplier_brand !== null && (
                      <div style={{ color: "var(--sb-text-soft)", fontSize: "0.625rem" }}>
                        {row.supplier_brand_source === "MANUAL" ? "manual" : "derivada"}
                      </div>
                    )}
                  </td>
                  <td className="sb-num">
                    {row.snapshot_available === null ? "—" : formatCount(row.snapshot_available)}
                  </td>
                  <td className="sb-num">{formatCount(row.units_sold_90d)}</td>
                  <td className="sb-num">{formatCount(row.listing_count)}</td>
                  <td>
                    <Sugestao row={row} />
                  </td>
                  <td>
                    <Classificacao row={row} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
