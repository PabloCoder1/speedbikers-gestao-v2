"use client";

import { useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import {
  RemoverVinculoShopeeDialog,
  VincularShopeeDialog,
  type ModoVincularShopee,
  type UnidadeShopee,
} from "./vincular-shopee-dialog";

/**
 * Os botões do vínculo manual na coluna "Vínculo" de `/anuncios/shopee`
 * (D-429). A página decide QUAL conjunto a linha tem (`acaoDoVinculoShopee`)
 * e SE a pessoa os vê (papel ADMIN, GESTOR ou OPERADOR); aqui mora só o
 * estado de qual popup está aberto.
 *
 * - `manual`: "Trocar SKU" e "Remover vínculo manual";
 * - `outro-sku`: "Vincular a outro SKU" (a linha está vinculada pelo SKU do
 *   anúncio, e o manual vence);
 * - `vincular`: "Vincular".
 *
 * O texto dos botões é o nome acessível deles; o `title` diz a unidade, que
 * numa tabela com várias variações do mesmo item é o que distingue um do outro.
 */

/**
 * O popup aberto, com a linha COMO ESTAVA no clique. A ação refaz a tela antes
 * de responder (`revalidatePath`), e a linha muda de estado por baixo do popup
 * ainda aberto — sem a foto, ele trocaria de título ("Vincular" → "Trocar SKU")
 * no instante antes de fechar.
 */
type Aberto =
  | { readonly tipo: "vincular"; readonly modo: ModoVincularShopee; readonly unidade: UnidadeShopee }
  | { readonly tipo: "remover"; readonly linkId: string; readonly unidade: UnidadeShopee };

export function AcoesDoVinculoShopee({
  unidade,
  modo,
  linkId,
}: {
  unidade: UnidadeShopee;
  modo: "manual" | "outro-sku" | "vincular";
  /** O id do vínculo manual — só no modo `manual`. */
  linkId: string | null;
}): ReactNode {
  const [aberto, setAberto] = useState<Aberto | null>(null);

  // A unidade por extenso, com o artigo certo: "o item…" / "a variação… do item…".
  const item = `item ${String(unidade.itemId)}`;
  const variacao =
    unidade.modelId === null ? null : `variação ${unidade.modelName ?? String(unidade.modelId)} do ${item}`;
  const alvo = variacao === null ? `o ${item}` : `a ${variacao}`;
  const doAlvo = variacao === null ? `do ${item}` : `da ${variacao}`;

  const fechar = (): void => {
    setAberto(null);
  };

  const abrirVincular = (): void => {
    setAberto({ tipo: "vincular", modo: modo === "manual" ? "trocar" : modo, unidade });
  };

  return (
    <>
      <span className="sb-an-vinculo-acoes">
        {modo === "manual" ? (
          <>
            <button
              type="button"
              className="sb-text-button"
              title={`Trocar o SKU do vínculo manual ${doAlvo}`}
              onClick={abrirVincular}
            >
              Trocar SKU
            </button>
            {linkId !== null && (
              <button
                type="button"
                className="sb-text-button"
                title={`Remover o vínculo manual ${doAlvo}`}
                onClick={() => {
                  setAberto({ tipo: "remover", linkId, unidade });
                }}
              >
                Remover vínculo manual
              </button>
            )}
          </>
        ) : (
          <button
            type="button"
            className="sb-text-button"
            title={`Vincular à mão ${alvo} a um SKU do catálogo`}
            onClick={abrirVincular}
          >
            {modo === "outro-sku" ? "Vincular a outro SKU" : "Vincular"}
          </button>
        )}
      </span>

      {/*
        Por PORTAL, como a gaveta (D-281): dentro da célula o popup herdaria a
        tinta suave da linha pausada (`.sb-an-linha-inativa td`). Ele só monta
        depois de um clique, então `document` sempre existe aqui.
      */}
      {aberto?.tipo === "vincular" &&
        createPortal(
          <VincularShopeeDialog unidade={aberto.unidade} modo={aberto.modo} onFechar={fechar} />,
          document.body,
        )}

      {aberto?.tipo === "remover" &&
        createPortal(
          <RemoverVinculoShopeeDialog unidade={aberto.unidade} linkId={aberto.linkId} onFechar={fechar} />,
          document.body,
        )}
    </>
  );
}
