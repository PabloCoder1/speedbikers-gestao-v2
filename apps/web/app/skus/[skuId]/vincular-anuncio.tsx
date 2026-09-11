"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

import { createManualLink } from "../../vinculacoes/actions";
import { createClient } from "../../../lib/supabase/browser";
import { formatCount, formatCurrency } from "../../../lib/format";
import { listingStatusLabel } from "../../../lib/labels";

/**
 * "+ Vincular anúncio" no Dashboard do SKU (D-316).
 *
 * ## A confirmação existe por um defeito medido, não por estética
 *
 * `create_sku_listing_link` NÃO confere se o anúncio existe: `item_id` não tem
 * chave estrangeira, só o regex `^MLB[0-9]+$`. Hoje um MLB digitado errado é
 * aceito em silêncio e vira **vínculo morto** — um SKU que aponta para um
 * anúncio que não existe, e ninguém descobre até alguém procurar a venda que
 * não apareceu. Por isso a tela confirma ANTES: ela mostra o que encontrou, e
 * só então oferece o botão de gravar.
 *
 * ## Por que a busca é do navegador, e o que ela pode afirmar
 *
 * A leitura é `listings` sob RLS — a mesma policy que a tela inteira usa
 * (`has_account_access`), o mesmo padrão de `components/use-sku-search.ts`.
 * **Não há chamada ao Mercado Livre**: `apps/web` nunca fala com o ML, nunca
 * usa service role e nunca guarda segredo (ARCHITECTURE §101), e não existe
 * rota na `api` que busque um item sob demanda.
 *
 * Consequência honesta, e ela está na tela: quando não encontramos, a resposta
 * NÃO é "este MLB não existe". Não sabemos. Pode ser MLB inexistente, conta
 * não conectada (o sync só varre `CONNECTED`), conta que a RLS esconde deste
 * usuário, ou anúncio real ainda não sincronizado — o catálogo roda de 6 em 6
 * horas. A tela diz isso e recusa a vinculação, que é o ponto do pedido:
 * evitar o vínculo errado.
 *
 * ## O que ela NÃO confirma
 *
 * A VARIAÇÃO. `listings` é uma linha por (conta, anúncio) e o sync não lê
 * `variations[]` — não existe tabela de variação nesta base. Vincular variação
 * específica continua sendo trabalho da Central de Vinculações, que tem o
 * campo. Aqui o vínculo é sempre do ANÚNCIO INTEIRO, e a tela diz isso.
 */
export interface ContaDoVinculo {
  readonly id: string;
  readonly label: string;
}

interface Encontrado {
  readonly itemId: string;
  readonly title: string;
  readonly status: string;
  readonly price: number;
  readonly availableQuantity: number;
  readonly syncedAt: string;
  readonly skuAtual: string | null;
}

type Estado =
  | { kind: "fechado" }
  | { kind: "aberto" }
  | { kind: "buscando" }
  | { kind: "encontrado"; anuncio: Encontrado }
  | { kind: "nao_encontrado" }
  | { kind: "gravando"; anuncio: Encontrado }
  | { kind: "erro"; mensagem: string };

export function VincularAnuncio({
  skuId,
  skuCode,
  contas,
}: {
  skuId: string;
  skuCode: string;
  contas: readonly ContaDoVinculo[];
}): ReactNode {
  const router = useRouter();
  const [estado, setEstado] = useState<Estado>({ kind: "fechado" });
  const [conta, setConta] = useState<string>(contas[0]?.id ?? "");
  const [mlb, setMlb] = useState("");

  const fechar = (): void => {
    setEstado({ kind: "fechado" });
    setMlb("");
  };

  async function buscar(): Promise<void> {
    const itemId = mlb.trim().toUpperCase();

    if (!/^MLB[0-9]+$/.test(itemId)) {
      setEstado({ kind: "erro", mensagem: "O identificador do anúncio tem a forma MLB seguido de números." });

      return;
    }

    if (conta === "") {
      setEstado({ kind: "erro", mensagem: "Escolha a conta do Mercado Livre." });

      return;
    }

    setEstado({ kind: "buscando" });

    const supabase = createClient();

    /*
      Por (conta, anúncio) — o índice único da tabela. Buscar só por `item_id`
      acharia o anúncio de OUTRA conta e diria que está tudo certo, e é
      exatamente o par que o vínculo grava.
    */
    const { data, error } = await supabase
      .from("listings")
      .select("item_id, title, status, price, available_quantity, synced_at, skus(sku)")
      .eq("ml_account_id", conta)
      .eq("item_id", itemId)
      .maybeSingle();

    if (error !== null) {
      setEstado({ kind: "erro", mensagem: "Não foi possível consultar o catálogo agora." });

      return;
    }

    if (data === null) {
      setEstado({ kind: "nao_encontrado" });

      return;
    }

    setEstado({
      kind: "encontrado",
      anuncio: {
        itemId: data.item_id,
        title: data.title,
        status: data.status,
        price: data.price,
        availableQuantity: data.available_quantity,
        syncedAt: data.synced_at,
        skuAtual: data.skus?.sku ?? null,
      },
    });
  }

  async function confirmar(anuncio: Encontrado): Promise<void> {
    setEstado({ kind: "gravando", anuncio });

    const resultado = await createManualLink({
      mlAccountId: conta,
      itemId: anuncio.itemId,
      // Anúncio inteiro: a variação não é sincronizada, então a tela não a pede.
      variationId: "",
      skuId,
    });

    if (!resultado.ok) {
      setEstado({ kind: "erro", mensagem: resultado.message ?? "Não foi possível vincular." });

      return;
    }

    /*
      A Server Action revalida `/vinculacoes` (ela é de lá). Esta tela se
      atualiza pelo router: as duas leem a MESMA fonte, então o que muda aqui
      aparece lá na próxima visita, e vice-versa — que é a regra do pedido.
    */
    fechar();
    router.refresh();
  }

  if (contas.length === 0) {
    return null;
  }

  return (
    <>
      <button
        type="button"
        className="sb-text-button"
        onClick={() => {
          setEstado({ kind: "aberto" });
        }}
      >
        + Vincular anúncio
      </button>

      {estado.kind !== "fechado" && (
        <div className="sb-backdrop" onClick={fechar}>
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Vincular anúncio"
            className="sb-modal"
            onClick={(event) => {
              event.stopPropagation();
            }}
          >
            <span className="sb-modal-eyebrow">VINCULAR ANÚNCIO</span>
            <h2 style={{ margin: "0 0 var(--sb-space-3)", fontSize: "1rem" }}>
              Vincular um anúncio ao SKU {skuCode}
            </h2>

            <p style={{ margin: "0 0 var(--sb-space-3)", fontSize: "0.75rem", color: "var(--sb-text-soft)" }}>
              O vínculo é do <strong>anúncio inteiro</strong>. Vincular uma variação específica continua sendo feito
              em <a href="/vinculacoes">Vinculações</a>, que é a tela dona do assunto.
            </p>

            <label style={{ display: "grid", gap: "0.25rem", fontSize: "0.75rem" }}>
              <span>Plataforma</span>
              {/*
                Um valor só, e desabilitado — mas VISÍVEL: o pedido do dono
                fala em plataforma, e a resposta honesta é que só existe uma
                integrada. Esconder o campo faria parecer que a pergunta não
                foi feita.
              */}
              <select className="sb-input sb-input-full" disabled value="ML">
                <option value="ML">Mercado Livre</option>
              </select>
            </label>

            <label style={{ display: "grid", gap: "0.25rem", fontSize: "0.75rem", marginTop: "var(--sb-space-3)" }}>
              <span>Conta</span>
              <select
                className="sb-input sb-input-full"
                value={conta}
                onChange={(event) => {
                  setConta(event.target.value);
                }}
              >
                {contas.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>

            <label style={{ display: "grid", gap: "0.25rem", fontSize: "0.75rem", marginTop: "var(--sb-space-3)" }}>
              <span>MLB / id do anúncio</span>
              <input
                className="sb-input sb-input-full"
                value={mlb}
                placeholder="MLB123456789"
                spellCheck={false}
                onChange={(event) => {
                  setMlb(event.target.value);
                }}
              />
            </label>

            {estado.kind === "erro" && (
              <p style={{ margin: "var(--sb-space-3) 0 0", color: "var(--sb-danger)", fontSize: "0.75rem" }}>
                {estado.mensagem}
              </p>
            )}

            {estado.kind === "nao_encontrado" && (
              <div className="sb-drawer-card" style={{ marginTop: "var(--sb-space-3)", fontSize: "0.75rem" }}>
                <b style={{ display: "block", color: "var(--sb-accent-ink)" }}>Não encontramos este anúncio</b>
                <p style={{ margin: "0.25rem 0 0" }}>
                  Ele não está no catálogo sincronizado desta conta. Pode ser MLB digitado errado, conta não
                  conectada, anúncio que você não alcança, ou anúncio novo — o catálogo sincroniza de 6 em 6 horas.
                  <strong> Não conseguimos confirmar que ele existe</strong>, então não vinculamos: era exatamente
                  isto que a confirmação veio impedir.
                </p>
              </div>
            )}

            {(estado.kind === "encontrado" || estado.kind === "gravando") && (
              <div className="sb-drawer-card" style={{ marginTop: "var(--sb-space-3)", fontSize: "0.75rem" }}>
                <b style={{ display: "block", color: "var(--sb-success)" }}>Anúncio encontrado</b>
                <dl className="sb-fact-grid" style={{ marginTop: "0.5rem" }}>
                  <div>
                    <dt>Título</dt>
                    <dd>{estado.anuncio.title}</dd>
                  </div>
                  <div>
                    <dt>MLB</dt>
                    <dd>{estado.anuncio.itemId}</dd>
                  </div>
                  <div>
                    <dt>Estado</dt>
                    <dd>{listingStatusLabel(estado.anuncio.status)}</dd>
                  </div>
                  <div>
                    <dt>Estoque</dt>
                    <dd>{formatCount(estado.anuncio.availableQuantity)}</dd>
                  </div>
                  <div>
                    <dt>Preço</dt>
                    <dd>{formatCurrency(estado.anuncio.price)}</dd>
                  </div>
                </dl>

                {/*
                  O ANÚNCIO JÁ VINCULADO A OUTRO SKU é o caso que mais merece
                  aviso: a RPC recusa (`vinculo ja existe para outro sku`), e
                  dizer isso antes do clique é melhor do que traduzir o erro
                  depois.
                */}
                {estado.anuncio.skuAtual !== null && estado.anuncio.skuAtual !== skuCode && (
                  <p style={{ margin: "0.5rem 0 0", color: "var(--sb-accent-ink)" }}>
                    Atenção: a última sincronização mostra este anúncio vinculado ao SKU{" "}
                    <strong>{estado.anuncio.skuAtual}</strong>. Trocar o SKU de um vínculo existente é feito em
                    Vinculações, que preserva o histórico dos pedidos já gravados.
                  </p>
                )}
              </div>
            )}

            <div
              style={{
                display: "flex",
                gap: "var(--sb-space-2)",
                justifyContent: "flex-end",
                marginTop: "var(--sb-space-3)",
              }}
            >
              <button type="button" className="sb-button" onClick={fechar}>
                Cancelar
              </button>

              {estado.kind === "encontrado" ? (
                <button
                  type="button"
                  className="sb-button sb-button-primary"
                  onClick={() => void confirmar(estado.anuncio)}
                >
                  Confirmar vinculação
                </button>
              ) : (
                <button
                  type="button"
                  className="sb-button sb-button-primary"
                  disabled={estado.kind === "buscando" || estado.kind === "gravando"}
                  onClick={() => void buscar()}
                >
                  {estado.kind === "buscando" ? "Procurando…" : "Procurar anúncio"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
