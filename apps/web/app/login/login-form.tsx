"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useId, useState, type ReactNode } from "react";

import { lerConviteDaUrl, type ConviteNaUrl } from "../../lib/invite-hash";
import { desfechoDoPedido, linkDeRetorno, type DesfechoDoPedido } from "../../lib/recuperar-senha";
import { safeNext } from "../../lib/safe-next";
import { createClient, createRecoveryClient, missingBrowserEnv } from "../../lib/supabase/browser";

/**
 * Entrada — e, desde D-302, também a ACEITAÇÃO DO CONVITE e o NOVO LINK DE
 * ACESSO.
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
 * O "Gerar novo link de acesso" de `/usuarios` chega pelo MESMO caminho, com
 * `type=recovery` (`apps/api/src/invites.ts`). Os dois terminam em definir
 * senha, mas a tela não diz a mesma coisa aos dois: para quem já tinha conta,
 * "seu acesso já foi criado" é falso.
 *
 * ## O que faltava, e é a pergunta que o usuário fez
 *
 * *"Como vou saber qual a senha dela para eu passar?"* — não há senha a passar.
 * Ninguém a define pela pessoa: nem o convite, nem quem convida, nem esta tela.
 * O que faltava era o lugar de ELA definir a dela. Sem ele o link terminava no
 * formulário de entrada, com um token válido na URL e nenhum campo que o
 * usasse.
 *
 * ## "Esqueci a senha" (D-863)
 *
 * Com SMTP de verdade no Auth, quem esqueceu pede o link aqui mesmo: o e-mail
 * devolve a pessoa a esta tela com `type=recovery` no fragmento, e ela cai no
 * MESMO formulário de criar a nova senha do link gerado em `/usuarios`. O
 * botão só aparece com `RECUPERACAO_SENHA_POR_EMAIL=1` no servidor
 * (`page.tsx`): sem SMTP real o pedido "funcionaria" e o e-mail não chegaria.
 *
 * ## Os textos que os testes seguram
 *
 * `e2e/helpers.ts` entra por `getByLabel("E-mail")`, `getByLabel("Senha")` e o
 * botão "Entrar"; `e2e/convite-aceite.spec.ts` por "Defina sua senha", "Nova
 * senha", "Repita a senha" e "Salvar senha e entrar"; `e2e/recuperar-senha.spec.ts`
 * por "Esqueci a senha", "Enviar link" e "Pedido recebido". Por isso o botão de
 * mostrar a senha tira o nome do TEXTO ("Mostrar"), nunca de um `aria-label`
 * com "senha": casaria com `getByLabel("Senha")` e derrubaria o login de toda a
 * suíte.
 */

/** O mesmo de `minimum_password_length` em `supabase/config.toml`. */
const MINIMO_SENHA = 6;

type Modo = "entrar" | "esqueci" | "invite" | "recovery";

const CABECALHO: Record<Modo, { eyebrow: string; titulo: string; texto: string }> = {
  entrar: {
    eyebrow: "ACESSO INTERNO",
    titulo: "Entrar",
    texto: "Use o e-mail e a senha da sua conta.",
  },
  esqueci: {
    eyebrow: "RECUPERAR ACESSO",
    titulo: "Esqueci a senha",
    texto: "Informe o e-mail da sua conta. Se ele tiver acesso, mandamos um link para você criar uma nova senha.",
  },
  invite: {
    eyebrow: "PRIMEIRO ACESSO",
    titulo: "Defina sua senha",
    texto: "Seu acesso já foi criado. Escolha uma senha para entrar daqui em diante.",
  },
  recovery: {
    eyebrow: "NOVO LINK DE ACESSO",
    titulo: "Crie uma nova senha",
    // `invites.ts`: a senha antiga continua valendo até a nova ser salva.
    texto: "Link confirmado. A senha anterior continua valendo até você salvar a nova.",
  },
};

function CampoSenha({
  rotulo,
  valor,
  onChange,
  autoComplete,
  autoFocus = false,
}: {
  rotulo: string;
  valor: string;
  onChange: (valor: string) => void;
  autoComplete: "current-password" | "new-password";
  autoFocus?: boolean;
}): ReactNode {
  const id = useId();
  const [visivel, setVisivel] = useState(false);

  return (
    <div className="sb-login-campo">
      <label htmlFor={id} className="sb-login-rotulo">
        {rotulo}
      </label>
      <div className="sb-login-senha">
        <input
          id={id}
          className="sb-input sb-login-input"
          type={visivel ? "text" : "password"}
          value={valor}
          onChange={(event) => {
            onChange(event.target.value);
          }}
          required
          autoComplete={autoComplete}
          autoFocus={autoFocus}
        />
        <button
          type="button"
          className="sb-text-button sb-login-mostrar"
          aria-controls={id}
          aria-pressed={visivel}
          onClick={() => {
            setVisivel((atual) => !atual);
          }}
        >
          {visivel ? "Ocultar" : "Mostrar"}
        </button>
      </div>
    </div>
  );
}

/** Regra de senha conferida enquanto se digita — as MESMAS que `definirSenha` recusa. */
function Regra({ ok, children }: { ok: boolean; children: ReactNode }): ReactNode {
  return (
    <li data-ok={ok}>
      <span aria-hidden="true" className="sb-login-regra-marca">
        {ok ? "✓" : "○"}
      </span>
      {children}
      <span className="sb-sr-only">{ok ? " — atendida" : " — pendente"}</span>
    </li>
  );
}

export function LoginForm({ recuperacaoPorEmail }: { recuperacaoPorEmail: boolean }): ReactNode {
  const router = useRouter();
  const params = useSearchParams();
  const emailId = useId();

  const missing = missingBrowserEnv();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [novaSenha, setNovaSenha] = useState("");
  const [repetida, setRepetida] = useState("");
  const [convite, setConvite] = useState<ConviteNaUrl>(null);
  const [verificando, setVerificando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [esqueci, setEsqueci] = useState(false);
  const [pedido, setPedido] = useState<DesfechoDoPedido | null>(null);

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

    /*
      Enquanto o Auth confere o token, a tela diz isso — antes, o formulário de
      ENTRADA aparecia nesse intervalo e trocava de identidade na frente da
      pessoa, que às vezes já tinha começado a digitar o e-mail.
    */
    setVerificando(true);

    void createClient()
      .auth.setSession({ access_token: achado.accessToken, refresh_token: achado.refreshToken })
      .then(({ error: falha }) => {
        // Token recusado é link vencido ou já usado — o mesmo desfecho, e a
        // pessoa precisa saber que o caminho é pedir outro link.
        setConvite(falha === null ? achado : { kind: "expirado", descricao: falha.message });
        setVerificando(false);
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

  async function pedirLink(): Promise<void> {
    setBusy(true);
    setPedido(null);

    // A resposta é a mesma para e-mail que existe e que não existe
    // (`desfechoDoPedido`): a tela nunca diz quem tem acesso.
    const { error: falha } = await createRecoveryClient().auth.resetPasswordForEmail(email.trim(), {
      redirectTo: linkDeRetorno(window.location.origin),
    });

    setPedido(desfechoDoPedido(falha));
    setBusy(false);
  }

  function irParaEsqueci(ir: boolean): void {
    setEsqueci(ir);
    setPedido(null);
    setError(null);
  }

  async function definirSenha(): Promise<void> {
    /*
      As duas recusas acontecem ANTES da ida ao servidor. A segunda existe
      porque corrigir depois custa caro: sem o "esqueci a senha" ligado
      (D-863), uma senha digitada errada duas vezes iguais só volta com alguém
      de ADMIN gerando um novo link de acesso.
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
      <p role="alert" className="sb-login-erro">
        Ambiente incompleto. Falta definir na Vercel: {missing.join(", ")}.
      </p>
    );
  }

  if (verificando) {
    return (
      <p role="status" className="sb-login-verificando">
        Confirmando seu link…
      </p>
    );
  }

  const modo: Modo = convite?.kind === "sessao" ? convite.tipo : esqueci ? "esqueci" : "entrar";
  const cabecalho = CABECALHO[modo];

  return (
    <>
      <div className="sb-login-cabeca">
        <span className="sb-eyebrow">{cabecalho.eyebrow}</span>
        <h1 className="sb-login-titulo">{cabecalho.titulo}</h1>
        <p className="sb-login-texto">{cabecalho.texto}</p>
      </div>

      {convite?.kind === "expirado" && (
        <div role="alert" className="sb-note sb-note-atencao sb-login-aviso">
          <span>Este link não vale mais</span>
          <p>
            Links de convite e de nova senha expiram e só podem ser usados uma vez.
            {recuperacaoPorEmail
              ? " Peça outro em “Esqueci a senha” ou a quem administra o sistema."
              : " Peça a quem administra um novo link de acesso."}
            {convite.descricao === "" ? "" : ` (${convite.descricao})`}
          </p>
        </div>
      )}

      {modo === "esqueci" ? (
        <form
          className="sb-login-form"
          onSubmit={(event) => {
            event.preventDefault();
            void pedirLink();
          }}
        >
          <div className="sb-login-campo">
            <label htmlFor={emailId} className="sb-login-rotulo">
              E-mail
            </label>
            <input
              id={emailId}
              className="sb-input sb-login-input"
              type="email"
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
              }}
              placeholder="voce@empresa.com.br"
              required
              autoComplete="email"
              autoFocus
            />
          </div>

          {pedido?.kind === "enviado" && (
            <div role="status" className="sb-note sb-login-enviado">
              <span>Pedido recebido</span>
              <p>
                Se este e-mail tiver acesso, o link chega em alguns minutos. Ele vale uma vez e expira; confira
                também a caixa de spam.
              </p>
            </div>
          )}

          {pedido?.kind === "falha" && (
            <p role="alert" className="sb-login-erro">
              {pedido.mensagem}
            </p>
          )}

          <button className="sb-button sb-button-primary sb-login-botao" type="submit" disabled={busy}>
            {busy ? "Enviando…" : pedido?.kind === "enviado" ? "Enviar outro link" : "Enviar link"}
          </button>

          <button
            type="button"
            className="sb-text-button sb-login-voltar"
            onClick={() => {
              irParaEsqueci(false);
            }}
          >
            Voltar para a entrada
          </button>
        </form>
      ) : modo !== "entrar" ? (
        <form
          className="sb-login-form"
          onSubmit={(event) => {
            event.preventDefault();
            void definirSenha();
          }}
        >
          <CampoSenha
            rotulo="Nova senha"
            valor={novaSenha}
            onChange={setNovaSenha}
            autoComplete="new-password"
            autoFocus
          />

          <CampoSenha rotulo="Repita a senha" valor={repetida} onChange={setRepetida} autoComplete="new-password" />

          <ul className="sb-login-regras">
            <Regra ok={novaSenha.length >= MINIMO_SENHA}>Pelo menos {MINIMO_SENHA} caracteres</Regra>
            <Regra ok={repetida !== "" && novaSenha === repetida}>Confirmação igual à nova senha</Regra>
          </ul>

          {error !== null && (
            <p role="alert" className="sb-login-erro">
              {error}
            </p>
          )}

          <button className="sb-button sb-button-primary sb-login-botao" type="submit" disabled={busy}>
            {busy ? "Salvando…" : "Salvar senha e entrar"}
          </button>
        </form>
      ) : (
        <form
          className="sb-login-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="sb-login-campo">
            <label htmlFor={emailId} className="sb-login-rotulo">
              E-mail
            </label>
            <input
              id={emailId}
              className="sb-input sb-login-input"
              type="email"
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
              }}
              placeholder="voce@empresa.com.br"
              required
              autoComplete="email"
            />
          </div>

          <CampoSenha rotulo="Senha" valor={password} onChange={setPassword} autoComplete="current-password" />

          {recuperacaoPorEmail && (
            <button
              type="button"
              className="sb-text-button sb-login-esqueci"
              onClick={() => {
                irParaEsqueci(true);
              }}
            >
              Esqueci a senha
            </button>
          )}

          {error !== null && (
            <p role="alert" className="sb-login-erro">
              {error}
            </p>
          )}

          <button className="sb-button sb-button-primary sb-login-botao" type="submit" disabled={busy}>
            {busy ? "Entrando…" : "Entrar"}
          </button>
        </form>
      )}

      <p className="sb-login-nota">
        {recuperacaoPorEmail
          ? "Ainda não tem acesso? Quem administra o sistema gera um link de acesso para você."
          : "Esqueceu a senha ou ainda não tem acesso? Quem administra o sistema gera um link de acesso para você."}
      </p>
    </>
  );
}
