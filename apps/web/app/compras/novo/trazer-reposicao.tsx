"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";

import { TOM } from "../../../components/tone";
import { formatCount, formatCurrency } from "../../../lib/format";
import { createClient } from "../../../lib/supabase/browser";

import { ESTADO_SUGESTAO, lerSugestoes, type SugestaoItem } from "./sugestoes";

/**
 * "Trazer da reposição" (D-371): os itens a comprar de UMA marca, com a
 * quantidade que a Cobertura e reposição sugere, entram no pedido de uma vez.
 *
 * O dono pediu por FORNECEDOR, "que é querendo ou não a marca do produto".
 * O modelo não liga fornecedor a SKU (D-174), então o recorte é a MARCA do
 * catálogo — pré-selecionada quando o nome do fornecedor bate com ela
 * (`marcaDoFornecedor`), e sempre trocável. Dois recortes: comprar agora
 * (ruptura + compra urgente) e tudo com sugestão positiva.
 *
 * Antes de adicionar, a prévia diz quantos SKUs, unidades e quanto custa pelo
 * custo cadastrado — sem custo fica fora da soma e contado. SKU que já está no
 * pedido não entra de novo.
 */

type Recorte = "comprar_agora" | "com_sugestao";

export function TrazerReposicao({
  organizationId,
  marcas,
  marcaSugerida,
  skusNoPedido,
  onAdicionar,
  onFechar,
}: {
  organizationId: string;
  marcas: readonly string[];
  marcaSugerida: string | null;
  skusNoPedido: ReadonlySet<string>;
  onAdicionar: (linhas: readonly SugestaoItem[], marca: string) => void;
  onFechar: () => void;
}): ReactNode {
  const [marca, setMarca] = useState(marcaSugerida ?? "");
  const [recorte, setRecorte] = useState<Recorte>("comprar_agora");
  const [lendo, setLendo] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [resultado, setResultado] = useState<{ total: number; linhas: readonly SugestaoItem[] } | null>(null);

  // Trocou o fornecedor com o painel aberto: a marca acompanha, se houver.
  useEffect(() => {
    if (marcaSugerida !== null) setMarca(marcaSugerida);
  }, [marcaSugerida]);

  // Recorte novo pede leitura nova: a prévia antiga não vale mais.
  useEffect(() => {
    setResultado(null);
    setErro(null);
  }, [marca, recorte]);

  async function buscar(): Promise<void> {
    if (marca === "") return;

    setLendo(true);
    setErro(null);

    const { data, error } = await createClient().rpc("get_purchase_order_suggestions", {
      p_organization_id: organizationId,
      p_supplier_brand: marca,
      p_scope: recorte,
    });

    setLendo(false);

    const lidas = error === null ? lerSugestoes(data) : null;

    if (lidas === null) {
      setErro("Não foi possível ler a reposição agora — tente de novo.");

      return;
    }

    setResultado(lidas);
  }

  const novas = resultado?.linhas.filter((l) => !skusNoPedido.has(l.skuId)) ?? [];
  const jaNoPedido = (resultado?.linhas.length ?? 0) - novas.length;
  const unidades = novas.reduce((acc, l) => acc + (l.suggestedQuantity ?? 0), 0);
  const comCusto = novas.filter((l) => l.purchaseCost !== null && l.purchaseCost > 0);
  const semCusto = novas.length - comCusto.length;
  const valor = comCusto.reduce((acc, l) => acc + (l.suggestedQuantity ?? 0) * (l.purchaseCost ?? 0), 0);

  return (
    <div className="sb-pco-colar sb-pco-trazer" role="region" aria-label="Trazer itens da reposição">
      <div className="sb-pco-trazer-filtros">
        <label className="sb-form-campo" htmlFor="pco-trazer-marca">
          <span>Marca</span>
          <select
            id="pco-trazer-marca"
            className="sb-input sb-input-full"
            value={marca}
            onChange={(event) => {
              setMarca(event.target.value);
            }}
          >
            <option value="">Escolha a marca…</option>
            {marcas.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          {marcaSugerida !== null && marca === marcaSugerida && <small>a marca com o nome do fornecedor escolhido</small>}
        </label>

        <fieldset className="sb-pco-trazer-recorte">
          <legend>O que trazer</legend>
          <label>
            <input
              type="radio"
              name="pco-trazer-recorte"
              checked={recorte === "comprar_agora"}
              onChange={() => {
                setRecorte("comprar_agora");
              }}
            />
            <span>
              <b>Comprar agora</b>
              <small>em ruptura ou compra urgente</small>
            </span>
          </label>
          <label>
            <input
              type="radio"
              name="pco-trazer-recorte"
              checked={recorte === "com_sugestao"}
              onChange={() => {
                setRecorte("com_sugestao");
              }}
            />
            <span>
              <b>Tudo com sugestão</b>
              <small>qualquer estado com quantidade a comprar</small>
            </span>
          </label>
        </fieldset>

        <button
          type="button"
          className="sb-button sb-pco-trazer-buscar"
          disabled={marca === "" || lendo}
          onClick={() => {
            void buscar();
          }}
        >
          {lendo ? "Lendo a reposição…" : "Ver sugestões"}
        </button>
      </div>

      {erro !== null && (
        <p role="alert" className="sb-pco-aviso">
          {erro}
        </p>
      )}

      {resultado !== null && resultado.linhas.length === 0 && (
        <p className="sb-pco-nota" role="status">
          Nada a comprar de <b>{marca}</b> neste recorte.{" "}
          {recorte === "comprar_agora" ? "Experimente “Tudo com sugestão”." : "A marca está coberta ou sem configuração de reposição."}
        </p>
      )}

      {resultado !== null && resultado.linhas.length > 0 && (
        <>
          <p className="sb-pco-trazer-resumo" role="status">
            <b>{formatCount(novas.length)} SKU(s)</b> · {formatCount(unidades)} un ·{" "}
            <b>{formatCurrency(Math.round(valor * 100) / 100)}</b> pelo custo cadastrado
            {semCusto > 0 && <em> · {formatCount(semCusto)} sem custo fora da soma</em>}
            {jaNoPedido > 0 && <em> · {formatCount(jaNoPedido)} já no pedido (não entram de novo)</em>}
            {resultado.total > resultado.linhas.length && (
              <em> · mostrando os {formatCount(resultado.linhas.length)} mais prioritários</em>
            )}
          </p>

          <ul className="sb-pco-trazer-lista">
            {resultado.linhas.map((l) => {
              const estado = l.state === null ? null : ESTADO_SUGESTAO[l.state];
              const repetido = skusNoPedido.has(l.skuId);

              return (
                <li key={l.skuId} className={repetido ? "sb-pco-trazer-item sb-pco-trazer-item-repetido" : "sb-pco-trazer-item"}>
                  <span className="sb-pco-trazer-sku">
                    <b>{l.sku}</b>
                    <small>{l.title ?? "sem título"}</small>
                  </span>
                  {estado !== undefined && estado !== null && (
                    <span className="sb-status" style={TOM[estado.tom]}>
                      {estado.rotulo}
                    </span>
                  )}
                  <span className="sb-pco-trazer-qtd">
                    {repetido ? "já no pedido" : `${formatCount(l.suggestedQuantity)} un`}
                  </span>
                </li>
              );
            })}
          </ul>

          <div className="sb-pco-colar-acoes">
            <Link className="sb-pco-link-discreto" href={`/reposicao?marca=${encodeURIComponent(marca)}`} target="_blank">
              Ver a conta na reposição ↗
            </Link>
            <span className="sb-pco-trazer-espaco" />
            <button type="button" className="sb-button" onClick={onFechar}>
              Fechar
            </button>
            <button
              type="button"
              className="sb-button sb-button-primary"
              disabled={novas.length === 0}
              onClick={() => {
                onAdicionar(novas, marca);
              }}
            >
              Adicionar {formatCount(novas.length)} ao pedido
            </button>
          </div>
        </>
      )}

      {resultado === null && (
        <div className="sb-pco-colar-acoes">
          <button type="button" className="sb-button" onClick={onFechar}>
            Fechar
          </button>
        </div>
      )}
    </div>
  );
}
