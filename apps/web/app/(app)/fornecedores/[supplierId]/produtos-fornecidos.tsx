"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

import { formatCount, formatCurrency, formatDay } from "../../../../lib/format";
import { createClient } from "../../../../lib/supabase/browser";
import type { ProdutoFornecido } from "../../../../lib/supplier-skus";
import { removerProdutoFornecido, salvarProdutoFornecido } from "../actions";

/**
 * Produtos fornecidos (D-723): o vínculo EXPLÍCITO entre o fornecedor e o SKU —
 * nunca deduzido da marca (D-129). Nada aqui é obrigatório além do SKU: o
 * código no fornecedor, o custo, o mínimo, o múltiplo e o prazo entram quando a
 * empresa os tiver. O mínimo e o múltiplo ajustam a quantidade recomendada na
 * revisão do pedido deste fornecedor.
 */

interface SkuEncontrado {
  readonly id: string;
  readonly sku: string;
  readonly title: string | null;
}

function numeroOuNulo(valor: string): number | null {
  const t = valor.trim().replace(",", ".");

  if (t === "") return null;

  const n = Number(t);

  return Number.isFinite(n) ? n : Number.NaN;
}

/** Tira do termo o que quebraria o filtro `or` do PostgREST. */
function termoSeguro(valor: string): string {
  return valor.replace(/[,()%*\\]/g, " ").trim();
}

export function ProdutosFornecidos({
  supplierId,
  produtos,
  total,
  podeEditar,
}: {
  supplierId: string;
  produtos: readonly ProdutoFornecido[];
  total: number;
  podeEditar: boolean;
}): ReactNode {
  const router = useRouter();
  const [aberto, setAberto] = useState(false);
  const [busca, setBusca] = useState("");
  const [encontrados, setEncontrados] = useState<readonly SkuEncontrado[]>([]);
  const [sku, setSku] = useState<SkuEncontrado | null>(null);
  const [codigo, setCodigo] = useState("");
  const [custo, setCusto] = useState("");
  const [moeda, setMoeda] = useState("BRL");
  const [minimo, setMinimo] = useState("");
  const [multiplo, setMultiplo] = useState("");
  const [prazo, setPrazo] = useState("");
  const [preferido, setPreferido] = useState(false);
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  function editar(p: ProdutoFornecido): void {
    setSku({ id: p.skuId, sku: p.sku, title: p.title });
    setCodigo(p.supplierCode ?? "");
    setCusto(p.unitCost === null ? "" : String(p.unitCost));
    setMoeda(p.currency);
    setMinimo(p.minimumOrderQuantity === null ? "" : String(p.minimumOrderQuantity));
    setMultiplo(p.packMultiple === null ? "" : String(p.packMultiple));
    setPrazo(p.leadTimeDays === null ? "" : String(p.leadTimeDays));
    setPreferido(p.isPreferred);
    setErro(null);
    setAberto(true);
  }

  async function buscar(): Promise<void> {
    const termo = termoSeguro(busca);

    if (termo.length < 2) {
      setEncontrados([]);

      return;
    }

    const { data, error } = await createClient()
      .from("skus")
      .select("id, sku, title")
      .or(`sku.ilike.%${termo}%,title.ilike.%${termo}%`)
      .order("sku")
      .limit(10);

    setEncontrados(error === null ? data : []);
  }

  async function salvar(): Promise<void> {
    if (sku === null) {
      setErro("Escolha o SKU.");

      return;
    }

    const valores = [numeroOuNulo(custo), numeroOuNulo(minimo), numeroOuNulo(multiplo), numeroOuNulo(prazo)];

    if (valores.some((v) => v !== null && (Number.isNaN(v) || v < 0))) {
      setErro("Custo, mínimo, múltiplo e prazo precisam ser números positivos.");

      return;
    }

    setBusy(true);
    setErro(null);

    const r = await salvarProdutoFornecido(supplierId, {
      skuId: sku.id,
      supplierCode: codigo.trim() === "" ? null : codigo.trim(),
      unitCost: valores[0] ?? null,
      currency: moeda.trim().toUpperCase() || "BRL",
      minimumOrderQuantity: valores[1] ?? null,
      packMultiple: valores[2] ?? null,
      leadTimeDays: valores[3] ?? null,
      isPreferred: preferido,
      notes: null,
    });

    setBusy(false);

    if (!r.ok) {
      setErro(r.mensagem);

      return;
    }

    setSku(null);
    setBusca("");
    setEncontrados([]);
    setCodigo("");
    setCusto("");
    setMinimo("");
    setMultiplo("");
    setPrazo("");
    setPreferido(false);
    setAberto(false);
    router.refresh();
  }

  return (
    <div className="sb-forn-produtos">
      {produtos.length === 0 ? (
        <p className="sb-empty">
          Nenhum produto cadastrado para este fornecedor. O vínculo é explícito: a marca do SKU nunca vira fornecedor
          sozinha.
        </p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="sb-table">
            <thead>
              <tr>
                <th>SKU</th>
                <th>Código no fornecedor</th>
                <th className="sb-num">Custo</th>
                <th className="sb-num">Mínimo</th>
                <th className="sb-num">Múltiplo</th>
                <th className="sb-num">Prazo</th>
                <th className="sb-num">Comprado</th>
                {podeEditar && <th aria-label="Ações" />}
              </tr>
            </thead>
            <tbody>
              {produtos.map((p) => (
                <tr key={p.id}>
                  <td className="sb-mono">
                    <Link prefetch={false} href={`/skus/${p.skuId}`}>
                      {p.sku}
                    </Link>
                    {p.isPreferred && <span className="sb-forn-preferido"> · preferido</span>}
                    {p.isDiscontinued && <span className="sb-forn-preferido"> · descontinuado</span>}
                    {p.title !== null && <span className="sb-pod-item-title">{p.title}</span>}
                  </td>
                  <td>{p.supplierCode ?? "—"}</td>
                  <td className="sb-num">
                    {p.unitCost === null ? "—" : p.currency === "BRL" ? formatCurrency(p.unitCost) : `${p.currency} ${String(p.unitCost)}`}
                    {p.cadastroCost !== null && p.unitCost !== null && p.currency === "BRL" && p.cadastroCost !== p.unitCost && (
                      <span className="sb-pod-item-title">cadastro {formatCurrency(p.cadastroCost)}</span>
                    )}
                  </td>
                  <td className="sb-num">{p.minimumOrderQuantity === null ? "—" : formatCount(p.minimumOrderQuantity)}</td>
                  <td className="sb-num">{p.packMultiple === null ? "—" : formatCount(p.packMultiple)}</td>
                  <td className="sb-num">{p.leadTimeDays === null ? "—" : `${formatCount(p.leadTimeDays)} d`}</td>
                  <td className="sb-num">
                    {p.unidadesCompradas === null ? "—" : `${formatCount(p.unidadesCompradas)} un`}
                    {p.ultimaCompra !== null && <span className="sb-pod-item-title">último em {formatDay(p.ultimaCompra)}</span>}
                  </td>
                  {podeEditar && (
                    <td className="sb-num" style={{ whiteSpace: "nowrap" }}>
                      <button
                        type="button"
                        className="sb-button"
                        onClick={() => {
                          editar(p);
                        }}
                      >
                        Editar
                      </button>{" "}
                      <button
                        type="button"
                        className="sb-button"
                        onClick={() => {
                          void removerProdutoFornecido(supplierId, p.id).then((r) => {
                            if (!r.ok) setErro(r.mensagem);
                            else router.refresh();
                          });
                        }}
                      >
                        Remover
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {total > produtos.length && (
            <p className="sb-rep-rodape">
              Mostrando {formatCount(produtos.length)} de {formatCount(total)} produtos.
            </p>
          )}
        </div>
      )}

      {podeEditar && !aberto && (
        <button
          type="button"
          className="sb-button"
          onClick={() => {
            setAberto(true);
          }}
        >
          Cadastrar produto fornecido
        </button>
      )}

      {podeEditar && aberto && (
        <form
          className="sb-pod-custo-form sb-forn-produto-form"
          onSubmit={(e) => {
            e.preventDefault();
            void salvar();
          }}
        >
          {sku === null ? (
            <div className="sb-forn-busca">
              <label className="sb-form-campo">
                <span>SKU</span>
                <input
                  className="sb-input"
                  aria-label="Buscar SKU pelo código ou nome"
                  value={busca}
                  placeholder="código ou nome"
                  onChange={(e) => {
                    setBusca(e.target.value);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void buscar();
                    }
                  }}
                />
              </label>
              <button
                type="button"
                className="sb-button"
                onClick={() => {
                  void buscar();
                }}
              >
                Buscar
              </button>
              {encontrados.length > 0 && (
                <ul className="sb-forn-resultados">
                  {encontrados.map((s) => (
                    <li key={s.id}>
                      <button
                        type="button"
                        className="sb-button"
                        onClick={() => {
                          setSku(s);
                          setEncontrados([]);
                        }}
                      >
                        {s.sku}
                        {s.title !== null && <small> · {s.title}</small>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <p className="sb-forn-escolhido">
              <b>{sku.sku}</b>
              {sku.title !== null && ` · ${sku.title}`}{" "}
              <button
                type="button"
                className="sb-button"
                onClick={() => {
                  setSku(null);
                }}
              >
                Trocar
              </button>
            </p>
          )}

          <label className="sb-form-campo">
            <span>Código no fornecedor</span>
            <input className="sb-input" maxLength={80} value={codigo} onChange={(e) => { setCodigo(e.target.value); }} />
          </label>
          <label className="sb-form-campo">
            <span>Custo</span>
            <input className="sb-input" inputMode="decimal" value={custo} onChange={(e) => { setCusto(e.target.value); }} />
          </label>
          <label className="sb-form-campo">
            <span>Moeda</span>
            <input className="sb-input sb-pod-moeda" maxLength={3} value={moeda} onChange={(e) => { setMoeda(e.target.value.toUpperCase()); }} />
          </label>
          <label className="sb-form-campo">
            <span>Mínimo (un)</span>
            <input className="sb-input" inputMode="decimal" value={minimo} onChange={(e) => { setMinimo(e.target.value); }} />
          </label>
          <label className="sb-form-campo">
            <span>Múltiplo</span>
            <input className="sb-input" inputMode="decimal" value={multiplo} onChange={(e) => { setMultiplo(e.target.value); }} />
          </label>
          <label className="sb-form-campo">
            <span>Prazo (dias)</span>
            <input className="sb-input" inputMode="numeric" value={prazo} onChange={(e) => { setPrazo(e.target.value); }} />
          </label>
          <label className="sb-forn-check">
            <input type="checkbox" checked={preferido} onChange={(e) => { setPreferido(e.target.checked); }} />
            Fornecedor preferido deste SKU
          </label>
          <button type="submit" className="sb-button sb-button-primary" disabled={busy || sku === null}>
            {busy ? "Salvando…" : "Salvar produto"}
          </button>
          <button
            type="button"
            className="sb-button"
            onClick={() => {
              setAberto(false);
              setErro(null);
            }}
          >
            Fechar
          </button>
        </form>
      )}

      {erro !== null && (
        <p role="alert" className="sb-note sb-note-perigo">
          {erro}
        </p>
      )}
    </div>
  );
}
