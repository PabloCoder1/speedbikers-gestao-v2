import type { ReactNode } from "react";

/**
 * O carregamento de `/configuracoes`, com a FORMA DESTA tela.
 *
 * As outras pastas reexportam `app/loading.tsx`, e por baixo dele mora
 * `CarregandoConteudo`: título, faixa de QUATRO células e UM painel com seis
 * linhas de tabela. Esta tela tem seis células, duas ou três zonas rotuladas e
 * sete cartões em grade — o salto de layout não era risco, era certeza: a
 * faixa mudava de largura por célula e a tabela inteira virava grade.
 *
 * O idioma é o mesmo de `components/carregando.tsx` (`.sb-esqueleto`,
 * `.sb-carregando-revela`, `role="status"`), e o componente compartilhado não
 * é tocado: ele veste 49 telas e a forma específica de uma não é assunto dele.
 *
 * **Não inventa dado.** Nenhuma barra carrega número, rótulo ou contagem; o
 * que ela reproduz é a GEOMETRIA — quantas células, quantas colunas, quantas
 * linhas por cartão. As duas zonas com 2 e 5 cartões são a partição mais
 * comum, não uma previsão: se a real vier diferente, o que muda de lugar é um
 * cartão, não a tela.
 */

function Barra({ largura, altura = "0.625rem" }: { largura: string; altura?: string }): ReactNode {
  return <span aria-hidden="true" className="sb-esqueleto" style={{ width: largura, height: altura }} />;
}

/** Uma célula da faixa: rótulo, número e a ressalva, que agora é visível. */
function Celula(): ReactNode {
  return (
    <div className="sb-kpi">
      <Barra largura="5rem" altura="0.5625rem" />
      <Barra largura="2.5rem" altura="1.125rem" />
      <Barra largura="8rem" altura="0.5625rem" />
    </div>
  );
}

/**
 * Um cartão de área: cabeça (nome + pílula) e as quatro linhas do corpo —
 * resumo, "Inclui:", "Quem altera:" e os chips de link.
 */
function Cartao(): ReactNode {
  return (
    <div className="sb-panel">
      <div className="sb-panel-head">
        <div>
          <Barra largura="8rem" altura="0.8125rem" />
        </div>
        <div className="sb-panel-aside">
          <Barra largura="5rem" altura="1.0625rem" />
        </div>
      </div>

      <div className="sb-panel-body sb-settings-body">
        <Barra largura="100%" altura="0.75rem" />
        <Barra largura="72%" altura="0.75rem" />
        <Barra largura="86%" altura="0.625rem" />
        <Barra largura="58%" altura="0.625rem" />

        <div className="sb-channel-nav sb-settings-links">
          <Barra largura="7rem" altura="2.125rem" />
          <Barra largura="5rem" altura="2.125rem" />
        </div>
      </div>
    </div>
  );
}

function Zona({ cartoes }: { cartoes: number }): ReactNode {
  return (
    <div className="sb-settings-zona">
      {/* Com a classe do rótulo de zona, a margem até a grade é a da tela real. */}
      <span aria-hidden="true" className="sb-eyebrow sb-esqueleto" style={{ width: "11rem", height: "0.5625rem" }} />

      <div className="sb-settings-grid">
        {Array.from({ length: cartoes }, (_, indice) => (
          <Cartao key={indice} />
        ))}
      </div>
    </div>
  );
}

export default function Loading(): ReactNode {
  return (
    <div className="sb-carregando" role="status">
      <span className="sb-sr-only">Carregando as configurações…</span>

      <div aria-hidden="true" className="sb-carregando-revela">
        <div className="sb-page-title sb-page-title-compacto">
          <div>
            <Barra largura="14rem" altura="0.625rem" />
            <Barra largura="min(14rem, 60%)" altura="1.75rem" />
            <Barra largura="min(32rem, 95%)" altura="0.75rem" />
          </div>
        </div>

        <div className="sb-kpi-strip sb-kpi-strip-larga" style={{ ["--sb-kpi-cols" as string]: "6" }}>
          {Array.from({ length: 6 }, (_, indice) => (
            <Celula key={indice} />
          ))}
        </div>

        {/* As zonas num bloco próprio: `.sb-settings-zona` já traz a margem
            de cima que a tela real usa, e dentro do `flex` da revelação ela
            se somaria ao `gap`. */}
        <div>
          <Zona cartoes={2} />
          <Zona cartoes={5} />
        </div>
      </div>
    </div>
  );
}
