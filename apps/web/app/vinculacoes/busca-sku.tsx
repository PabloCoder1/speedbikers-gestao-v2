"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { createClient } from "../../lib/supabase/browser";
import type { OpcaoSku } from "../../lib/vinculo-sugestao";

/**
 * A busca de SKU do popup de vincular (D-374), lida do navegador sob RLS
 * (Modelo A). Substitui `components/use-sku-search.ts`, que buscava a cada
 * tecla, sem descartar resposta atrasada e só pelo código.
 *
 * - código OU título, com espera de 220 ms entre teclas;
 * - resposta de uma busca já substituída é descartada (digitar rápido mostrava
 *   o resultado de "AB" depois do de "ABC");
 * - ↑/↓ percorrem, Enter escolhe, Esc limpa a lista;
 * - a lista fica NO FLUXO do popup, não flutuando: dentro de um modal que rola,
 *   uma lista absoluta seria cortada.
 */

/** Vírgula e parênteses quebram a sintaxe do `or=` do PostgREST. */
function termoSeguro(valor: string): string {
  return valor.replace(/[,()%*\\]/g, " ").trim();
}

export function BuscaSku({
  inicial = "",
  autoFocus = false,
  onEscolher,
}: {
  /** Termo pré-preenchido (o SKU informado de um candidato), já buscado ao abrir. */
  inicial?: string;
  autoFocus?: boolean;
  onEscolher: (sku: OpcaoSku) => void;
}): ReactNode {
  const [termo, setTermo] = useState(inicial);
  const [resultados, setResultados] = useState<OpcaoSku[] | null>(null);
  const [ativo, setAtivo] = useState(0);
  const [buscando, setBuscando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const pedido = useRef(0);
  const espera = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listaId = useId();

  useEffect(() => {
    if (inicial.trim().length >= 2) agendar(inicial);

    return () => {
      if (espera.current !== null) clearTimeout(espera.current);
    };
    // Só na montagem: `inicial` é o valor de abertura, não um controle.
  }, []);

  function agendar(valor: string): void {
    if (espera.current !== null) clearTimeout(espera.current);

    const limpo = termoSeguro(valor);

    if (limpo.length < 2) {
      pedido.current += 1;
      setResultados(null);
      setBuscando(false);

      return;
    }

    setBuscando(true);
    espera.current = setTimeout(() => {
      void buscar(limpo);
    }, 220);
  }

  async function buscar(limpo: string): Promise<void> {
    pedido.current += 1;
    const este = pedido.current;

    const { data, error } = await createClient()
      .from("skus")
      .select("id, sku, title")
      .or(`sku_key.ilike.%${limpo.toUpperCase()}%,title.ilike.%${limpo}%`)
      .order("sku")
      .limit(8);

    if (este !== pedido.current) return;

    setBuscando(false);

    if (error !== null) {
      // Falha de rede/RLS não pode parecer "nenhum SKU encontrado" (D-067).
      setErro("Não foi possível buscar SKUs — tente de novo.");
      setResultados(null);

      return;
    }

    setErro(null);
    setAtivo(0);
    setResultados(data.map((s) => ({ skuId: s.id, sku: s.sku, title: s.title })));
  }

  function escolher(opcao: OpcaoSku): void {
    onEscolher(opcao);
    setResultados(null);
    setTermo("");
  }

  function tecla(evento: KeyboardEvent<HTMLInputElement>): void {
    if (evento.key === "Enter") {
      // Enter nunca envia o vínculo pela metade: escolhe o destacado, ou nada.
      evento.preventDefault();
      const destacado = resultados?.[ativo];

      if (destacado !== undefined) escolher(destacado);

      return;
    }

    if (resultados === null || resultados.length === 0) return;

    if (evento.key === "ArrowDown") {
      evento.preventDefault();
      setAtivo((i) => (i + 1) % resultados.length);
    } else if (evento.key === "ArrowUp") {
      evento.preventDefault();
      setAtivo((i) => (i - 1 + resultados.length) % resultados.length);
    } else if (evento.key === "Escape" && termo !== "") {
      // Esc com lista aberta limpa a busca; o segundo Esc fecha o popup.
      evento.stopPropagation();
      setResultados(null);
      setTermo("");
    }
  }

  return (
    <div className="sb-vnc-busca">
      <label className="sb-vnc-rotulo" htmlFor={`${listaId}-campo`}>
        SKU de destino
      </label>
      <div className="sb-vnc-busca-campo">
        <input
          id={`${listaId}-campo`}
          className="sb-input sb-input-full"
          type="search"
          value={termo}
          placeholder="Buscar por código ou nome do SKU…"
          autoComplete="off"
          autoFocus={autoFocus}
          role="combobox"
          aria-expanded={resultados !== null && resultados.length > 0}
          aria-controls={listaId}
          aria-autocomplete="list"
          onChange={(event) => {
            setTermo(event.target.value);
            agendar(event.target.value);
          }}
          onKeyDown={tecla}
        />
        {buscando && <span className="sb-vnc-girando" aria-hidden="true" />}
      </div>

      {erro !== null && (
        <p role="alert" className="sb-vnc-erro">
          {erro}
        </p>
      )}

      {resultados !== null && (
        <ul id={listaId} className="sb-vnc-resultados" role="listbox">
          {resultados.length === 0 ? (
            <li className="sb-vnc-vazio">Nenhum SKU com “{termo.trim()}”.</li>
          ) : (
            resultados.map((opcao, indice) => (
              <li key={opcao.skuId} role="option" aria-selected={indice === ativo}>
                <button
                  type="button"
                  className={indice === ativo ? "sb-menu-item sb-vnc-resultado sb-vnc-resultado-ativo" : "sb-menu-item sb-vnc-resultado"}
                  onMouseEnter={() => {
                    setAtivo(indice);
                  }}
                  onClick={() => {
                    escolher(opcao);
                  }}
                >
                  <b>{opcao.sku}</b>
                  <span>{opcao.title ?? "sem título"}</span>
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
