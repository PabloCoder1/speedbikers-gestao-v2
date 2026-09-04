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
 * condena a moldura anterior: **"Não usar dezenas de links horizontalmente no
 * topo."** Eram 29 links em cinco dropdowns.
 *
 * **Por que é client component**, sendo que todo o resto do Shell é servidor:
 * "destacar seção atual" exige a rota atual, e o App Router não a entrega a um
 * Server Component. `usePathname` é a única leitura daqui — nenhum dado,
 * nenhuma consulta, nenhuma sessão. A lista é estática e pública.
 *
 * **Destaque não é só cor** (mesma doutrina de `components/filter-pill.tsx`):
 * o item ativo leva `aria-current="page"`, então quem navega por leitor de tela
 * ouve onde está, e não só quem enxerga o amarelo.
 *
 * **O glifo é do frame do Figma**, e lá ele é literalmente um `<span>` com um
 * caractere (`function Icon`). Aqui também: `aria-hidden`, largura fixa para os
 * rótulos alinharem, e repetição onde o próprio Figma repete — ele usa `□` em
 * quase tudo e reserva glifo distinto para Home, Vendas e Caixa de entrada.
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
  icon: string;
}

interface NavGroup {
  title: string;
  items: NavItem[];
}

const NAV_GROUPS: readonly NavGroup[] = [
  {
    title: "Visão geral",
    items: [
      { label: "Painel", href: "/", icon: "⌂" },
      { label: "Ações", href: "/acoes", icon: "◎" },
      { label: "Diagnóstico", href: "/diagnostico", icon: "◍" },
    ],
  },
  {
    title: "Operação",
    items: [
      { label: "Vendas", href: "/vendas", icon: "↗" },
      { label: "Anúncios", href: "/anuncios", icon: "▤" },
      { label: "Estoque", href: "/estoque", icon: "▦" },
      { label: "Movimentações", href: "/estoque/movimentacoes", icon: "⇄" },
      { label: "Full", href: "/full", icon: "▣" },
      { label: "Reposição", href: "/reposicao", icon: "⟳" },
      { label: "Notas Fiscais", href: "/notas-fiscais", icon: "▤" },
      { label: "Compras", href: "/compras", icon: "⊞" },
      { label: "Fornecedores", href: "/fornecedores", icon: "⊟" },
      { label: "Importações", href: "/importacoes", icon: "⇪" },
    ],
  },
  {
    title: "Inteligência",
    items: [
      { label: "Produtos", href: "/produtos", icon: "□" },
      { label: "Vinculações", href: "/vinculacoes", icon: "⇢" },
      { label: "Preços", href: "/precos", icon: "◈" },
      { label: "Curva ABC", href: "/curva-abc", icon: "▲" },
      { label: "Cobertura", href: "/cobertura", icon: "◔" },
      { label: "Copiloto", href: "/copiloto", icon: "✦" },
    ],
  },
  {
    title: "Atendimento",
    items: [
      { label: "Caixa de Entrada", href: "/atendimento", icon: "◌" },
      { label: "Base de Conhecimento", href: "/atendimento/conhecimento", icon: "□" },
    ],
  },
  {
    title: "Administração",
    items: [
      { label: "Usuários", href: "/usuarios", icon: "□" },
      { label: "Contas ML", href: "/contas", icon: "□" },
      { label: "Integrações", href: "/integracoes", icon: "⧉" },
      { label: "Sincronização", href: "/sincronizacao", icon: "⟲" },
      { label: "Saúde do Sistema", href: "/saude", icon: "◇" },
      { label: "Configurações", href: "/configuracoes", icon: "⚙" },
      { label: "Sugestões", href: "/sugestoes", icon: "□" },
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

export function SidebarNav({
  contagens,
}: {
  /**
   * Contadores por rota, do frame do Figma (`.nav-item em`, o "3" na Caixa de
   * entrada). São números REAIS lidos pelo Shell — a alternativa seria um
   * enfeite, e enfeite com cara de número é a classe de defeito que este
   * projeto persegue. Ausente ou nulo simplesmente não desenha o emblema.
   */
  contagens?: Readonly<Record<string, number | null>>;
}): ReactNode {
  const pathname = usePathname();
  const todos = NAV_GROUPS.flatMap((g) => g.items.map((i) => i.href));

  return (
    <nav aria-label="Navegação principal" className="sb-nav">
      {NAV_GROUPS.map((group) => (
        /*
         * Os cinco grupos nascem ABERTOS, como no Figma. A primeira versão
         * abria só o que continha a rota atual, e a tela mostrou o defeito:
         * quem estava em /vendas via quatro cabeçalhos mudos e não sabia o
         * que havia dentro. `open` sem `onToggle` é deliberado — o elemento
         * fica não-controlado, então recolher um grupo continua valendo
         * enquanto a prop não mudar, e ninguém precisa de estado para isso.
         */
        <details key={group.title} className="sb-nav-group" open>
          <summary className="sb-nav-label">
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
              const contagem = contagens?.[item.href] ?? null;

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={ativo ? "page" : undefined}
                  className="sb-nav-link"
                >
                  <span aria-hidden="true" className="sb-nav-icon">
                    {item.icon}
                  </span>
                  {item.label}
                  {contagem !== null && contagem > 0 && (
                    <em className="sb-nav-count">{contagem > 99 ? "99+" : contagem}</em>
                  )}
                </Link>
              );
            })}
          </div>
        </details>
      ))}
    </nav>
  );
}
