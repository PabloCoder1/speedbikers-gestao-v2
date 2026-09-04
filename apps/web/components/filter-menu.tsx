import type { ReactNode } from "react";

/**
 * Menu de filtro da barra de ferramentas — o `.button.ghost` com chevron que
 * abre um dropdown, como a toolbar de `Sales` ("Geral ⌄", "Últimos 30 dias ⌄")
 * e a barra do painel de `Listings` ("Status ⌄") no export.
 *
 * Nasceu de dez cópias do mesmo `<details className="sb-menu">` em `/vendas`,
 * `/anuncios` e `/produtos` — a auditoria de fidelidade contou; a décima
 * primeira seria a que sairia de sincronia. É Server Component sem estado: o
 * `<details>` nativo faz o dropdown e cada opção é um LINK, então o recorte
 * continua na URL (compartilhável, com voltar do navegador e Filtros Salvos
 * funcionando), nunca em estado React.
 *
 * `children` aceita conteúdo extra no fim do painel — o formulário de período
 * personalizado de `/vendas` é o único caso.
 */
export interface FilterOption {
  readonly href: string;
  readonly label: string;
  readonly ativo: boolean;
}

export function FilterMenu({
  rotulo,
  opcoes,
  children,
}: {
  /** O que o botão mostra — normalmente a opção ativa. */
  rotulo: string;
  opcoes: readonly FilterOption[];
  children?: ReactNode;
}): ReactNode {
  return (
    <details className="sb-menu">
      <summary className="sb-button">
        {rotulo}
        <span aria-hidden="true" className="sb-menu-chevron">
          ⌄
        </span>
      </summary>
      <div className="sb-menu-panel">
        {opcoes.map((opcao) => (
          <a
            key={opcao.href}
            className="sb-menu-item"
            aria-current={opcao.ativo ? "true" : undefined}
            href={opcao.href}
          >
            {opcao.label}
          </a>
        ))}
        {children}
      </div>
    </details>
  );
}
