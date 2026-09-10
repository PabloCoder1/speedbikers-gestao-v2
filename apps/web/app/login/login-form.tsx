"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

import { lerConviteDaUrl, type ConviteNaUrl } from "../../lib/invite-hash";
import { safeNext } from "../../lib/safe-next";
import { createClient, missingBrowserEnv } from "../../lib/supabase/browser";

/**
 * Entrada — e, desde D-302, também a ACEITAÇÃO DO CONVITE.
 *
 * Sistema interno: acesso é concedido pelo ADMIN, não por autocadastro. Por
 * isso não há "criar conta" — quem não tem acesso pede a quem administra.
 *
 * ## Por que a aceitação mora aqui, e não numa rota própria
 *
 * O convite de D-296 devolve um link do Supabase que, depois de verificado,
 * redireciona para a URL do site com a sessão no **fragmento**
 * (`#access_token=…&type=invite`). Medido em 2026-09-10: o fragmento nunca
 * chega ao servidor, então o proxy não vê cookie e manda a pessoa para
 * `/login` — **levando o fragmento junto**, porque o navegador o preserva no
 * redirect.
 *
 * Ou seja: quem foi convidado já cai aqui, com a sessão na mão. Uma rota nova
 * precisaria estar na lista de URLs permitidas do projeto Supabase —
 * configuração que vive no painel, fora do repositório, e que ninguém lembraria
 * de mexer no dia em que o endereço do site mudasse.
 *
 * ## O que faltava, e é a pergunta que o usuário fez
 *
 * *"Como vou saber qual a senha dela para eu passar?"* — não há senha a passar.
 * Ninguém a define pela pessoa: nem o convite, nem quem convida, nem esta tela.
 * O que faltava era o lugar de ELA definir a dela. Sem ele o link terminava no
 * formulário de entrada, com um token válido na URL e nenhum campo que o
 * usasse.
 */

/** O mesmo de `minimum_password_length` em `supabase/config.toml`. */
const MINIMO_SENHA = 6;

export function LoginForm(): ReactNode {
  const router = useRouter();
  const params = useSearchParams();

  const missing = missingBrowserEnv();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [novaSenha, setNovaSenha] = useState("");
  const [repetida, setRepetida] = useState("");
  const [convite, setConvite] = useState<ConviteNaUrl>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const achado = lerConviteDaUrl(window.location.hash);

    if (achado === null) return;

    /*
      O TOKEN SAI DA URL ANTES DE QUALQUER OUTRA COISA. Ele é credencial: ficaria
      no histórico do navegador, no título da aba compartilhada e em qualquer
      captura de tela desta página. `replaceState` não recarrega nada e não
      empilha entrada nova.
    */
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);

    if (achado.kind === "expirado") {
      setConvite(achado);

      return;
    }

    void createClient()
      .auth.setSession({ access_token: achado.accessToken, refresh_token: achado.refreshToken })
      .then(({ error: falha }) => {
        // Token recusado é link vencido ou já usado — o mesmo desfecho, e a
        // pessoa precisa saber que o caminho é pedir outro convite.
        setConvite(falha === null ? achado : { kind: "expirado", descricao: falha.message });
      });
  }, []);

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);

    const supabase = createClient();
    const result = await supabase.auth.signInWithPassword({ email, password });

    if (result.error !== null) {
      // Mensagem genérica de propósito: distinguir "e-mail não existe" de
      // "senha errada" entrega ao atacante quais endereços são válidos.
      setError("E-mail ou senha incorretos.");
      setBusy(false);

      return;
    }

    router.replace(safeNext(params.get("next")));
    router.refresh();
  }

  async function definirSenha(): Promise<void> {
    /*
      As duas recusas acontecem ANTES da ida ao servidor. A segunda existe
      porque não há como corrigir depois: sem SMTP não há "esqueci minha senha"
      (D-296), então uma senha digitada errada duas vezes iguais é uma conta
      perdida até alguém convidar de novo.
    */
    if (novaSenha.length < MINIMO_SENHA) {
      setError(`A senha precisa de pelo menos ${String(MINIMO_SENHA)} caracteres.`);

      return;
    }

    if (novaSenha !== repetida) {
      setError("As duas senhas não são iguais.");

      return;
    }

    setBusy(true);
    setError(null);

    const { error: falha } = await createClient().auth.updateUser({ password: novaSenha });

    if (falha !== null) {
      // O texto do servidor chega inteiro: ele é quem manda na política de
      // senha, e repeti-la aqui criaria uma segunda regra para divergir da
      // primeira.
      setError(falha.message);
      setBusy(false);

      return;
    }

    // A sessão já está de pé desde `setSession`: definir a senha termina o
    // convite e a pessoa entra na aplicação, sem digitar nada de novo.
    router.replace("/");
    router.refresh();
  }

  if (missing.length > 0) {
    return (
      <p role="alert" style={{ color: "var(--sb-danger)", fontSize: "0.875rem" }}>
        Ambiente incompleto. Falta definir na Vercel: {missing.join(", ")}.
      </p>
    );
  }

  const aceitandoConvite = convite?.kind === "sessao";

  return (
    <>
      <h1 style={{ margin: "var(--sb-space-2) 0 var(--sb-space-4)", fontSize: "1.5rem" }}>
        {aceitandoConvite ? "Defina sua senha" : "Entrar"}
      </h1>

      {convite?.kind === "expirado" && (
        <p role="alert" className="sb-note sb-note-atencao" style={{ marginBottom: "var(--sb-space-3)" }}>
          <span>Este convite não vale mais</span>
          <span
            style={{
              display: "block",
              fontFamily: "var(--sb-sans)",
              fontSize: "0.6875rem",
              marginTop: "0.375rem",
            }}
          >
            O link expira e só pode ser usado uma vez. Peça a quem administra para convidar você de
            novo.
            {convite.descricao === "" ? "" : ` (${convite.descricao})`}
          </span>
        </p>
      )}

      {aceitandoConvite ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void definirSenha();
          }}
          style={{ display: "grid", gap: "var(--sb-space-3)" }}
        >
          <p style={{ color: "var(--sb-text-soft)", fontSize: "0.8125rem", margin: 0 }}>
            Seu acesso já foi criado. Escolha uma senha para entrar daqui em diante.
          </p>

          <label style={{ fontSize: "0.875rem", fontWeight: 600 }}>
            Nova senha
            <input
              className="sb-input"
              type="password"
              value={novaSenha}
              onChange={(event) => {
                setNovaSenha(event.target.value);
              }}
              required
              minLength={MINIMO_SENHA}
              autoComplete="new-password"
              autoFocus
            />
          </label>

          <label style={{ fontSize: "0.875rem", fontWeight: 600 }}>
            Repita a senha
            <input
              className="sb-input"
              type="password"
              value={repetida}
              onChange={(event) => {
                setRepetida(event.target.value);
              }}
              required
              autoComplete="new-password"
            />
          </label>

          {error !== null && (
            <p role="alert" style={{ color: "var(--sb-danger)", fontSize: "0.875rem", margin: 0 }}>
              {error}
            </p>
          )}

          <button className="sb-button sb-button-primary" type="submit" disabled={busy}>
            {busy ? "Salvando…" : "Salvar senha e entrar"}
          </button>
        </form>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
          style={{ display: "grid", gap: "var(--sb-space-3)" }}
        >
          <label style={{ fontSize: "0.875rem", fontWeight: 600 }}>
            E-mail
            <input
              className="sb-input"
              type="email"
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
              }}
              required
              autoComplete="email"
            />
          </label>

          <label style={{ fontSize: "0.875rem", fontWeight: 600 }}>
            Senha
            <input
              className="sb-input"
              type="password"
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
              }}
              required
              autoComplete="current-password"
            />
          </label>

          {error !== null && (
            <p role="alert" style={{ color: "var(--sb-danger)", fontSize: "0.875rem", margin: 0 }}>
              {error}
            </p>
          )}

          <button className="sb-button sb-button-primary" type="submit" disabled={busy}>
            {busy ? "Entrando…" : "Entrar"}
          </button>

          <p style={{ color: "var(--sb-text-soft)", fontSize: "0.8125rem", margin: 0 }}>
            Acesso é concedido pelo administrador. Não há autocadastro.
          </p>
        </form>
      )}
    </>
  );
}
