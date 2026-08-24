import Link from "next/link";
import type { ReactNode } from "react";

import { createClient } from "../lib/supabase/server";
import { CommandPalette } from "./command-palette";

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
    .select("role, organization_id, organizations(name)")
    .maybeSingle();

  const role = membership.data?.role ?? null;
  const orgName = membership.data?.organizations.name ?? "Speed Bikers";
  const organizationId = membership.data?.organization_id ?? null;

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

        <CommandPalette organizationId={organizationId} />

        <nav style={{ display: "flex", gap: "var(--sb-space-3)", fontSize: "0.9375rem" }}>
          <Link href="/vendas" style={{ color: "var(--sb-text-soft)" }}>
            Vendas
          </Link>
          <Link href="/importacoes" style={{ color: "var(--sb-text-soft)" }}>
            Importações
          </Link>
          <Link href="/notas-fiscais" style={{ color: "var(--sb-text-soft)" }}>
            Notas Fiscais
          </Link>
          <Link href="/estoque" style={{ color: "var(--sb-text-soft)" }}>
            Estoque
          </Link>
          <Link href="/anuncios" style={{ color: "var(--sb-text-soft)" }}>
            Anúncios
          </Link>
          <Link href="/cobertura" style={{ color: "var(--sb-text-soft)" }}>
            Cobertura
          </Link>
          <Link href="/curva-abc" style={{ color: "var(--sb-text-soft)" }}>
            Curva ABC
          </Link>
          <Link href="/diagnostico" style={{ color: "var(--sb-text-soft)" }}>
            Diagnóstico
          </Link>
          <Link href="/compras" style={{ color: "var(--sb-text-soft)" }}>
            Pedidos de Compra
          </Link>
          <Link href="/fornecedores" style={{ color: "var(--sb-text-soft)" }}>
            Fornecedores
          </Link>
          <Link href="/vinculacoes" style={{ color: "var(--sb-text-soft)" }}>
            Vinculações
          </Link>
          <Link href="/contas" style={{ color: "var(--sb-text-soft)" }}>
            Contas Mercado Livre
          </Link>
          <Link href="/sincronizacao" style={{ color: "var(--sb-text-soft)" }}>
            Sincronização
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
