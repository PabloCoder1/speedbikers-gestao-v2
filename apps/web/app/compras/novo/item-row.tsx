"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";

import { Icone } from "../../../components/icons";
import { TOM } from "../../../components/tone";
import { formatCount, formatCurrency, formatDay } from "../../../lib/format";
import { createClient } from "../../../lib/supabase/browser";

import { subtotal } from "./rascunho";
import { ESTADO_SUGESTAO, type SugestaoItem } from "./sugestoes";

/**
 * Uma linha de item do pedido — busca de SKU lida direto do navegador sob RLS
 * (Modelo A, mesmo padrão de `notas-fiscais/[id]/document-item-row.tsx`).
 * `skuId` fica nulo quando o código é digitado livre sem escolher da lista: um
 * SKU ainda não catalogado continua sendo informação, não é bloqueado.
 *
 * D-368, o que a linha ganhou:
 * - busca por código OU nome, com espera curta entre teclas e descarte de
 *   resposta atrasada (a digitação rápida mostrava o resultado de "AB" depois
 *   do de "ABC");
 * - teclado: ↑/↓ percorrem, Enter escolhe, Esc fecha;
 * - marca, origem e custo cadastrado na lista e na linha escolhida;
 * - subtotal da linha e o ÚLTIMO CUSTO pago a este fornecedor por este SKU,
 *   quando existe — é a referência que faltava para negociar.
 *
 * D-371: a coluna SUGESTÃO — quanto a Cobertura e reposição manda comprar do
 * SKU escolhido, com o estado dele, e um clique para usar como quantidade.
 */

/** O que a coluna Sugestão sabe do SKU da linha. */
export type SugestaoDaLinha = SugestaoItem | "carregando" | "indisponivel" | null;

export interface DraftItem {
  key: string;
  skuId: string | null;
  skuSnapshot: string;
  titleSnapshot: string | null;
  isImported: boolean | null;
  quantityOrdered: string;
  unitCost: string;
  /** True quando `unitCost` veio do cadastro e o usuário ainda não mexeu. */
  unitCostSuggested?: boolean | undefined;
  /** Marca do SKU (D-129), só para exibição. */
  supplierBrand?: string | null | undefined;
}

export interface UltimaCompra {
  readonly custo: number;
  readonly pedido: number;
  readonly em: string;
}

interface SkuResult {
  id: string;
  sku: string;
  title: string | null;
  /** Nulo quando o SKU não tem código fiscal de origem cadastrado (~2% do catálogo). */
  is_imported: boolean | null;
  /** Custo CADASTRADO — vira sugestão editável, nunca volta pro cadastro (D-149). */
  purchase_cost: number | null;
  supplier_brand: string | null;
}

function Origem({ isImported }: { isImported: boolean | null }): ReactNode {
  if (isImported === null) return <span className="sb-pco-tag">origem não cadastrada</span>;

  return <span className={isImported ? "sb-pco-tag sb-pco-tag-importado" : "sb-pco-tag"}>{isImported ? "Importado" : "Nacional"}</span>;
}

/** Vírgula e parênteses quebram a sintaxe do `or=` do PostgREST: saem do termo. */
function termoSeguro(valor: string): string {
  return valor.replace(/[,()%*\\]/g, " ").trim();
}

export function ItemRow({
  item,
  numero,
  onChange,
  onRemove,
  podeRemover,
  duplicada = false,
  ultimaCompra = null,
  sugestao = null,
  onEnterNaQuantidade,
}: {
  item: DraftItem;
  /** Posição exibida (1, 2, 3…). */
  numero: number;
  onChange: (next: DraftItem) => void;
  onRemove: () => void;
  podeRemover: boolean;
  duplicada?: boolean;
  ultimaCompra?: UltimaCompra | null;
  /** A sugestão da reposição para o SKU catalogado da linha (D-371). */
  sugestao?: SugestaoDaLinha;
  /** Enter na quantidade/custo: o formulário acrescenta uma linha e leva o foco a ela. */
  onEnterNaQuantidade?: () => void;
}): ReactNode {
  const [results, setResults] = useState<SkuResult[]>([]);
  const [aberta, setAberta] = useState(false);
  const [ativo, setAtivo] = useState(0);
  const [buscando, setBuscando] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const pedido = useRef(0);
  const espera = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listaId = useId();
  const campoRef = useRef<HTMLInputElement | null>(null);
  const listaRef = useRef<HTMLUListElement | null>(null);
  const [posicao, setPosicao] = useState<CSSProperties | null>(null);

  /*
    A lista flutua com posição FIXA, medida do campo. Absoluta, ela ficava
    presa na caixa da tabela, que rola na horizontal e por isso corta o que
    sai dela — a lista aparecia como um traço embaixo do campo (visto na
    captura). Rolar a página ou redimensionar fecha a lista em vez de deixá-la
    solta no lugar antigo.
  */
  useLayoutEffect(() => {
    if (!aberta) return;

    const medir = (): void => {
      const r = campoRef.current?.getBoundingClientRect();

      if (r === undefined) return;

      setPosicao({ top: r.bottom + 4, left: r.left, width: Math.max(r.width, 352) });
    };

    const fechar = (): void => {
      setAberta(false);
    };

    // Rolar a PRÓPRIA lista (mais resultados que a altura) não fecha.
    const rolou = (evento: Event): void => {
      if (evento.target instanceof Node && listaRef.current?.contains(evento.target) === true) return;
      fechar();
    };

    medir();
    window.addEventListener("resize", fechar);
    window.addEventListener("scroll", rolou, true);

    return () => {
      window.removeEventListener("resize", fechar);
      window.removeEventListener("scroll", rolou, true);
    };
  }, [aberta]);

  useEffect(
    () => () => {
      if (espera.current !== null) clearTimeout(espera.current);
    },
    [],
  );

  function digitar(value: string): void {
    onChange({
      ...item,
      skuSnapshot: value,
      skuId: null,
      titleSnapshot: null,
      isImported: null,
      supplierBrand: null,
    });
    setSearchError(null);

    if (espera.current !== null) clearTimeout(espera.current);

    const termo = termoSeguro(value);

    if (termo.length < 2) {
      pedido.current += 1;
      setResults([]);
      setAberta(false);
      setBuscando(false);

      return;
    }

    setBuscando(true);
    espera.current = setTimeout(() => {
      void buscar(termo);
    }, 220);
  }

  async function buscar(termo: string): Promise<void> {
    pedido.current += 1;
    const este = pedido.current;
    const supabase = createClient();

    const { data, error } = await supabase
      .from("skus")
      .select("id, sku, title, is_imported, purchase_cost, supplier_brand")
      .or(`sku_key.ilike.%${termo.toUpperCase()}%,title.ilike.%${termo}%`)
      .order("sku")
      .limit(8);

    // Resposta de uma busca que já foi substituída por outra: descarta.
    if (este !== pedido.current) return;

    setBuscando(false);

    if (error !== null) {
      // Falha de rede/RLS não pode parecer "nenhum SKU encontrado" (D-067).
      setSearchError("Não foi possível buscar SKUs — tente de novo.");
      setAberta(false);

      return;
    }

    setResults(data);
    setAtivo(0);
    setAberta(true);
  }

  function select(sku: SkuResult): void {
    // Custo cadastrado entra como SUGESTÃO editável (D-149) — só com o campo
    // vazio ou ainda com a sugestão anterior, nunca por cima do digitado.
    const shouldSuggest = sku.purchase_cost !== null && (item.unitCost === "" || item.unitCostSuggested === true);

    onChange({
      ...item,
      skuId: sku.id,
      skuSnapshot: sku.sku,
      titleSnapshot: sku.title,
      isImported: sku.is_imported,
      supplierBrand: sku.supplier_brand,
      unitCost: shouldSuggest ? String(sku.purchase_cost) : item.unitCost,
      unitCostSuggested: shouldSuggest ? true : item.unitCostSuggested,
    });
    setResults([]);
    setAberta(false);
  }

  function teclaNaBusca(evento: KeyboardEvent<HTMLInputElement>): void {
    if (!aberta || results.length === 0) {
      // Enter no código com a lista fechada NÃO envia o pedido pela metade.
      if (evento.key === "Enter") evento.preventDefault();

      return;
    }

    if (evento.key === "ArrowDown") {
      evento.preventDefault();
      setAtivo((i) => (i + 1) % results.length);
    } else if (evento.key === "ArrowUp") {
      evento.preventDefault();
      setAtivo((i) => (i - 1 + results.length) % results.length);
    } else if (evento.key === "Enter") {
      evento.preventDefault();
      const escolhido = results[ativo];

      if (escolhido !== undefined) select(escolhido);
    } else if (evento.key === "Escape") {
      setAberta(false);
    }
  }

  function enterAvanca(evento: KeyboardEvent<HTMLInputElement>): void {
    if (evento.key === "Enter" && onEnterNaQuantidade !== undefined) {
      evento.preventDefault();
      onEnterNaQuantidade();
    }
  }

  const linha = subtotal(item);
  const custoAtual = item.unitCost.trim() === "" ? null : Number(item.unitCost);
  const variacao =
    ultimaCompra !== null && custoAtual !== null && Number.isFinite(custoAtual) && ultimaCompra.custo > 0
      ? (custoAtual - ultimaCompra.custo) / ultimaCompra.custo
      : null;

  return (
    <tr className={duplicada ? "sb-pco-item sb-pco-item-duplicado" : "sb-pco-item"} data-linha={item.key}>
      <td className="sb-pco-num-linha" aria-hidden="true">
        {numero}
      </td>

      <td className="sb-pco-sku">
        <div className="sb-pco-busca">
          <input
            ref={campoRef}
            className="sb-input sb-input-full"
            type="text"
            value={item.skuSnapshot}
            onChange={(event) => {
              digitar(event.target.value);
            }}
            onKeyDown={teclaNaBusca}
            onBlur={() => {
              // Deixa o clique na lista chegar antes de fechar.
              setTimeout(() => {
                setAberta(false);
              }, 150);
            }}
            onFocus={() => {
              if (results.length > 0) setAberta(true);
            }}
            placeholder="SKU ou nome…"
            aria-label={`SKU do item ${String(numero)}`}
            role="combobox"
            aria-expanded={aberta}
            aria-controls={listaId}
            aria-autocomplete="list"
            autoComplete="off"
            required
          />
          {buscando && <span className="sb-pco-buscando" aria-hidden="true" />}

          {aberta && posicao !== null && (
            <ul ref={listaRef} id={listaId} className="sb-pco-resultados" role="listbox" style={posicao}>
              {results.length === 0 ? (
                <li className="sb-pco-resultado-vazio">
                  Nenhum SKU com “{item.skuSnapshot.trim()}”. Pode seguir com o código livre — o vínculo fica pendente.
                </li>
              ) : (
                results.map((sku, indice) => (
                  <li key={sku.id} role="option" aria-selected={indice === ativo}>
                    <button
                      type="button"
                      className={indice === ativo ? "sb-menu-item sb-pco-resultado sb-pco-resultado-ativo" : "sb-menu-item sb-pco-resultado"}
                      onMouseDown={(event) => {
                        event.preventDefault();
                      }}
                      onMouseEnter={() => {
                        setAtivo(indice);
                      }}
                      onClick={() => {
                        select(sku);
                      }}
                    >
                      <span className="sb-pco-resultado-topo">
                        <b>{sku.sku}</b>
                        <span>{sku.purchase_cost === null ? "sem custo" : formatCurrency(sku.purchase_cost)}</span>
                      </span>
                      <span className="sb-pco-resultado-titulo">{sku.title ?? "sem título"}</span>
                      <span className="sb-pco-resultado-meta">
                        {sku.supplier_brand !== null && <span className="sb-pco-tag">{sku.supplier_brand}</span>}
                        <Origem isImported={sku.is_imported} />
                      </span>
                    </button>
                  </li>
                ))
              )}
            </ul>
          )}
        </div>

        {item.skuId !== null && (
          <div className="sb-pco-escolhido">
            <span className="sb-pco-escolhido-titulo">{item.titleSnapshot ?? "sem título"}</span>
            <span className="sb-pco-resultado-meta">
              {item.supplierBrand !== null && item.supplierBrand !== undefined && (
                <span className="sb-pco-tag">{item.supplierBrand}</span>
              )}
              <Origem isImported={item.isImported} />
              {duplicada && <span className="sb-pco-tag sb-pco-tag-alerta">repetido no pedido</span>}
            </span>
          </div>
        )}

        {item.skuId === null && item.skuSnapshot.trim() !== "" && searchError === null && !aberta && !buscando && (
          <div className="sb-pco-dica">Sem SKU catalogado — o vínculo fica pendente.</div>
        )}

        {searchError !== null && (
          <div role="alert" className="sb-pco-dica sb-pco-dica-erro">
            {searchError}
          </div>
        )}
      </td>

      <td className="sb-pco-sugestao">
        <CelulaSugestao
          item={item}
          sugestao={sugestao}
          onUsar={(quantidade) => {
            onChange({ ...item, quantityOrdered: String(quantidade) });
          }}
        />
      </td>

      <td className="sb-pco-campo-num">
        <input
          className="sb-input sb-input-full"
          type="number"
          min="0.001"
          step="0.001"
          inputMode="decimal"
          value={item.quantityOrdered}
          onChange={(event) => {
            onChange({ ...item, quantityOrdered: event.target.value });
          }}
          onKeyDown={enterAvanca}
          aria-label={`Quantidade do item ${String(numero)}`}
          required
        />
      </td>

      <td className="sb-pco-campo-num">
        <div className="sb-pco-moeda">
          <span aria-hidden="true">R$</span>
          <input
            className="sb-input sb-input-full"
            type="number"
            min="0"
            step="0.01"
            inputMode="decimal"
            value={item.unitCost}
            onChange={(event) => {
              onChange({ ...item, unitCost: event.target.value, unitCostSuggested: false });
            }}
            onKeyDown={enterAvanca}
            aria-label={`Custo unitário do item ${String(numero)}`}
          />
        </div>
        {item.unitCostSuggested === true && <div className="sb-pco-dica">custo cadastrado — não altera o cadastro</div>}
        {ultimaCompra !== null && (
          <div className="sb-pco-dica" title={`pedido #${String(ultimaCompra.pedido)} em ${formatDay(ultimaCompra.em)}`}>
            último com este fornecedor: {formatCurrency(ultimaCompra.custo)}
            {variacao !== null && Math.abs(variacao) >= 0.005 && (
              <b className={variacao > 0 ? "sb-pco-variacao-alta" : "sb-pco-variacao-baixa"}>
                {" "}
                {variacao > 0 ? "▲" : "▼"} {Math.abs(variacao * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%
              </b>
            )}
          </div>
        )}
      </td>

      <td className="sb-num sb-pco-subtotal">
        {linha === null ? (
          <span className="sb-pco-mudo" title={item.quantityOrdered.trim() === "" ? "sem quantidade" : "sem custo — fora da soma"}>
            —
          </span>
        ) : (
          <>
            <b>{formatCurrency(linha)}</b>
            <small>{formatCount(Number(item.quantityOrdered))} un</small>
          </>
        )}
      </td>

      <td className="sb-pco-remover">
        <button
          className="sb-icon-button sb-pco-icone-botao"
          type="button"
          onClick={onRemove}
          disabled={!podeRemover}
          aria-label={`Remover item ${String(numero)}`}
          title={podeRemover ? "Remover item" : "O pedido precisa de ao menos uma linha"}
        >
          <Icone nome="lixeira" tamanho={15} />
        </button>
      </td>
    </tr>
  );
}

/**
 * A célula SUGESTÃO. Cada saída quer dizer uma coisa diferente, e nenhuma
 * vira zero calado:
 * - código livre (fora do catálogo): não há reposição para ele;
 * - recusa (sem configuração, estoque virtual, histórico ou amostra): "sem
 *   sugestão", com o motivo no `title`;
 * - 0: a janela de demanda já está coberta;
 * - positiva: a quantidade como botão — um clique a usa no pedido.
 */
function CelulaSugestao({
  item,
  sugestao,
  onUsar,
}: {
  item: DraftItem;
  sugestao: SugestaoDaLinha;
  onUsar: (quantidade: number) => void;
}): ReactNode {
  if (item.skuId === null) {
    return (
      <span className="sb-pco-mudo" title="Código fora do catálogo: a reposição não tem como sugerir">
        —
      </span>
    );
  }

  if (sugestao === "carregando") return <span className="sb-pco-sugestao-lendo">lendo…</span>;

  if (sugestao === "indisponivel" || sugestao === null) {
    return (
      <span className="sb-pco-mudo" title="Não foi possível ler a reposição agora">
        indisponível
      </span>
    );
  }

  const estado = sugestao.state === null ? undefined : ESTADO_SUGESTAO[sugestao.state];
  const contexto = [
    `vendeu ${formatCount(sugestao.units30d)} em 30 dias`,
    sugestao.aproveitavel === null ? "estoque virtual" : `aproveitável ${formatCount(sugestao.aproveitavel)}`,
    sugestao.coverageDays === null ? null : `cobertura ${sugestao.coverageDays.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} dias`,
  ]
    .filter((parte): parte is string => parte !== null)
    .join(" · ");

  const selo =
    estado === undefined ? null : (
      <span className="sb-status sb-pco-sugestao-selo" style={TOM[estado.tom]}>
        {estado.rotulo}
      </span>
    );

  if (sugestao.suggestedQuantity === null) {
    return (
      <span
        className="sb-pco-mudo"
        title={`A reposição recusa sugerir: sem configuração, estoque virtual, histórico ou amostra suficiente · ${contexto}`}
      >
        sem sugestão
      </span>
    );
  }

  if (sugestao.suggestedQuantity === 0) {
    return (
      <span className="sb-pco-sugestao-coberta" title={`A janela de demanda já está coberta · ${contexto}`}>
        <span className="sb-pco-mudo">coberto</span>
        {selo}
      </span>
    );
  }

  const usando = Number(item.quantityOrdered) === sugestao.suggestedQuantity;

  return (
    <span className="sb-pco-sugestao-valor">
      <button
        type="button"
        className={usando ? "sb-button sb-button-sm sb-pco-usar sb-pco-usar-ativo" : "sb-button sb-button-sm sb-pco-usar"}
        title={`${usando ? "Quantidade igual à sugestão" : "Usar a sugestão como quantidade"} · ${contexto}`}
        aria-label={`Usar a sugestão de ${String(sugestao.suggestedQuantity)} unidade(s)`}
        onClick={() => {
          onUsar(sugestao.suggestedQuantity ?? 0);
        }}
      >
        {usando && <span aria-hidden="true">✓ </span>}
        {formatCount(sugestao.suggestedQuantity)} un
      </button>
      {selo}
    </span>
  );
}
