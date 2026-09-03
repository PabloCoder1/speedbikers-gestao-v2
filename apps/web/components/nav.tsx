"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

/**
 * Navegação principal — sidebar vertical agrupada.
 *
 * **Por que deixou de ser cabeçalho horizontal.** O brief do usuário
 * (`speed-bikers-design.md`, seção 7 "ESTRUTURA GLOBAL") pede
 * "SIDEBAR VERTICAL ESQUERDA + TOP BAR + ÁREA CENTRAL", com a sidebar podendo
 * "agrupar funcionalidades" e "destacar seção atual", e fecha com a frase que
 * condena diretamente a moldura anterior: **"Não usar dezenas de links
 * horizontalmente no topo."** Eram 29 links em cinco dropdowns.
 *
 * **Por que é client component**, sendo que todo o resto do Shell é servidor:
 * "destacar seção atual" exige a rota atual, e o App Router não a entrega a um
 * Server Component. `usePathname` é a única leitura daqui — nenhum dado, nenhuma
 * consulta, nenhuma sessão. A lista é estática e pública; não há custo de
 * serialização de dado sensível.
 *
 * **Destaque não é só cor** (mesma doutrina de `components/filter-pill.tsx`):
 * o item ativo leva `aria-current="page"`, então quem navega por leitor de tela
 * ouve onde está, e não só quem enxerga o amarelo.
 *
 * O agrupamento reconcilia o do Figma com as telas que existem de verdade:
 * nenhuma tela real foi escondida por não estar no Figma (Reposição,
 * Importações, Copiloto, Sugestões entraram no grupo que lhes cabe), e nenhuma
 * tela do Figma que não existe foi inventada (Margem, Insights, Central de
 * Ajuda e as cinco de Atendimento seguem como diferenças intencionais
 * registradas em `docs/DESIGN_IMPLEMENTATION.md`). Métricas e Templates de
 * atendimento continuam onde já estavam — linkadas do cabeçalho da própria
 * Caixa de Entrada, porque são ferramentas dela, não seções.
 */
interface NavItem {
  label: string;
  href: string;
}

interface NavGroup {
  title: string;
  items: NavItem[];
}

const NAV_GROUPS: readonly NavGroup[] = [
  {
    title: "Visão geral",
    items: [
      { label: "Painel", href: "/" },
      { label: "Ações", href: "/acoes" },
      { label: "Diagnóstico", href: "/diagnostico" },
    ],
  },
  {
    title: "Operação",
    items: [
      { label: "Vendas", href: "/vendas" },
      { label: "Anúncios", href: "/anuncios" },
      { label: "Estoque", href: "/estoque" },
      { label: "Movimentações", href: "/estoque/movimentacoes" },
      { label: "Full", href: "/full" },
      { label: "Reposição", href: "/reposicao" },
      { label: "Notas Fiscais", href: "/notas-fiscais" },
      { label: "Compras", href: "/compras" },
      { label: "Fornecedores", href: "/fornecedores" },
      { label: "Importações", href: "/importacoes" },
    ],
  },
  {
    title: "Inteligência",
    items: [
      { label: "Produtos", href: "/produtos" },
      { label: "Vinculações", href: "/vinculacoes" },
      { label: "Preços", href: "/precos" },
      { label: "Curva ABC", href: "/curva-abc" },
      { label: "Cobertura", href: "/cobertura" },
      { label: "Copiloto", href: "/copiloto" },
    ],
  },
  {
    title: "Atendimento",
    items: [
      { label: "Caixa de Entrada", href: "/atendimento" },
      { label: "Base de Conhecimento", href: "/atendimento/conhecimento" },
    ],
  },
  {
    title: "Administração",
    items: [
      { label: "Usuários", href: "/usuarios" },
      { label: "Contas ML", href: "/contas" },
      { label: "Integrações", href: "/integracoes" },
      { label: "Sincronização", href: "/sincronizacao" },
      { label: "Saúde do Sistema", href: "/saude" },
      { label: "Configurações", href: "/configuracoes" },
      { label: "Sugestões", href: "/sugestoes" },
    ],
  },
];

/**
 * Qual item está ativo. `/` só casa exato — sem isso o Painel ficaria aceso em
 * toda tela do app, que é a forma mais comum de errar esta função. Para o
 * resto, o prefixo com barra: `/estoque` não pode acender em
 * `/estoque/movimentacoes` (as duas são itens do menu e acenderiam juntas), mas
 * `/compras` precisa acender em `/compras/novo`, que não é item do menu.
 */
function estaAtivo(href: string, pathname: string, todos: readonly string[]): boolean {
  if (href === "/") return pathname === "/";
  if (pathname === href) return true;
  if (!pathname.startsWith(`${href}/`)) return false;
  // Se existe um item MAIS específico que também casa, ele é o dono.
  return !todos.some((outro) => outro !== href && outro.startsWith(`${href}/`) && (pathname === outro || pathname.startsWith(`${outro}/`)));
}

const linkBase: React.CSSProperties = {
  display: "block",
  padding: "0.375rem 0.625rem",
  borderRadius: "var(--sb-radius-md)",
  textDecoration: "none",
  fontSize: "0.8125rem",
  lineHeight: 1.4,
};

export function SidebarNav(): ReactNode {
  const pathname = usePathname();
  const todos = NAV_GROUPS.flatMap((g) => g.items.map((i) => i.href));

  return (
    <nav aria-label="Navegação principal" style={{ padding: "var(--sb-space-2)", overflowY: "auto", flex: 1 }}>
      {NAV_GROUPS.map((group) => (
          /*
           * Os cinco grupos nascem ABERTOS, como no Figma. A primeira versão
           * abria só o que continha a rota atual, e a tela mostrou o defeito:
           * quem estava em /vendas via quatro cabeçalhos mudos e não sabia o
           * que havia dentro. `open` sem `onToggle` é deliberado — o elemento
           * fica não-controlado, então recolher um grupo continua valendo
           * enquanto a prop não mudar, e ninguém precisa de estado para isso.
           */
          <details key={group.title} className="sb-nav-group" open style={{ marginBottom: "var(--sb-space-2)" }}>
            <summary
              style={{
                cursor: "pointer",
                listStyle: "none",
                userSelect: "none",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "0.25rem 0.625rem",
                color: "var(--sb-on-primary-soft)",
                fontSize: "0.6875rem",
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "0.075em",
              }}
            >
              {group.title}
              {/* A afordância de recolher. `aria-hidden` porque o estado real
                  quem anuncia é o próprio <details>, e o leitor de tela não
                  deve ouvir um caractere solto. */}
              <span aria-hidden="true" className="sb-nav-chevron">
                ▾
              </span>
            </summary>

            <div className="sb-nav-group-menu">
              {group.items.map((item) => {
                const ativo = estaAtivo(item.href, pathname, todos);

                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={ativo ? "page" : undefined}
                    className="sb-nav-link"
                    style={
                      ativo
                        ? { ...linkBase, background: "var(--sb-accent)", color: "var(--sb-primary)", fontWeight: 600 }
                        : { ...linkBase, color: "var(--sb-on-primary)" }
                    }
                  >
                    {item.label}
                  </Link>
                );
              })}
            </div>
          </details>
      ))}
    </nav>
  );
}
