import { Suspense, type ReactNode } from "react";

import { LoginForm } from "./login-form";

export const metadata = { title: "Entrar — Speed Bikers Gestão" };

/*
  DINÂMICA DE PROPÓSITO (D-331). O login era a ÚNICA página pré-renderizada
  no build — as outras 50 rotas já eram dinâmicas. Com a CSP de nonce, uma
  página estática sai com os scripts SEM o nonce (não há requisição no build
  para gerá-lo), e `strict-dynamic` os bloqueia: o formulário renderizaria e
  não responderia a clique nenhum. A porta de entrada do sistema trancada.
*/
export const dynamic = "force-dynamic";

export default function LoginPage(): ReactNode {
  return (
    <main
      style={{
        minHeight: "100dvh",
        display: "grid",
        placeItems: "center",
        padding: "var(--sb-space-3)",
      }}
    >
      <div style={{ width: "100%", maxWidth: "22rem" }}>
        <p
          style={{
            margin: 0,
            color: "var(--sb-text-soft)",
            fontSize: "0.8125rem",
            letterSpacing: "0.08em",
            textTransform: "uppercase",
          }}
        >
          Speed Bikers Gestão
        </p>

        {/*
          O TÍTULO MORA NO FORMULÁRIO desde D-302: só o cliente enxerga o
          fragmento do convite, e é ele que decide se esta tela é "Entrar" ou
          "Defina sua senha". Um `h1` fixo no servidor diria "Entrar" acima de
          um formulário que pede senha nova.
        */}
        {/*
          `useSearchParams` le algo que so existe na requisicao. Sem o limite de
          Suspense, o Next tenta pre-renderizar a pagina no build e falha.
        */}
        <Suspense fallback={null}>
          <LoginForm />
        </Suspense>
      </div>
    </main>
  );
}
