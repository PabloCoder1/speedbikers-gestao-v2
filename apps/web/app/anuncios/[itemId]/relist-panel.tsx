"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

import { relistStatusLabel } from "../../../lib/labels";
import { createClient } from "../../../lib/supabase/browser";

/**
 * A SUPERFÍCIE DE CONFIRMAÇÃO HUMANA da republicação (D-295) — o item que
 * D-164 deixou declarado: *"o que NÃO existe: UI"*.
 *
 * O motor inteiro existe desde a Fase 9 (D-159→D-164): modelo com nove
 * estados, preflight fail-safe, pedido, executor re-entrante, remapeamento e
 * medição 7/15/30. O que faltava era o lugar onde uma PESSOA autoriza — e a
 * tela dizia isso por escrito ("republicar é ato humano deliberado, fora da
 * interface"), que era honesto e provisório.
 *
 * ## Dois atos, duas confirmações — e a segunda é a que fecha o anúncio
 *
 * O backend separa pedido e execução de propósito (D-161/D-162), e a
 * interface não podia colapsar os dois num clique só:
 *
 *  1. **Pedir** enfileira a captura do snapshot e o preflight. Nada
 *     destrutivo acontece — e a confirmação DIZ isso, para o operador não
 *     hesitar no ato inofensivo e nem relaxar no perigoso;
 *  2. **Executar** fecha o anúncio pai no Mercado Livre. Isso é
 *     **irreversível** (secao 2.16), e a confirmação exige um gesto a mais:
 *     marcar que se entende o que vai acontecer. Não é atrito decorativo —
 *     é a diferença entre um clique errado e um anúncio fechado.
 *
 * ## O que a interface NÃO decide
 *
 * Nada. Papel (ADMIN/GESTOR) e escopo por conta são impostos no servidor
 * (D-161), e o worker **re-roda o preflight na hora da execução** de qualquer
 * forma: o estado do anúncio muda entre o pedido e o ato. Esconder o botão de
 * quem não pode é cortesia, não segurança — e a cortesia importa porque
 * oferecer o que o servidor vai negar é pior do que não oferecer.
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "";

export interface RelistOperation {
  id: string;
  status: string;
  failureReason: string | null;
  childItemId: string | null;
  createdAt: string;
}

/**
 * Os estados em que a operação está VIVA — espelham
 * `listing_relists_one_live_per_parent`, o índice parcial que impede uma
 * segunda operação para o mesmo pai. Enquanto um deles vale, pedir de novo
 * seria 409 no servidor: a tela mostra a operação em vez do botão.
 */
const VIVOS = ["REQUESTED", "CLOSING", "CLOSED", "RELISTING", "RELISTED", "REMAPPED"];

type Estado =
  | { kind: "idle" }
  | { kind: "confirmando-pedido" }
  | { kind: "confirmando-execucao" }
  | { kind: "enviando" }
  | { kind: "enfileirado"; mensagem: string }
  | { kind: "erro"; mensagem: string };

export function RelistPanel({
  itemId,
  mlAccountId,
  podeRepublicar,
  operacao,
}: {
  itemId: string;
  mlAccountId: string;
  /** ADMIN ou GESTOR — o mesmo par que a rota exige (D-161). */
  podeRepublicar: boolean;
  /** A operação viva deste anúncio como PAI, se houver. */
  operacao: RelistOperation | null;
}): ReactNode {
  const router = useRouter();
  const [estado, setEstado] = useState<Estado>({ kind: "idle" });

  const viva = operacao !== null && VIVOS.includes(operacao.status);
  const executavel = operacao !== null && operacao.status === "REQUESTED";

  async function chamar(caminho: string, corpo: unknown, mensagem: string): Promise<void> {
    setEstado({ kind: "enviando" });

    const supabase = createClient();
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;

    if (token === undefined) {
      setEstado({ kind: "erro", mensagem: "Sessão expirada — atualize a página e entre de novo." });

      return;
    }

    try {
      const response = await fetch(`${API_URL}${caminho}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(corpo),
      });

      if (!response.ok) {
        /*
          O SERVIDOR É QUEM SABE, e o texto dele chega inteiro: 403 de papel,
          409 de estado ("já existe operação viva"), 404 de anúncio de outra
          conta. Traduzir isso aqui em "não foi possível" apagaria justamente
          a informação que faz a pessoa entender o que fazer em seguida.
        */
        const corpoErro = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;

        setEstado({
          kind: "erro",
          mensagem: corpoErro?.error?.message ?? `A API recusou o pedido (HTTP ${String(response.status)}).`,
        });

        return;
      }

      setEstado({ kind: "enfileirado", mensagem });
      // O estado real vive no banco e muda pelo worker: a tela relê em vez de
      // fingir que já sabe o desfecho.
      router.refresh();
    } catch {
      setEstado({ kind: "erro", mensagem: "Falha de conexão com a API." });
    }
  }

  return (
    <div style={{ display: "grid", gap: "var(--sb-space-2)" }}>
      {/*
        SÓ O ESTADO. Motivo da falha e anúncio filho já são colunas da tabela
        logo abaixo — repeti-los aqui seria o mesmo dado em dois lugares na
        mesma tela, e o primeiro a divergir seria este. O estado fica porque é
        dele que dependem os botões.
      */}
      {operacao !== null && (
        <p style={{ margin: 0, fontSize: "0.8125rem" }}>
          Operação atual: <b>{relistStatusLabel(operacao.status)}</b>
        </p>
      )}

      {!podeRepublicar && (
        <p style={{ margin: 0, fontSize: "0.75rem", color: "var(--sb-text-soft)" }}>
          Republicar é decisão de gestão: só ADMIN e GESTOR podem pedir. Quem atende não encerra anúncio.
        </p>
      )}

      {podeRepublicar && !viva && (
        <div>
          <button
            type="button"
            className="sb-button"
            disabled={estado.kind === "enviando"}
            onClick={() => {
              setEstado({ kind: "confirmando-pedido" });
            }}
          >
            Pedir republicação
          </button>
        </div>
      )}

      {podeRepublicar && executavel && (
        <div>
          <button
            type="button"
            className="sb-button sb-button-danger"
            disabled={estado.kind === "enviando"}
            onClick={() => {
              setEstado({ kind: "confirmando-execucao" });
            }}
          >
            Executar republicação
          </button>
        </div>
      )}

      {estado.kind === "enfileirado" && (
        <p role="status" style={{ margin: 0, fontSize: "0.75rem", color: "var(--sb-secondary)" }}>
          {estado.mensagem}
        </p>
      )}

      {estado.kind === "erro" && (
        <p role="alert" style={{ margin: 0, fontSize: "0.75rem", color: "var(--sb-danger)" }}>
          {estado.mensagem}
        </p>
      )}

      {estado.kind === "confirmando-pedido" && (
        <Confirmacao
          eyebrow="Pedir republicação"
          titulo={`Pedir republicação de ${itemId}`}
          confirmar="Pedir republicação"
          onCancel={() => {
            setEstado({ kind: "idle" });
          }}
          onConfirm={() => {
            void chamar(
              "/v1/listings/relist",
              { mlAccountId, itemId },
              "Pedido enfileirado. A conferência roda no worker e o estado aparece aqui quando terminar.",
            );
          }}
        >
          <p style={{ margin: 0 }}>
            Este ato <b>não fecha nada</b>. Ele guarda o retrato do anúncio e roda a conferência prévia — a que
            recusa republicar anúncio já republicado, com estoque no Full, de catálogo ou que já é filho de outra
            republicação.
          </p>
          <p style={{ margin: 0 }}>
            Se a conferência aprovar, a operação fica <b>aguardando execução</b> — e é a execução, num segundo
            passo, que fecha este anúncio.
          </p>
        </Confirmacao>
      )}

      {estado.kind === "confirmando-execucao" && operacao !== null && (
        <Confirmacao
          eyebrow="Executar republicação"
          titulo={`Fechar ${itemId} e republicar`}
          confirmar="Fechar e republicar"
          perigoso
          exigirCiencia="Entendo que fechar este anúncio é irreversível."
          onCancel={() => {
            setEstado({ kind: "idle" });
          }}
          onConfirm={() => {
            void chamar(
              `/v1/listings/relist/${operacao.id}/execute`,
              {},
              "Execução enfileirada. O worker refaz a conferência, fecha o anúncio e republica.",
            );
          }}
        >
          {/*
            A CONSEQUÊNCIA, escrita — a mesma régua da curadoria em lote
            (D-127): confirmação que só conta quantos não é confirmação.
          */}
          <p style={{ margin: 0 }}>
            O anúncio <span className="sb-mono">{itemId}</span> será <b>fechado no Mercado Livre</b>, e fechar é{" "}
            <b>irreversível</b>: ele não volta a ficar ativo.
          </p>
          <p style={{ margin: 0 }}>
            No lugar dele nasce um anúncio <b>novo, com outro MLB</b>. Anúncio grátis não herda visitas nem vendas,
            e a exposição não é prometida por ninguém — nem pelo Mercado Livre, nem por esta tela.
          </p>
          <p style={{ margin: 0 }}>
            A conferência prévia roda <b>de novo agora</b>, com o estado atual do anúncio: se algo mudou desde o
            pedido, a operação para antes de fechar.
          </p>
        </Confirmacao>
      )}
    </div>
  );
}

/**
 * A caixa de confirmação — `.sb-modal` da casa, como a curadoria em lote e os
 * Filtros Salvos. `exigirCiencia` acrescenta a caixa de seleção que destrava o
 * botão: ela existe só no ato irreversível.
 */
function Confirmacao({
  eyebrow,
  titulo,
  confirmar,
  perigoso = false,
  exigirCiencia,
  onCancel,
  onConfirm,
  children,
}: {
  eyebrow: string;
  titulo: string;
  confirmar: string;
  perigoso?: boolean;
  exigirCiencia?: string;
  onCancel: () => void;
  onConfirm: () => void;
  children: ReactNode;
}): ReactNode {
  const [ciente, setCiente] = useState(false);
  const travado = exigirCiencia !== undefined && !ciente;

  return (
    <div className="sb-backdrop" onClick={onCancel}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={titulo}
        className="sb-modal"
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <span className="sb-modal-eyebrow">{eyebrow}</span>
        <h2 style={{ margin: "0 0 var(--sb-space-2)", fontSize: "1rem" }}>{titulo}</h2>

        <div style={{ display: "grid", gap: "var(--sb-space-2)", fontSize: "0.8125rem" }}>{children}</div>

        {exigirCiencia !== undefined && (
          <label style={{ display: "flex", gap: "0.5rem", alignItems: "flex-start", marginTop: "var(--sb-space-3)", fontSize: "0.8125rem" }}>
            <input
              type="checkbox"
              checked={ciente}
              onChange={(event) => {
                setCiente(event.target.checked);
              }}
            />
            <span>{exigirCiencia}</span>
          </label>
        )}

        <div style={{ display: "flex", gap: "var(--sb-space-2)", marginTop: "var(--sb-space-3)", justifyContent: "flex-end" }}>
          <button type="button" className="sb-button" onClick={onCancel}>
            Cancelar
          </button>
          <button
            type="button"
            className={perigoso ? "sb-button sb-button-danger" : "sb-button sb-button-primary"}
            disabled={travado}
            onClick={onConfirm}
          >
            {confirmar}
          </button>
        </div>
      </div>
    </div>
  );
}
