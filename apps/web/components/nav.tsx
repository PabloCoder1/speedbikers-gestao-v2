"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

import { Icone, type NomeDoIcone } from "./icons";

/**
 * Navegação principal — sidebar vertical agrupada.
 *
 * **Por que é sidebar.** O brief (`speed-bikers-design.md`, seção 7) pede
 * "SIDEBAR VERTICAL ESQUERDA + TOP BAR + ÁREA CENTRAL" e fecha com: "Não usar
 * dezenas de links horizontalmente no topo."
 *
 * **Por que é client component**, sendo que o resto do Shell é servidor:
 * "destacar seção atual" exige a rota atual, e o App Router não a entrega a um
 * Server Component. Nenhum dado nem consulta: a lista é estática, e o PAPEL que
 * recorta um item chega como prop do Shell (D-312).
 *
 * ## Os grupos são por ASSUNTO (D-355)
 *
 * O frame agrupava em Visão geral / Operação / Inteligência / Atendimento /
 * Administração, e "Operação" tinha oito telas de três assuntos — vender,
 * guardar e comprar. Quem procurava "Compras" passava por Vendas, Anúncios,
 * Estoque e Central Full no caminho. O pedido do usuário foi ordenar melhor, e
 * a régua é a pergunta que a pessoa traz: onde estão as minhas vendas? o meu
 * estoque? o que eu compro?
 *
 * - **Vendas** junta o que é preço e giro (Preços e Curva ABC estavam em
 *   "Inteligência");
 * - **Estoque** e **Compras** se separam — o saldo e a reposição de um lado,
 *   o pedido, o fornecedor e a nota do outro;
 * - **Catálogo** é o cadastro (Produtos e Vinculações);
 * - **Copiloto** sobe para Visão geral, ao lado da Central de Ações: é por onde
 *   se pergunta, não uma análise de um assunto só;
 * - **Sugestões** sai do menu e vai para o rodapé, onde o frame tinha a "Central
 *   de ajuda": é canal com quem constrói o sistema, não uma tela de operação.
 *
 * Nenhuma tela foi escondida nem inventada. Os ícones são SVG (`./icons`), e o
 * destaque não é só cor: o item ativo leva `aria-current="page"`.
 */
interface NavItem {
  label: string;
  href: string;
  icone: NomeDoIcone;
  /**
   * Item que só aparece para ADMIN. **Esconder é cortesia, não defesa** (D-295
   * §3): cada tela marcada assim recusa no SERVIDOR.
   */
  somenteAdmin?: true;
}

interface NavGroup {
  /** Chave estável para lembrar o recolhimento — o título pode mudar de texto. */
  id: string;
  title: string;
  items: NavItem[];
}

const NAV_GROUPS: readonly NavGroup[] = [
  {
    id: "visao-geral",
    title: "Visão geral",
    items: [
      { label: "Home", href: "/", icone: "home" },
      { label: "Central de Ações", href: "/acoes", icone: "alvo" },
      { label: "Diagnóstico", href: "/diagnostico", icone: "pulso" },
      { label: "Copiloto", href: "/copiloto", icone: "brilho" },
    ],
  },
  {
    id: "vendas",
    title: "Vendas",
    items: [
      { label: "Vendas", href: "/vendas", icone: "tendencia" },
      // D-356: o dinheiro de cada venda, ao lado do volume.
      { label: "Faturamento", href: "/faturamento", icone: "cifrao" },
      { label: "Anúncios", href: "/anuncios", icone: "megafone" },
      { label: "Preços", href: "/precos", icone: "etiqueta" },
      { label: "Curva ABC", href: "/curva-abc", icone: "barras" },
    ],
  },
  {
    id: "estoque",
    title: "Estoque",
    items: [
      { label: "Estoque", href: "/estoque", icone: "caixa" },
      { label: "Central Full", href: "/full", icone: "armazem" },
      { label: "Movimentações", href: "/estoque/movimentacoes", icone: "setas" },
      // Uma entrada só desde a fusão de D-288: quantos dias faltam, e o que
      // comprar por causa disso.
      { label: "Cobertura e reposição", href: "/reposicao", icone: "ciclo" },
    ],
  },
  {
    id: "compras",
    title: "Compras",
    items: [
      { label: "Compras", href: "/compras", icone: "carrinho" },
      { label: "Fornecedores", href: "/fornecedores", icone: "caminhao" },
      { label: "NF-e / Entradas", href: "/notas-fiscais", icone: "recibo" },
    ],
  },
  {
    id: "catalogo",
    title: "Catálogo",
    items: [
      { label: "Produtos", href: "/produtos", icone: "pacotes" },
      { label: "Vinculações", href: "/vinculacoes", icone: "corrente" },
    ],
  },
  {
    id: "atendimento",
    title: "Atendimento",
    items: [
      { label: "Caixa de Entrada", href: "/atendimento", icone: "bandeja" },
      { label: "Base de Conhecimento", href: "/atendimento/conhecimento", icone: "livro" },
    ],
  },
  {
    id: "administracao",
    title: "Administração",
    items: [
      { label: "Usuários", href: "/usuarios", icone: "pessoas" },
      { label: "Contas Mercado Livre", href: "/contas", icone: "loja" },
      { label: "Integrações", href: "/integracoes", icone: "tomada" },
      { label: "Sincronização", href: "/sincronizacao", icone: "sincronizar" },
      /*
        IMPORTAÇÕES É DE ADMIN (D-312): importar uma planilha do UpSeller
        reescreve o catálogo, e o vizinho certo é Sincronização — a outra porta
        de entrada de dado.
      */
      { label: "Importações", href: "/importacoes", icone: "envio", somenteAdmin: true },
      { label: "Saúde do Sistema", href: "/saude", icone: "coracao" },
      { label: "Configurações", href: "/configuracoes", icone: "engrenagem" },
    ],
  },
];

/** Rotas que vivem fora dos grupos, mas disputam o mesmo prefixo. */
const ROTAS_DO_RODAPE = ["/sugestoes"] as const;

/**
 * Qual item está ativo. `/` só casa exato; para o resto, o prefixo com barra —
 * e, se existe um item MAIS específico que também casa, ele é o dono
 * (`/estoque` não acende em `/estoque/movimentacoes`).
 */
function estaAtivo(href: string, pathname: string, todos: readonly string[]): boolean {
  if (href === "/") return pathname === "/";
  if (pathname === href) return true;
  if (!pathname.startsWith(`${href}/`)) return false;

  return !todos.some(
    (outro) => outro !== href && outro.startsWith(`${href}/`) && (pathname === outro || pathname.startsWith(`${outro}/`)),
  );
}

/**
 * Os grupos que a pessoa RECOLHEU, lembrados neste navegador.
 *
 * Nascem todos abertos, como no frame — a primeira versão abria só o grupo da
 * rota atual, e quem estava em /vendas via cabeçalhos mudos. Recolher é escolha
 * de quem usa, e perder a escolha a cada troca de tela (o Shell remonta em toda
 * navegação) seria desfazê-la em silêncio.
 *
 * `localStorage` e não cookie: é preferência de ESTE navegador, e o servidor não
 * precisa dela — o primeiro desenho sai com tudo aberto e o efeito recolhe.
 */
const CHAVE_RECOLHIDOS = "sb-nav-recolhidos";

function lerRecolhidos(): Set<string> {
  try {
    const salvo: unknown = JSON.parse(window.localStorage.getItem(CHAVE_RECOLHIDOS) ?? "[]");

    return new Set(Array.isArray(salvo) ? salvo.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

function gravarRecolhidos(recolhidos: ReadonlySet<string>): void {
  try {
    window.localStorage.setItem(CHAVE_RECOLHIDOS, JSON.stringify([...recolhidos]));
  } catch {
    // Navegação privada ou armazenamento cheio: a escolha só não é lembrada.
  }
}

export function SidebarNav({
  contagens,
  papel,
}: {
  /**
   * Contadores por rota (o "3" na Caixa de Entrada do frame). São números REAIS
   * lidos pelo Shell; ausente ou nulo não desenha o emblema.
   */
  contagens?: Readonly<Record<string, number | null>>;
  /** Papel de quem está logado. Ausente ou desconhecido recorta como NÃO-ADMIN (D-067). */
  papel?: string | null;
}): ReactNode {
  const pathname = usePathname();
  const ehAdmin = papel === "ADMIN";
  const [recolhidos, setRecolhidos] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    setRecolhidos(lerRecolhidos());
  }, []);

  const grupos = NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => item.somenteAdmin !== true || ehAdmin),
  })).filter((group) => group.items.length > 0);

  // O conjunto que decide o item ativo é o VISÍVEL, mais o rodapé.
  const todos = [...grupos.flatMap((g) => g.items.map((i) => i.href)), ...ROTAS_DO_RODAPE];

  function alternar(id: string, aberto: boolean): void {
    setRecolhidos((atual) => {
      const proximo = new Set(atual);

      if (aberto) proximo.delete(id);
      else proximo.add(id);

      gravarRecolhidos(proximo);

      return proximo;
    });
  }

  return (
    <nav aria-label="Navegação principal" className="sb-nav">
      {grupos.map((group) => {
        const temAtivo = group.items.some((item) => estaAtivo(item.href, pathname, todos));
        // O grupo da tela atual nunca nasce recolhido: o destaque não pode
        // morar escondido.
        const aberto = temAtivo || !recolhidos.has(group.id);

        return (
          <details
            key={group.id}
            className="sb-nav-group"
            open={aberto}
            onToggle={(event) => {
              const agora = event.currentTarget.open;

              if (agora !== aberto) alternar(group.id, agora);
            }}
          >
            <summary className="sb-nav-label">
              <span>{group.title}</span>
              <Icone nome="seta" tamanho={12} />
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
                    title={item.label}
                  >
                    <Icone nome={item.icone} />
                    <span className="sb-nav-texto">{item.label}</span>
                    {contagem !== null && contagem > 0 && (
                      <em className="sb-nav-count">{contagem > 99 ? "99+" : contagem}</em>
                    )}
                  </Link>
                );
              })}
            </div>
          </details>
        );
      })}
    </nav>
  );
}

/**
 * Link do RODAPÉ da sidebar ("Sugestões"). Client pelo mesmo motivo do menu:
 * saber se é a rota atual.
 */
export function SidebarRodapeLink({
  href,
  label,
  icone,
}: {
  href: (typeof ROTAS_DO_RODAPE)[number];
  label: string;
  icone: NomeDoIcone;
}): ReactNode {
  const pathname = usePathname();
  const ativo = pathname === href || pathname.startsWith(`${href}/`);

  return (
    <Link href={href} className="sb-sidebar-link" aria-current={ativo ? "page" : undefined}>
      <Icone nome={icone} />
      <span>{label}</span>
    </Link>
  );
}
