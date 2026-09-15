"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

import { CampoFoto } from "../../components/campo-foto";
import { explicar404 } from "../../lib/api-desatualizada";
import { salvarFoto } from "../../lib/foto-perfil";
import { createClient } from "../../lib/supabase/browser";
import { LinkDeAcesso } from "./link-de-acesso";
import type { AccountOption } from "./member-controls";

/**
 * "Convidar usuário" (D-296) — e, desde D-354, com NOME e FOTO.
 *
 * O caminho é o da casa para toda escrita privilegiada: a `api`, porque criar
 * usuário exige a chave de service role, que nunca alcança o navegador (D-012).
 *
 * ## Nome obrigatório, foto opcional
 *
 * Sem nome, a pessoa aparecia como "sem nome no perfil" até ela mesma entrar e
 * se nomear — e quem convida é justamente quem sabe o nome. Ele vai nos
 * metadados do usuário criado, e o trigger `handle_new_auth_user` o grava no
 * perfil no mesmo instante.
 *
 * A foto é opcional aqui e em todo lugar: a própria pessoa pode colocar a dela
 * depois, pelo "Meu perfil". Ela sobe DEPOIS do convite, porque antes a pessoa
 * não existe — não há pasta `<user_id>/` para onde mandar.
 *
 * ## O LINK
 *
 * O convite não é enviado por e-mail: o projeto não tem SMTP próprio, e dizer
 * "convite enviado" sobre uma entrega que ninguém provou seria a promessa que
 * esta casa recusa. A `api` devolve o link, e quem convidou o envia. **O link é
 * credencial**: aparece uma vez, com o aviso ao lado.
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
  | { kind: "convidado"; link: string; fotoErro: string | null }
  | { kind: "vinculado"; fotoErro: string | null }
  | { kind: "ja_membro" }
  | { kind: "erro"; mensagem: string };

export function ConvidarUsuario({ accounts }: { accounts: AccountOption[] }): ReactNode {
  const router = useRouter();
  const [estado, setEstado] = useState<Estado>({ kind: "fechado" });
  const [nome, setNome] = useState("");
  const [email, setEmail] = useState("");
  const [papel, setPapel] = useState<string>("OPERADOR");
  const [contas, setContas] = useState<string[]>([]);
  const [foto, setFoto] = useState<Blob | null>(null);

  /** ADMIN alcança todas as contas por PAPEL: pedir contas para ele seria ruído. */
  const pedeContas = papel !== "ADMIN";

  /**
   * A foto sobe com a sessão de quem convida: a policy do bucket aceita o ADMIN
   * de uma organização da qual a pessoa JÁ é membro — e a `api` acabou de criar
   * esse vínculo. Falhar aqui não desfaz o convite: ele valeu, e a frase diz.
   */
  async function enviarFoto(userId: string | undefined): Promise<string | null> {
    if (foto === null || userId === undefined) return null;

    try {
      await salvarFoto(userId, foto, null);

      return null;
    } catch (falha) {
      return falha instanceof Error ? falha.message : "A foto não foi salva.";
    }
  }

  async function convidar(): Promise<void> {
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
          fullName: nome.trim().replace(/\s+/g, " "),
          role: papel,
          ...(pedeContas && contas.length > 0 ? { mlAccountIds: contas } : {}),
        }),
      });

      const corpo = (await response.json().catch(() => null)) as
        | { status?: string; userId?: string; inviteLink?: string; error?: { message?: string } }
        | null;

      if (!response.ok) {
        // 404 de rota que está no código é a `api` no ar mais velha que a tela (D-301).
        if (response.status === 404) {
          setEstado({ kind: "erro", mensagem: await explicar404(API_URL) });

          return;
        }

        /*
          O texto do servidor chega inteiro. 401 tem frase própria (D-300):
          web e API apontando para projetos Supabase diferentes.
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

      if (corpo?.status === "already_member") {
        router.refresh();
        setEstado({ kind: "ja_membro" });

        return;
      }

      const fotoErro = await enviarFoto(corpo?.userId);

      router.refresh();

      if (corpo?.status === "invited" && corpo.inviteLink !== undefined) {
        setEstado({ kind: "convidado", link: corpo.inviteLink, fotoErro });
      } else {
        setEstado({ kind: "vinculado", fotoErro });
      }
    } catch {
      setEstado({ kind: "erro", mensagem: `Falha de conexão com a API em ${API_URL}.` });
    }
  }

  function fechar(): void {
    setEstado({ kind: "fechado" });
    setNome("");
    setEmail("");
    setContas([]);
    setFoto(null);
  }

  const emailValido = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const nomeValido = nome.trim().length > 0 && nome.trim().length <= 200;
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
            className="sb-modal sb-modal-convite"
            onClick={(event) => {
              event.stopPropagation();
            }}
          >
            <span className="sb-modal-eyebrow">Convidar usuário</span>
            <h2 className="sb-modal-convite-titulo">Dar acesso a esta organização</h2>

            {(estado.kind === "aberto" || estado.kind === "enviando" || estado.kind === "erro") && (
              <form
                className="sb-convite-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (emailValido && nomeValido && !enviando) void convidar();
                }}
              >
                <section className="sb-form-secao">
                  <span className="sb-form-secao-titulo">Quem</span>

                  <CampoFoto
                    nome={nome.trim() === "" ? email : nome}
                    fotoAtual={null}
                    modo={{ tipo: "pendente", onEscolher: setFoto }}
                  />

                  <label className="sb-form-campo">
                    <span>Nome completo</span>
                    <input
                      className="sb-input sb-input-full"
                      type="text"
                      autoComplete="off"
                      maxLength={200}
                      value={nome}
                      placeholder="Ex.: Carla Nogueira"
                      disabled={enviando}
                      onChange={(event) => {
                        setNome(event.target.value);
                      }}
                    />
                  </label>

                  <label className="sb-form-campo">
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
                    <small>É o login da pessoa. Não dá para trocar depois pela tela.</small>
                  </label>
                </section>

                <section className="sb-form-secao">
                  <span className="sb-form-secao-titulo">O que pode fazer</span>

                  <label className="sb-form-campo">
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
                    <small>{PAPEIS.find((p) => p.valor === papel)?.descricao}</small>
                  </label>

                  {/*
                    O ALCANCE é o que o papel NÃO decide (D-117). ADMIN alcança
                    todas por papel, então a lista some para ele.
                  */}
                  {pedeContas && (
                    <div className="sb-form-campo">
                      <span>Contas que essa pessoa vai alcançar</span>
                      {accounts.length === 0 ? (
                        <small>Nenhuma conta cadastrada ainda — a pessoa entra sem alcance, e você pode dar depois.</small>
                      ) : (
                        <div className="sb-contas-grade">
                          {accounts.map((conta) => (
                            <label key={conta.id} className="sb-conta-opcao">
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
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </section>

                {estado.kind === "erro" && (
                  <p role="alert" className="sb-campo-erro">
                    {estado.mensagem}
                  </p>
                )}

                <div className="sb-modal-acoes">
                  <button type="button" className="sb-button" onClick={fechar} disabled={enviando}>
                    Cancelar
                  </button>
                  <button
                    type="submit"
                    className="sb-button sb-button-primary"
                    disabled={!emailValido || !nomeValido || enviando}
                  >
                    {enviando ? "Convidando…" : "Convidar"}
                  </button>
                </div>
              </form>
            )}

            {estado.kind === "convidado" && (
              <div className="sb-convite-resultado">
                <p style={{ margin: 0 }}>
                  Conta criada. <b>Envie o link abaixo para a pessoa</b> — é por ele que ela define a senha.
                </p>

                <LinkDeAcesso link={estado.link} />

                {estado.fotoErro !== null && (
                  <p role="alert" className="sb-campo-erro">
                    O convite valeu, mas a foto não foi salva: {estado.fotoErro} Dá para colocar depois, na gaveta
                    da pessoa.
                  </p>
                )}

                <div className="sb-modal-acoes">
                  <button type="button" className="sb-button sb-button-primary" onClick={fechar}>
                    Concluir
                  </button>
                </div>
              </div>
            )}

            {(estado.kind === "vinculado" || estado.kind === "ja_membro") && (
              <div className="sb-convite-resultado">
                <p style={{ margin: 0 }}>
                  {estado.kind === "vinculado"
                    ? "Essa pessoa já tinha conta no sistema — o acesso a esta organização foi concedido, e não há link a enviar."
                    : "Essa pessoa já é membro desta organização. Papel e alcance não foram alterados: para mudá-los, abra a gaveta dela."}
                </p>

                {estado.kind === "vinculado" && estado.fotoErro !== null && (
                  <p role="alert" className="sb-campo-erro">
                    A foto não foi salva: {estado.fotoErro}
                  </p>
                )}

                <div className="sb-modal-acoes">
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
