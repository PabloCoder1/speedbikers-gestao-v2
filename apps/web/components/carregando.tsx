import { Marca } from "./marca";
import type { ReactNode } from "react";

import { SidebarNav } from "./nav";

/**
 * O CARREGAMENTO do app — três tamanhos, um idioma só.
 *
 * - `CarregandoTela`: o fallback de `app/loading.tsx`. Redesenha a moldura
 *   porque o `Shell` mora dentro de cada página e some junto com ela.
 * - `CarregandoConteudo`: o miolo da tela (título, faixa de KPIs, painel), para
 *   quando a moldura real já está de pé e só o conteúdo espera.
 * - `CarregandoBloco`: um painel dentro de uma tela montada (ranking, margem,
 *   gaveta do Copiloto).
 *
 * **Não custa tempo de troca.** É Server Component sem dado nenhum e CSS puro:
 * nada aqui espera, mede ou agenda. O esqueleto nasce transparente e só se
 * revela depois de 350ms (`.sb-carregando-revela` em `app/globals.css`) — uma
 * troca rápida chega antes e ninguém vê carregamento; uma lenta mostra o
 * esqueleto no lugar do que vai chegar.
 *
 * **A moldura não inventa dado.** A sidebar é a `SidebarNav` de verdade (a
 * lista é estática, e o item de destino já acende), mas o nome da organização,
 * o perfil e as contas conectadas vêm do banco — enquanto não chegam, são
 * placeholders parados, não um "Speed Bikers" chutado. Sem o papel, o item
 * `somenteAdmin` fica de fora por esse instante: é o recorte seguro (D-067).
 */

function Barra({ largura, altura = "0.625rem" }: { largura: string; altura?: string }): ReactNode {
  return <span aria-hidden="true" className="sb-esqueleto" style={{ width: largura, height: altura }} />;
}

/** Linhas de tabela — colunas de largura desigual, como uma tabela real. */
function Linhas({ quantidade }: { quantidade: number }): ReactNode {
  return Array.from({ length: quantidade }, (_, indice) => (
    <div key={indice} className="sb-carregando-linha">
      <Barra largura={indice % 2 === 0 ? "82%" : "64%"} />
      <Barra largura="70%" />
      <Barra largura={indice % 3 === 0 ? "48%" : "60%"} />
      <Barra largura="54%" />
    </div>
  ));
}

export function CarregandoConteudo({ rotulo = "Carregando a tela" }: { rotulo?: string }): ReactNode {
  return (
    <div className="sb-carregando" role="status">
      <span className="sb-sr-only">{rotulo}…</span>

      <div aria-hidden="true" className="sb-carregando-revela">
        <div className="sb-page-title">
          <div>
            <Barra largura="6rem" altura="0.625rem" />
            <Barra largura="min(18rem, 70%)" altura="1.75rem" />
            <Barra largura="min(26rem, 90%)" altura="0.75rem" />
          </div>
        </div>

        <div className="sb-kpi-strip" style={{ ["--sb-kpi-cols" as string]: "4" }}>
          {Array.from({ length: 4 }, (_, indice) => (
            <div key={indice} className="sb-kpi">
              <Barra largura="5rem" altura="0.5625rem" />
              <Barra largura="7rem" altura="1.5rem" />
              <Barra largura="9rem" altura="0.625rem" />
            </div>
          ))}
        </div>

        <div className="sb-panel sb-carregando-painel">
          <div className="sb-carregando-painel-cabeca">
            <Barra largura="10rem" altura="0.875rem" />
            <Barra largura="min(16rem, 80%)" altura="0.625rem" />
          </div>
          <Linhas quantidade={6} />
        </div>
      </div>
    </div>
  );
}

export function CarregandoBloco({ rotulo }: { rotulo: string }): ReactNode {
  return (
    <div className="sb-carregando-bloco" role="status">
      <span className="sb-sr-only">Carregando {rotulo}…</span>
      <div aria-hidden="true" className="sb-carregando-revela">
        <Barra largura="10rem" altura="0.875rem" />
        <Linhas quantidade={4} />
      </div>
    </div>
  );
}

export function CarregandoTela(): ReactNode {
  return (
    <div className="sb-shell">
      <aside className="sb-sidebar">
        {/* A marca é estática: sai inteira na hora, sem placeholder (D-355). */}
        <Marca />

        <SidebarNav />

        <div className="sb-sidebar-bottom">
          <div className="sb-account" aria-hidden="true">
            <span className="sb-account-mark" />
            <span style={{ flex: 1, minWidth: 0 }}>
              <Barra largura="6rem" altura="0.625rem" />
            </span>
          </div>
        </div>
      </aside>

      <div className="sb-workspace">
        <header className="sb-topbar sb-carregando-topbar">
          <div className="sb-search" aria-hidden="true">
            <span className="sb-search-icon">⌕</span>
            <span className="sb-search-label">Buscar SKU, anúncio, NF-e…</span>
          </div>

          <div className="sb-top-actions" aria-hidden="true">
            <span className="sb-icon-button">✦</span>
            <span className="sb-icon-button">♧</span>
            <span className="sb-top-rule" />
            <div className="sb-profile">
              <span className="sb-avatar" />
              <span style={{ minWidth: 0 }}>
                <Barra largura="6rem" altura="0.6875rem" />
                <Barra largura="4rem" altura="0.5625rem" />
              </span>
            </div>
          </div>

          <span aria-hidden="true" className="sb-carregando-progresso sb-carregando-revela" />
        </header>

        <main className="sb-content">
          <CarregandoConteudo />
        </main>
      </div>
    </div>
  );
}
