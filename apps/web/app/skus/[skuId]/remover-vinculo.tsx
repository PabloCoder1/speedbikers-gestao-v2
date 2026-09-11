"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

import { removeLink } from "../../vinculacoes/actions";
import { motivoDaRemocao } from "../../../lib/sku-listings";

/**
 * "Remover vinculação" a partir do Dashboard do SKU (D-316).
 *
 * ## O que a confirmação precisa dizer, e é o que o dono pediu
 *
 * Que **nada acontece no Mercado Livre**. Remover o vínculo apaga a relação
 * entre o anúncio e o SKU DENTRO desta casa: o anúncio continua no ar, com o
 * mesmo preço e o mesmo estoque. Quem lê "remover" num sistema que também
 * republica anúncio precisa dessa frase antes de clicar.
 *
 * ## Por que não pede motivo digitado
 *
 * `remove_sku_listing_link` exige `p_reason` não vazio, e o texto fica no
 * histórico (`sku_listing_link_events.reason`). Pedir uma frase a cada clique
 * produziria "asdf" no registro de auditoria; o contexto É o motivo, e o que
 * fica gravado diz de onde a remoção partiu e sobre qual SKU.
 *
 * ## O que ela NÃO oferece
 *
 * Trocar o SKU do vínculo. `retargetLink` existe e preserva o id do vínculo —
 * e com ele os ponteiros já gravados em `order_items` (D-125) —, mas trocar
 * exige escolher OUTRO SKU, e a tela que tem busca de SKU é Vinculações. Uma
 * troca aqui seria um segundo seletor de SKU dentro da tela de um SKU.
 */
export function RemoverVinculo({
  linkId,
  itemId,
  skuCode,
}: {
  linkId: string;
  itemId: string;
  skuCode: string;
}): ReactNode {
  const router = useRouter();
  const [aberto, setAberto] = useState(false);
  const [removendo, setRemovendo] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  async function remover(): Promise<void> {
    setRemovendo(true);
    setErro(null);

    const resultado = await removeLink(linkId, motivoDaRemocao(skuCode));

    if (!resultado.ok) {
      setErro(resultado.message ?? "Não foi possível remover o vínculo.");
      setRemovendo(false);

      return;
    }

    setAberto(false);
    setRemovendo(false);
    router.refresh();
  }

  return (
    <>
      <button
        type="button"
        className="sb-text-button"
        onClick={() => {
          setAberto(true);
        }}
      >
        Remover
      </button>

      {aberto && (
        <div
          className="sb-backdrop"
          onClick={() => {
            setAberto(false);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Remover vinculação"
            className="sb-modal"
            onClick={(event) => {
              event.stopPropagation();
            }}
          >
            <span className="sb-modal-eyebrow">Remover vinculação</span>
            <h2 style={{ margin: "0 0 var(--sb-space-3)", fontSize: "1rem" }}>Remover vinculação?</h2>

            <p style={{ margin: "0 0 var(--sb-space-2)", fontSize: "0.8125rem" }}>
              O anúncio <strong>{itemId}</strong> deixará de estar vinculado ao SKU <strong>{skuCode}</strong>.
            </p>

            <p style={{ margin: "0 0 var(--sb-space-3)", fontSize: "0.75rem", color: "var(--sb-text-soft)" }}>
              Isso <strong>não</strong> encerra nem pausa o anúncio no Mercado Livre: o que sai é a relação entre o
              anúncio e o SKU dentro do sistema. A remoção fica registrada com o seu usuário e a data.
            </p>

            {erro !== null && (
              <p style={{ margin: "0 0 var(--sb-space-3)", color: "var(--sb-danger)", fontSize: "0.75rem" }}>{erro}</p>
            )}

            <div style={{ display: "flex", gap: "var(--sb-space-2)", justifyContent: "flex-end" }}>
              <button
                type="button"
                className="sb-button"
                disabled={removendo}
                onClick={() => {
                  setAberto(false);
                }}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="sb-button sb-button-danger"
                disabled={removendo}
                onClick={() => {
                  void remover();
                }}
              >
                {removendo ? "Removendo…" : "Remover vinculação"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
