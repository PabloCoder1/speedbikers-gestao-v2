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
 *
 * Navegação agrupada por categoria (pedido explícito do usuário, 2026-08-24
 * — "não fica só colocando solto, fica bagunça"), `<details>`/`<summary>`
 * nativo — dropdown sem JS, acessível de graça. Estrutura alvo completa:
 *
 *   VISÃO GERAL, NOTIFICAÇÕES (itens soltos, sem grupo — notificações é
 *   transversal a todas as categorias, não pertence a nenhuma)
 *   COMERCIAL: Vendas, Produtos, Anúncios
 *   ESTOQUE: Estoque, Cobertura, Curva ABC, Notas Fiscais, Compras
 *   INTELIGÊNCIA: Diagnóstico, Ações
 *   GESTÃO: Vinculações, Fornecedores, Contas ML, Sincronização
 *   ADMINISTRAÇÃO: Usuários, Integrações, Saúde do Sistema, Sugestões, Configurações
 *
 * Um grupo só aparece aqui quando tem pelo menos UMA página real — dropdown
 * vazio não serve pra nada. Hoje: ADMINISTRAÇÃO inteira ainda não existe
 * (nenhuma das cinco páginas foi construída) e "Produtos" (catálogo de SKU
 * como tela própria, distinta de `/skus/{id}`) também não — ficam de fora
 * até nascerem, não como esquecimento. Regra para quem adicionar uma tela
 * nova: ela entra no grupo certo aqui, nunca solta no nível de cima.
 *
 * "Importações" (UpSeller) não estava na lista original do usuário, mas já
 * existe e funciona — entrou em ESTOQUE por ser fluxo de catálogo/saldo.
 */
interface NavItem {
  label: string;
  href: string;
}

interface NavGroup {
  title: string;
  items: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    title: "Comercial",
    items: [
      { label: "Vendas", href: "/vendas" },
      { label: "Anúncios", href: "/anuncios" },
    ],
  },
  {
    title: "Estoque",
    items: [
      { label: "Estoque", href: "/estoque" },
      { label: "Cobertura", href: "/cobertura" },
      { label: "Curva ABC", href: "/curva-abc" },
      { label: "Notas Fiscais", href: "/notas-fiscais" },
      { label: "Compras", href: "/compras" },
      { label: "Importações", href: "/importacoes" },
    ],
  },
  {
    title: "Inteligência",
    items: [
      { label: "Diagnóstico", href: "/diagnostico" },
      { label: "Ações", href: "/acoes" },
    ],
  },
  {
    title: "Gestão",
    items: [
      { label: "Vinculações", href: "/vinculacoes" },
      { label: "Fornecedores", href: "/fornecedores" },
      { label: "Contas ML", href: "/contas" },
      { label: "Sincronização", href: "/sincronizacao" },
    ],
  },
];

const navLinkStyle: React.CSSProperties = {
  display: "block",
  padding: "0.375rem 0.75rem",
  color: "var(--sb-text)",
  textDecoration: "none",
  fontSize: "0.875rem",
  whiteSpace: "nowrap",
};

const navGroupSummaryStyle: React.CSSProperties = {
  cursor: "pointer",
  color: "var(--sb-text-soft)",
  fontSize: "0.9375rem",
  listStyle: "none",
  userSelect: "none",
};

function NavGroupDropdown({ group }: { group: NavGroup }): ReactNode {
  return (
    <details className="sb-nav-group" style={{ position: "relative" }}>
      <summary style={navGroupSummaryStyle}>{group.title.toUpperCase()} ▾</summary>

      <div
        className="sb-nav-group-menu"
        style={{
          position: "absolute",
          top: "100%",
          left: 0,
          marginTop: "0.375rem",
          background: "var(--sb-surface)",
          border: "1px solid var(--sb-border)",
          borderRadius: "var(--sb-radius)",
          boxShadow: "0 8px 20px rgba(0,0,0,0.12)",
          padding: "0.25rem",
          minWidth: "10rem",
          zIndex: 50,
        }}
      >
        {group.items.map((item) => (
          <Link key={item.href} href={item.href} style={navLinkStyle}>
            {item.label}
          </Link>
        ))}
      </div>
    </details>
  );
}

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
  // Falha aqui (não "sem organização" — isso já é tratado explicitamente em
  // cada página) degradava em silêncio: nome genérico, busca desabilitada
  // (organizationId null), papel sumindo do cabeçalho, sem nenhum sinal —
  // numa tela que roda em TODA página autenticada (D-067, Nível 3).
  const membershipError = membership.error !== null;

  // Badge de não lidas (Fase 7, item 4) — `notification_recipients_select_own`
  // já restringe a própria linha, sem precisar filtrar por user_id aqui.
  // Falha na contagem degrada pro emblema simplesmente não aparecer: não é
  // dado de negócio (D-067 mirava corrupção de estoque/pedido, não um
  // contador de UI), então sem `⚠` — só some.
  const unread = await supabase
    .from("notification_recipients")
    .select("*", { count: "exact", head: true })
    .is("read_at", null);
  const unreadCount = unread.count ?? 0;

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

        <nav style={{ display: "flex", alignItems: "center", gap: "var(--sb-space-3)", fontSize: "0.9375rem" }}>
          <Link href="/" style={{ color: "var(--sb-text-soft)", textDecoration: "none" }}>
            Visão Geral
          </Link>

          <Link
            href="/notificacoes"
            style={{ color: "var(--sb-text-soft)", textDecoration: "none", position: "relative" }}
          >
            Notificações
            {unreadCount > 0 && (
              <span
                style={{
                  marginLeft: "0.375rem",
                  display: "inline-block",
                  minWidth: "1.125rem",
                  padding: "0 0.25rem",
                  borderRadius: "999px",
                  background: "var(--sb-danger)",
                  color: "#fff",
                  fontSize: "0.6875rem",
                  fontWeight: 700,
                  textAlign: "center",
                  lineHeight: "1.125rem",
                }}
              >
                {unreadCount > 99 ? "99+" : unreadCount}
              </span>
            )}
          </Link>

          {NAV_GROUPS.map((group) => (
            <NavGroupDropdown key={group.title} group={group} />
          ))}
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
            {membershipError && (
              <span
                role="alert"
                title="Não foi possível confirmar sua organização — busca e alguns dados podem estar incompletos nesta página."
                style={{ color: "var(--sb-danger)", marginLeft: "0.375rem", cursor: "help" }}
              >
                ⚠
              </span>
            )}
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
