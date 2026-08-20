import Link from "next/link";
import type { ReactNode } from "react";

import { createClient } from "../lib/supabase/server";

/**
 * Moldura das telas autenticadas: cabeçalho, navegação e identificação.
 *
 * O papel é lido do banco, não do token. Um JWT pode ser antigo — alguém
 * rebaixado de ADMIN para VISUALIZADOR continuaria vendo o menu de ADMIN até o
 * token expirar. Ler de `organization_members` custa uma consulta e elimina a
 * janela.
 */
export async function Shell({ children }: { children: ReactNode }): Promise<ReactNode> {
  const supabase = await createClient();

  const { data: auth } = await supabase.auth.getUser();

  const membership = await supabase
    .from("organization_members")
    .select("role, organizations(name)")
    .maybeSingle();

  const role = membership.data?.role ?? null;
  const orgName = membership.data?.organizations.name ?? "Speed Bikers";

  return (
    <div style={{ minHeight: "100dvh", display: "flex", flexDirection: "column" }}>
      <header
        style={{
          borderBottom: "1px solid var(--sb-border)",
          padding: "var(--sb-space-3) var(--sb-space-4)",
          display: "flex",
          alignItems: "center",
          gap: "var(--sb-space-4)",
          flexWrap: "wrap",
        }}
      >
        <Link
          href="/"
          style={{ fontWeight: 700, color: "var(--sb-primary)", textDecoration: "none" }}
        >
          {orgName}
        </Link>

        <nav style={{ display: "flex", gap: "var(--sb-space-3)", fontSize: "0.9375rem" }}>
          <Link href="/importacoes" style={{ color: "var(--sb-text-soft)" }}>
            Importações
          </Link>
          <Link href="/vinculacoes" style={{ color: "var(--sb-text-soft)" }}>
            Vinculações
          </Link>
        </nav>

        <div
          style={{
            marginLeft: "auto",
            display: "flex",
            alignItems: "center",
            gap: "var(--sb-space-3)",
            fontSize: "0.8125rem",
            color: "var(--sb-text-soft)",
          }}
        >
          <span>
            {auth.user?.email ?? "—"}
            {role === null ? "" : ` · ${role}`}
          </span>

          <form action="/auth/sign-out" method="post">
            <button
              type="submit"
              style={{
                border: "1px solid var(--sb-border)",
                background: "transparent",
                borderRadius: "var(--sb-radius)",
                padding: "0.25rem 0.625rem",
                cursor: "pointer",
                color: "inherit",
                font: "inherit",
              }}
            >
              Sair
            </button>
          </form>
        </div>
      </header>

      <main style={{ padding: "var(--sb-space-4)", flex: 1 }}>{children}</main>
    </div>
  );
}
