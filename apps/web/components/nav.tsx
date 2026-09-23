"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

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
 * - **Copiloto** sai do menu e vira o botão flutuante do canto (D-377): ele não
 *   é um assunto ao lado dos outros, é o que se pergunta SOBRE o assunto aberto
 *   — e o menu é para onde se vai, não para com quem se fala;
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
      { label: "Notas e Documentos", href: "/notas-fiscais", icone: "recibo" },
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
      { label: "Perguntas", href: "/atendimento/perguntas", icone: "duvida" },
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
      // get_system_health é só ADMIN: sem isto o item levava os outros papéis a
      // uma tela de acesso restrito (lote 1 do pente fino, 18/09).
      { label: "Saúde do Sistema", href: "/saude", icone: "coracao", somenteAdmin: true },
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

/**
 * A ROLAGEM do menu, guardada FORA do componente.
 *
 * O `Shell` mora dentro de cada página — e o esqueleto de `carregando.tsx`
 * redesenha a mesma moldura —, então toda navegação desmonta esta `<nav>` e
 * monta outra no lugar. A nova nasce no topo, e era isso que jogava a lista
 * para cima a cada clique: quem escolhia "Configurações", no fim do menu, caía
 * na tela certa mas com o menu no começo; se a tela era a errada, tinha que
 * descer tudo de novo para corrigir.
 *
 * Um módulo vive enquanto a ABA vive: o valor atravessa a troca de tela e morre
 * no recarregamento, que é justamente quando começar do topo é o certo. Não é
 * `localStorage` (a preferência de recolhimento é, e por isso tem chave): a
 * posição da barra é do momento, não uma escolha para lembrar amanhã.
 */
let rolagemDoMenu = 0;

/**
 * Guarda a posição — MENOS quando quem a mudou foi o navegador.
 *
 * Entre uma tela e outra passa o esqueleto de `carregando.tsx`, e o menu dele
 * não conhece o PAPEL: os itens de ADMIN ficam de fora por esse instante, a
 * lista encurta e o navegador apara a rolagem para o novo fim. Isso dispara um
 * `scroll` como qualquer outro — medido, o menu voltava 119px a cada clique,
 * que é a altura dos dois itens que faltavam.
 *
 * A regra separa os dois casos: encurtou (a rolagem parou no fim da lista e
 * é MENOR do que a guardada) não sobrescreve nada. Guardar um valor grande
 * demais não faz mal — ele volta a ser aparado na hora de repor, e aparado no
 * fim é exatamente onde a pessoa estava.
 */
function guardarRolagem(menu: HTMLElement): void {
  const noFim = menu.scrollTop + menu.clientHeight >= menu.scrollHeight - 1;

  if (!noFim || menu.scrollTop > rolagemDoMenu) rolagemDoMenu = menu.scrollTop;
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
  const menu = useRef<HTMLElement | null>(null);

  /**
   * Repõe a posição na MESMA pintura em que a `<nav>` entra no DOM.
   *
   * É `ref` de função e não `useEffect` de propósito: o efeito roda depois do
   * navegador desenhar, e o menu apareceria no topo por um quadro antes de
   * pular para o lugar — trocaria um salto por um tremor. A `ref` roda na
   * montagem, antes da pintura, e a lista já nasce onde estava.
   */
  const fixarMenu = useCallback((elemento: HTMLElement | null) => {
    menu.current = elemento;

    if (elemento !== null) elemento.scrollTop = rolagemDoMenu;
  }, []);

  useEffect(() => {
    setRecolhidos(lerRecolhidos());
  }, []);

  /**
   * Os grupos nascem TODOS abertos e só recolhem no efeito acima: a lista
   * encolhe DEPOIS da montagem, e o navegador apara a rolagem junto com ela.
   * Repor a posição a cada mudança de recolhimento devolve o que a poda tirou;
   * quando não há nada a devolver, escrever o mesmo número não faz nada.
   */
  useEffect(() => {
    if (menu.current !== null) menu.current.scrollTop = rolagemDoMenu;
  }, [recolhidos]);

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
    <nav
      aria-label="Navegação principal"
      className="sb-nav"
      ref={fixarMenu}
      onScroll={(event) => {
        guardarRolagem(event.currentTarget);
      }}
    >
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

/**
 * Telas que EXISTEM e não estão no menu, mas que a busca precisa achar.
 *
 * Uma só, por enquanto: a tela cheia do Copiloto. D-377 tirou o item do menu
 * porque a conversa passou a abrir pelo botão flutuante, e o efeito colateral
 * seria mudo — `paginasDoMenu` alimenta o `Ctrl+K`, então a rota viraria uma
 * tela alcançável por UM link no rodapé de uma gaveta. Sair da barra é decisão
 * de composição; sumir da busca seria outra decisão, que ninguém tomou.
 */
const PAGINAS_FORA_DO_MENU: readonly { label: string; href: string; grupo: string }[] = [
  { label: "Copiloto", href: "/copiloto", grupo: "Visão geral" },
  /*
    Templates de resposta (D-392): a tela existe desde a D-111, alcançável por
    três links — a Caixa de Entrada, a tela de Perguntas e o hub de
    Configurações —, e por nenhuma busca. Quem sabia o nome dela não tinha como
    digitá-lo. Ela FICA fora da barra de propósito, como o Copiloto: é onde se
    mantém o texto, não uma tela de operação do dia.
  */
  { label: "Templates de resposta", href: "/atendimento/templates", grupo: "Atendimento" },
];

/**
 * As telas do menu que este papel alcança, como lista plana — para a busca
 * (`CommandPalette`) oferecer "ir para a tela" com EXATAMENTE a regra do menu
 * (lote 3 do pente fino, 18/09). No celular a busca é a navegação mais rápida,
 * e ela só achava registros, nunca telas.
 */
export function paginasDoMenu(papel: string | null): { label: string; href: string; grupo: string }[] {
  const ehAdmin = papel === "ADMIN";

  return [
    ...NAV_GROUPS.flatMap((group) =>
      group.items
        .filter((item) => item.somenteAdmin !== true || ehAdmin)
        .map((item) => ({ label: item.label, href: item.href, grupo: group.title })),
    ),
    ...PAGINAS_FORA_DO_MENU,
  ];
}
