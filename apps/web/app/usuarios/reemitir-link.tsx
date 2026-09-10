"use client";

import { useState, type ReactNode } from "react";

import { explicar404 } from "../../lib/api-desatualizada";
import { createClient } from "../../lib/supabase/browser";
import { LinkDeAcesso } from "./link-de-acesso";

/**
 * "Gerar novo link de acesso" — a saída para quem tem vínculo e não consegue
 * entrar (D-303).
 *
 * O convite mostra o link UMA VEZ e não o guarda, porque ele é credencial.
 * Convidar de novo devolve "já é membro" sem link, de propósito: repetir o
 * convite não pode mudar papel nem alcance.
 *
 * Sobrava o caso real, e ele apareceu no primeiro uso de verdade: o link se
 * perdeu, ou foi aberto antes de a tela de definir senha existir. A pessoa
 * ficava com vínculo, conta no Auth e nenhum caminho de entrada — e a única
 * saída seria apagar o usuário, que apaga junto a trilha de acesso dela.
 *
 * **O botão pede confirmação antes de gerar.** Não é cerimônia: o link vale
 * como senha da conta de destino, e um clique sem aviso ao lado de "Inspecionar"
 * seria fácil demais para o que ele faz.
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "";

type Estado =
  | { kind: "parado" }
  | { kind: "confirmando" }
  | { kind: "gerando" }
  | { kind: "pronto"; link: string }
  | { kind: "erro"; mensagem: string };

export function ReemitirLink({ userId, nome }: { userId: string; nome: string }): ReactNode {
  const [estado, setEstado] = useState<Estado>({ kind: "parado" });

  async function gerar(): Promise<void> {
    if (API_URL === "") {
      setEstado({
        kind: "erro",
        mensagem:
          "Esta instalação não sabe o endereço da API (NEXT_PUBLIC_API_URL). Emitir link é escrita privilegiada e não acontece sem ela.",
      });

      return;
    }

    setEstado({ kind: "gerando" });

    const { data } = await createClient().auth.getSession();
    const token = data.session?.access_token;

    if (token === undefined) {
      setEstado({ kind: "erro", mensagem: "Sessão expirada — atualize a página e entre de novo." });

      return;
    }

    try {
      const response = await fetch(`${API_URL}/v1/organization/members/${userId}/access-link`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });

      const corpo = (await response.json().catch(() => null)) as
        | { link?: string; error?: { message?: string } }
        | null;

      if (!response.ok) {
        // 404 de rota é a API velha, não "pessoa não encontrada" — a diferença
        // está em `explicar404`, que pergunta ao `/health` qual versão está no
        // ar (D-301). O 404 DA PESSOA chega com mensagem no corpo.
        setEstado({
          kind: "erro",
          mensagem:
            corpo?.error?.message ??
            (response.status === 404
              ? await explicar404(API_URL)
              : `${API_URL} não respondeu como a API (HTTP ${String(response.status)}).`),
        });

        return;
      }

      if (corpo?.link === undefined) {
        setEstado({ kind: "erro", mensagem: "A API respondeu sem o link." });

        return;
      }

      setEstado({ kind: "pronto", link: corpo.link });
    } catch {
      setEstado({ kind: "erro", mensagem: `Falha de conexão com a API em ${API_URL}.` });
    }
  }

  if (estado.kind === "pronto") {
    return (
      <div style={{ marginTop: "var(--sb-space-3)" }}>
        <h4 className="sb-section-label">Link de acesso</h4>
        <p style={{ fontSize: "0.6875rem", color: "var(--sb-text-soft)", margin: "0 0 var(--sb-space-2)" }}>
          Envie para {nome} pelo canal que vocês já usam. É por ele que a pessoa define a senha.
        </p>
        <LinkDeAcesso link={estado.link} />
      </div>
    );
  }

  return (
    <div style={{ marginTop: "var(--sb-space-3)" }}>
      <h4 className="sb-section-label">Acesso</h4>

      {estado.kind === "confirmando" ? (
        <>
          <p style={{ fontSize: "0.6875rem", color: "var(--sb-text-soft)", margin: "0 0 var(--sb-space-2)" }}>
            O link vale como senha: quem abrir define a senha desta conta. Gere só quando for você
            mesmo a enviar para {nome}.
          </p>
          <div style={{ display: "flex", gap: "var(--sb-space-2)" }}>
            <button
              type="button"
              className="sb-button"
              onClick={() => {
                setEstado({ kind: "parado" });
              }}
            >
              Cancelar
            </button>
            <button
              type="button"
              className="sb-button sb-button-primary"
              onClick={() => {
                void gerar();
              }}
            >
              Gerar link
            </button>
          </div>
        </>
      ) : (
        <>
          <p style={{ fontSize: "0.6875rem", color: "var(--sb-text-soft)", margin: "0 0 var(--sb-space-2)" }}>
            Use quando a pessoa não conseguir entrar — link perdido, ou senha que ela nunca chegou a
            definir.
          </p>
          <button
            type="button"
            className="sb-button"
            disabled={estado.kind === "gerando"}
            onClick={() => {
              setEstado({ kind: "confirmando" });
            }}
          >
            {estado.kind === "gerando" ? "Gerando…" : "Gerar novo link de acesso"}
          </button>
        </>
      )}

      {estado.kind === "erro" && (
        <p role="alert" style={{ color: "var(--sb-danger)", fontSize: "0.6875rem", marginTop: "0.5rem" }}>
          {estado.mensagem}
        </p>
      )}
    </div>
  );
}
