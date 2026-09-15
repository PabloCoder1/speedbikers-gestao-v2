"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

import { chamarApi } from "../../lib/chamar-api";
import { removeMember } from "./actions";

/**
 * SUSPENDER, REATIVAR e REMOVER — a "zona de acesso" da gaveta (D-354).
 *
 * As duas saídas que o pedido "tirar acesso" contém, com a diferença dita:
 *
 * - **Suspender** mantém tudo e só impede a pessoa de entrar. Reversível. Mora
 *   no Auth, então passa pela `api` (service role, D-012).
 * - **Remover da organização** apaga o vínculo e o alcance nas contas. O
 *   histórico fica. Mora numa Server Action sob RLS, com `guard_last_admin`.
 *
 * **Os dois pedem confirmação**, e a confirmação diz o efeito com o nome da
 * pessoa. Não é cerimônia: um clique errado aqui tranca alguém fora do sistema.
 *
 * Nada disto aparece para a própria conta de quem olha. Suspender-se ou
 * remover-se é trancar a porta com a chave do lado de fora.
 */

type Confirmando = "suspender" | "reativar" | "remover" | null;

export function AcessoDoMembro({
  organizationId,
  userId,
  nome,
  suspenso,
  ehVoceMesmo,
  ehUltimoAdmin,
}: {
  organizationId: string;
  userId: string;
  nome: string;
  suspenso: boolean;
  ehVoceMesmo: boolean;
  ehUltimoAdmin: boolean;
}): ReactNode {
  const router = useRouter();
  const [confirmando, setConfirmando] = useState<Confirmando>(null);
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  if (ehVoceMesmo) {
    return (
      <div className="sb-drawer-card sb-zona-acesso">
        <h4>Acesso</h4>
        <p className="sb-zona-acesso-texto">
          Esta é a sua conta. Suspender ou remover o próprio acesso não é possível por aqui — peça a outro
          ADMIN.
        </p>
      </div>
    );
  }

  async function aplicarSuspensao(suspender: boolean): Promise<void> {
    setOcupado(true);
    setErro(null);

    const resposta = await chamarApi<{ status: string }>(`/v1/organization/members/${userId}/suspension`, {
      suspended: suspender,
    });

    setOcupado(false);

    if (!resposta.ok) {
      setErro(resposta.mensagem);

      return;
    }

    setConfirmando(null);
    router.refresh();
  }

  async function remover(): Promise<void> {
    setOcupado(true);
    setErro(null);

    const resultado = await removeMember(organizationId, userId);

    setOcupado(false);

    if (!resultado.ok) {
      setErro(resultado.message);

      return;
    }

    setConfirmando(null);
    router.refresh();
  }

  return (
    <div className="sb-drawer-card sb-zona-acesso">
      <h4>Acesso</h4>

      {confirmando === null && (
        <>
          <div className="sb-zona-acesso-linha">
            <div>
              <b>{suspenso ? "Acesso suspenso" : "Suspender acesso"}</b>
              <p className="sb-zona-acesso-texto">
                {suspenso
                  ? "A pessoa não consegue entrar. Papel, contas e histórico continuam guardados."
                  : "Impede a pessoa de entrar, sem apagar nada. Dá para reativar depois."}
              </p>
            </div>
            <button
              type="button"
              className="sb-button"
              disabled={ocupado}
              onClick={() => {
                setErro(null);
                setConfirmando(suspenso ? "reativar" : "suspender");
              }}
            >
              {suspenso ? "Reativar acesso" : "Suspender acesso"}
            </button>
          </div>

          <div className="sb-zona-acesso-linha">
            <div>
              <b>Remover da organização</b>
              <p className="sb-zona-acesso-texto">
                {ehUltimoAdmin
                  ? "Indisponível: é o único ADMIN. Promova outra pessoa antes."
                  : "Apaga o vínculo e o acesso às contas. O histórico continua."}
              </p>
            </div>
            <button
              type="button"
              className="sb-button sb-button-perigo-contorno"
              disabled={ocupado || ehUltimoAdmin}
              onClick={() => {
                setErro(null);
                setConfirmando("remover");
              }}
            >
              Remover
            </button>
          </div>
        </>
      )}

      {confirmando !== null && (
        <div className={`sb-confirmacao${confirmando === "reativar" ? "" : " sb-confirmacao-perigo"}`}>
          <p>
            {confirmando === "suspender" &&
              `Suspender o acesso de ${nome}? A pessoa não consegue mais entrar. Uma sessão já aberta vale até o token expirar (até 1 hora).`}
            {confirmando === "reativar" && `Reativar o acesso de ${nome}? A pessoa volta a entrar com a senha que já tinha.`}
            {confirmando === "remover" &&
              `Remover ${nome} desta organização? O vínculo e o acesso às contas são apagados. Para voltar, será preciso convidar de novo.`}
          </p>
          <div className="sb-confirmacao-botoes">
            <button
              type="button"
              className="sb-button"
              disabled={ocupado}
              onClick={() => {
                setConfirmando(null);
              }}
            >
              Cancelar
            </button>
            <button
              type="button"
              className={confirmando === "reativar" ? "sb-button sb-button-primary" : "sb-button sb-button-danger"}
              disabled={ocupado}
              onClick={() => {
                if (confirmando === "remover") void remover();
                else void aplicarSuspensao(confirmando === "suspender");
              }}
            >
              {ocupado
                ? "Aplicando…"
                : confirmando === "suspender"
                  ? "Suspender"
                  : confirmando === "reativar"
                    ? "Reativar"
                    : "Remover da organização"}
            </button>
          </div>
        </div>
      )}

      {erro !== null && (
        <p role="alert" className="sb-campo-erro">
          {erro}
        </p>
      )}
    </div>
  );
}
