"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

import { createClient } from "../../lib/supabase/browser";
import type { AccountOption } from "./member-controls";

/**
 * "Convidar usuário" (D-296) — o botão que o frame desenha no cabeçalho desta
 * tela desde sempre, e que D-271 recusou por ser **feature, não composição**.
 *
 * A recusa continua valendo como regra de fatia visual; o que mudou foi o
 * pedido. E o caminho é o da casa para toda escrita privilegiada: a `api`,
 * porque criar usuário exige a chave de service role, que nunca alcança o
 * navegador (D-012).
 *
 * ## O LINK, e por que ele aparece aqui
 *
 * O convite não é enviado por e-mail: o projeto não tem SMTP próprio, e dizer
 * "convite enviado" sobre uma entrega que ninguém provou seria a promessa que
 * esta casa recusa em toda fatia. A `api` devolve o **link de convite**, e
 * quem convidou o envia pelo canal que já usa.
 *
 * **O link é credencial**: quem o abrir define a senha daquela conta. Por isso
 * ele aparece uma vez, com o aviso ao lado — e não é gravado em lugar nenhum
 * desta tela.
 */

/**
 * O endereço da `api`. Ele é embutido NO BUILD (`NEXT_PUBLIC_*`), então uma
 * instalação que não o declara chega aqui como string vazia — e a chamada sai
 * relativa, batendo no próprio Next, que responde 404 em HTML.
 *
 * Isso não é hipótese: foi o que aconteceu na primeira vez que o botão foi
 * usado nesta máquina, e a tela dizia só "A API recusou o convite (HTTP 404)"
 * — mensagem que manda procurar defeito na API que sequer foi chamada.
 */
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "";

/** Os cinco papéis do `check`, na ordem de alcance — a mesma de `member-controls`. */
const PAPEIS = [
  { valor: "VISUALIZADOR", descricao: "Só lê." },
  { valor: "OPERADOR", descricao: "Atende e opera o dia a dia." },
  { valor: "ANALISTA", descricao: "Lê tudo e analisa; não encerra anúncio." },
  { valor: "GESTOR", descricao: "Decide compra e republicação." },
  { valor: "ADMIN", descricao: "Tudo, incluindo papéis e acessos — alcança todas as contas." },
] as const;

type Estado =
  | { kind: "fechado" }
  | { kind: "aberto" }
  | { kind: "enviando" }
  | { kind: "convidado"; link: string }
  | { kind: "vinculado" }
  | { kind: "ja_membro" }
  | { kind: "erro"; mensagem: string };

export function ConvidarUsuario({ accounts }: { accounts: AccountOption[] }): ReactNode {
  const router = useRouter();
  const [estado, setEstado] = useState<Estado>({ kind: "fechado" });
  const [email, setEmail] = useState("");
  const [papel, setPapel] = useState<string>("OPERADOR");
  const [contas, setContas] = useState<string[]>([]);
  const [copiado, setCopiado] = useState(false);

  /** ADMIN alcança todas as contas por PAPEL: pedir contas para ele seria ruído. */
  const pedeContas = papel !== "ADMIN";

  async function convidar(): Promise<void> {
    /*
      SEM ENDEREÇO NÃO HÁ CHAMADA. Criar usuário exige a chave de service role,
      que vive só na `api` (D-012): sem o endereço dela, não existe caminho —
      e dizer isso é melhor que gastar uma ida contra o próprio Next.
    */
    if (API_URL === "") {
      setEstado({
        kind: "erro",
        mensagem:
          "Esta instalação não sabe o endereço da API (NEXT_PUBLIC_API_URL). O convite é escrita privilegiada e não acontece sem ela.",
      });

      return;
    }

    setEstado({ kind: "enviando" });

    const supabase = createClient();
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;

    if (token === undefined) {
      setEstado({ kind: "erro", mensagem: "Sessão expirada — atualize a página e entre de novo." });

      return;
    }

    try {
      const response = await fetch(`${API_URL}/v1/organization/invites`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({
          email: email.trim(),
          role: papel,
          ...(pedeContas && contas.length > 0 ? { mlAccountIds: contas } : {}),
        }),
      });

      const corpo = (await response.json().catch(() => null)) as
        | { status?: string; inviteLink?: string; error?: { message?: string } }
        | null;

      if (!response.ok) {
        /*
          O texto do servidor chega inteiro: 403 de papel, 400 de conta de
          outra organização. Traduzir tudo em "não foi possível" apagaria o
          que faz a pessoa entender o próximo passo.

          E quando NÃO vem corpo de erro nenhum, quem respondeu quase nunca é a
          `api`: é o Next servindo 404 em HTML porque o endereço aponta para
          ele, ou um proxy no meio. A mensagem diz isso em vez de acusar a API.
        */
        /*
          401 tem texto PROPRIO, e ele nasceu de um diagnostico que custou uma
          tarde (D-300). A API recusa o token quando ele foi emitido por OUTRO
          projeto Supabase -- e isso acontece sozinho: `SUPABASE_URL` exportada
          no ambiente vence o `.env.local`, porque `--env-file` do Node nao
          sobrescreve variavel que ja existe. A web fala com um Supabase, a API
          com outro, e todo token legitimo e recusado.

          "Nao autorizado" mandaria conferir papel, que esta certo. A frase
          abaixo manda conferir o que de fato esta errado, e diz onde ler.
        */
        setEstado({
          kind: "erro",
          mensagem:
            corpo?.error?.message ??
            (response.status === 401
              ? "A API recusou o token. Se você entrou normalmente, o mais provável é que web e API estejam apontando para projetos Supabase DIFERENTES — o log de boot da API mostra o `supabase_host` que ela usa."
              : `${API_URL} não respondeu como a API (HTTP ${String(response.status)}). Confira o endereço e se a API está no ar.`),
        });

        return;
      }

      router.refresh();

      if (corpo?.status === "invited" && corpo.inviteLink !== undefined) {
        setEstado({ kind: "convidado", link: corpo.inviteLink });
      } else if (corpo?.status === "already_member") {
        setEstado({ kind: "ja_membro" });
      } else {
        setEstado({ kind: "vinculado" });
      }
    } catch {
      // O endereço entra na frase: "falha de conexão" sozinho não diz COM O
      // QUE, e é o endereço que a pessoa vai conferir a seguir.
      setEstado({ kind: "erro", mensagem: `Falha de conexão com a API em ${API_URL}.` });
    }
  }

  function fechar(): void {
    setEstado({ kind: "fechado" });
    setEmail("");
    setContas([]);
    setCopiado(false);
  }

  const emailValido = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const enviando = estado.kind === "enviando";

  return (
    <>
      <button
        type="button"
        className="sb-button sb-button-primary"
        onClick={() => {
          setEstado({ kind: "aberto" });
        }}
      >
        Convidar usuário
      </button>

      {estado.kind !== "fechado" && (
        <div className="sb-backdrop" onClick={fechar}>
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Convidar usuário"
            className="sb-modal"
            onClick={(event) => {
              event.stopPropagation();
            }}
          >
            <span className="sb-modal-eyebrow">Convidar usuário</span>
            <h2 style={{ margin: "0 0 var(--sb-space-3)", fontSize: "1rem" }}>Dar acesso a esta organização</h2>

            {(estado.kind === "aberto" || estado.kind === "enviando" || estado.kind === "erro") && (
              <div style={{ display: "grid", gap: "var(--sb-space-3)" }}>
                <label style={{ display: "grid", gap: "0.25rem", fontSize: "0.75rem" }}>
                  <span>E-mail</span>
                  <input
                    className="sb-input sb-input-full"
                    type="email"
                    autoComplete="off"
                    value={email}
                    placeholder="pessoa@empresa.com"
                    disabled={enviando}
                    onChange={(event) => {
                      setEmail(event.target.value);
                    }}
                  />
                </label>

                <label style={{ display: "grid", gap: "0.25rem", fontSize: "0.75rem" }}>
                  <span>Papel</span>
                  <select
                    className="sb-input sb-input-full"
                    value={papel}
                    disabled={enviando}
                    onChange={(event) => {
                      setPapel(event.target.value);
                    }}
                  >
                    {PAPEIS.map((p) => (
                      <option key={p.valor} value={p.valor}>
                        {p.valor}
                      </option>
                    ))}
                  </select>
                  <small style={{ color: "var(--sb-text-soft)" }}>
                    {PAPEIS.find((p) => p.valor === papel)?.descricao}
                  </small>
                </label>

                {/*
                  O ALCANCE, e ele é o que o papel NÃO decide: papel diz o que a
                  pessoa pode fazer; conta diz sobre o que ela faz (D-117). ADMIN
                  alcança todas por papel, então a lista some para ele em vez de
                  ficar ali sem efeito.
                */}
                {pedeContas && (
                  <div style={{ display: "grid", gap: "0.25rem", fontSize: "0.75rem" }}>
                    <span>Contas que essa pessoa vai alcançar</span>
                    {accounts.length === 0 ? (
                      <small style={{ color: "var(--sb-text-soft)" }}>
                        Nenhuma conta cadastrada ainda — a pessoa entra sem alcance, e você pode dar depois.
                      </small>
                    ) : (
                      accounts.map((conta) => (
                        <label key={conta.id} style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                          <input
                            type="checkbox"
                            checked={contas.includes(conta.id)}
                            disabled={enviando}
                            onChange={(event) => {
                              setContas((atual) =>
                                event.target.checked
                                  ? [...atual, conta.id]
                                  : atual.filter((id) => id !== conta.id),
                              );
                            }}
                          />
                          <span>{conta.label}</span>
                        </label>
                      ))
                    )}
                  </div>
                )}

                {estado.kind === "erro" && (
                  <p role="alert" style={{ margin: 0, color: "var(--sb-danger)", fontSize: "0.75rem" }}>
                    {estado.mensagem}
                  </p>
                )}

                <div style={{ display: "flex", gap: "var(--sb-space-2)", justifyContent: "flex-end" }}>
                  <button type="button" className="sb-button" onClick={fechar} disabled={enviando}>
                    Cancelar
                  </button>
                  <button
                    type="button"
                    className="sb-button sb-button-primary"
                    disabled={!emailValido || enviando}
                    onClick={() => {
                      void convidar();
                    }}
                  >
                    {enviando ? "Convidando…" : "Convidar"}
                  </button>
                </div>
              </div>
            )}

            {estado.kind === "convidado" && (
              <div style={{ display: "grid", gap: "var(--sb-space-2)", fontSize: "0.8125rem" }}>
                <p style={{ margin: 0 }}>
                  Conta criada. <b>Envie o link abaixo para a pessoa</b> — é por ele que ela define a senha.
                </p>

                {/*
                  O AVISO NÃO É ENFEITE: o link é credencial. Quem o abrir define
                  a senha daquela conta, e ele não volta a aparecer aqui.
                */}
                <p className="sb-note sb-note-atencao" style={{ margin: 0 }}>
                  <span>Trate como senha</span>
                  <span
                    style={{
                      display: "block",
                      fontFamily: "var(--sb-sans)",
                      fontSize: "0.6875rem",
                      marginTop: "0.375rem",
                    }}
                  >
                    Quem abrir este link define a senha da conta. Ele aparece uma vez só e não fica guardado nesta
                    tela.
                  </span>
                </p>

                <textarea className="sb-input sb-input-full" readOnly rows={3} value={estado.link} />

                <div style={{ display: "flex", gap: "var(--sb-space-2)", justifyContent: "flex-end" }}>
                  <button
                    type="button"
                    className="sb-button"
                    onClick={() => {
                      void navigator.clipboard.writeText(estado.link).then(() => {
                        setCopiado(true);
                      });
                    }}
                  >
                    {copiado ? "Copiado" : "Copiar link"}
                  </button>
                  <button type="button" className="sb-button sb-button-primary" onClick={fechar}>
                    Concluir
                  </button>
                </div>
              </div>
            )}

            {(estado.kind === "vinculado" || estado.kind === "ja_membro") && (
              <div style={{ display: "grid", gap: "var(--sb-space-2)", fontSize: "0.8125rem" }}>
                <p style={{ margin: 0 }}>
                  {estado.kind === "vinculado"
                    ? "Essa pessoa já tinha conta no sistema — o acesso a esta organização foi concedido, e não há link a enviar."
                    : "Essa pessoa já é membro desta organização. Papel e alcance não foram alterados: para mudá-los, use os controles da linha dela."}
                </p>
                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  <button type="button" className="sb-button sb-button-primary" onClick={fechar}>
                    Fechar
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
