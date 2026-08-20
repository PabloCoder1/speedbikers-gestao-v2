import { Suspense, type ReactNode } from "react";

import { LoginForm } from "./login-form";

export const metadata = { title: "Entrar — Speed Bikers Gestão" };

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

        <h1 style={{ margin: "var(--sb-space-2) 0 var(--sb-space-4)", fontSize: "1.5rem" }}>
          Entrar
        </h1>

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
