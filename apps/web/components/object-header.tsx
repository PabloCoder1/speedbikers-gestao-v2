import Link from "next/link";
import type { ReactNode } from "react";

import { TOM, type Tom } from "./tone";

/**
 * Cabeçalho de entidade — o "Object Header" do `DesignSystem.tsx` do Figma, que
 * lá é declarado como **o padrão de SKU, anúncio, pedido de compra e
 * fornecedor**. É o componente de maior alavanca desta frente: quatro telas de
 * detalhe montavam quatro cabeçalhos diferentes.
 *
 * A ordem é a do design system, e cada linha tem um papel:
 *
 *   sobrancelha monoespaçada   o IDENTIFICADOR (SKU 5821, MLB440901) — o que
 *                              se copia, se busca e se cola em outro sistema
 *   título                     o nome humano
 *   selos + meta               o ESTADO, e quando foi visto pela última vez
 *   ações à direita            o que se pode fazer com a entidade
 *   abas                       separadas por uma borda, com a atual sublinhada
 *
 * **O identificador vem em mono e a sobrancelha, não no `<h1>`.** Era o
 * contrário: a tela de SKU abria com `<h1>E2E-SKU-001</h1>` e o nome do produto
 * como parágrafo cinza. O código do SKU é chave, não título — quem lê a tela
 * procura o produto, e quem copia procura a chave.
 *
 * `meta` é opcional e fica ao lado dos selos: no Figma é "Atualizado há 3
 * minutos". Só entra quando existe um instante real para mostrar — data
 * inventada de frescor é a classe de mentira que este projeto persegue.
 *
 * `metricas` é a FILEIRA de fatos do objeto, abaixo dos selos (D-310) — no
 * frame do anúncio são "Preço · Tipo · Catálogo", separados por fio vertical,
 * dentro da coluna da identidade. É **opcional**, e isso é decisão, não
 * preguiça: sete rotas de detalhe montam este cabeçalho e cada uma tem os seus
 * fatos de identidade (o pedido de compra tem valor e fornecedor; a nota tem
 * chave e emitente). Quem não passa `metricas` não muda de pixel, e a adoção de
 * cada tela é fatia com render próprio — nunca um efeito colateral desta.
 */
export interface ObjectBadge {
  readonly label: string;
  readonly tom: Tom;
}

/**
 * Um fato de identidade do objeto: rótulo curto, valor, e a qualificação que
 * não cabe na célula.
 *
 * `nota` vira `title` — o mesmo device de `KpiStrip` (a `formula` da célula).
 * Uma terceira linha por célula transformaria a fileira num parágrafo dentro
 * do cabeçalho, que é exatamente o que o frame não faz.
 */
export interface ObjectMetric {
  readonly rotulo: string;
  readonly valor: string;
  readonly nota?: string;
}

export interface ObjectTab {
  readonly href: string;
  readonly label: string;
  readonly active: boolean;
}

export function ObjectHeader({
  identificador,
  titulo,
  badges = [],
  meta,
  metricas = [],
  acoes,
  abas,
  rotuloAbas = "Abas",
  children,
}: {
  identificador: string;
  titulo: string;
  badges?: readonly ObjectBadge[];
  meta?: ReactNode;
  /** Fatos de identidade do objeto, na fileira abaixo dos selos (D-310). */
  metricas?: readonly ObjectMetric[];
  acoes?: ReactNode;
  abas?: readonly ObjectTab[];
  /**
   * Nome acessível da fileira de abas. Era a string fixa "Abas do SKU", que
   * este componente já servia a mais de uma entidade — num anúncio, o leitor
   * de tela anunciava a navegação com o nome da entidade errada. Cada tela diz
   * a sua.
   */
  rotuloAbas?: string;
  /** Conteúdo da aba, dentro do mesmo cartão — como no frame. */
  children?: ReactNode;
}): ReactNode {
  return (
    <section className="sb-object" aria-label={titulo}>
      <div className="sb-object-head">
        <div style={{ minWidth: 0 }}>
          <span className="sb-object-id">{identificador}</span>
          {/*
            `h2`, não `h1`: no frame o cartão de entidade vem DEPOIS de um
            cabeçalho de página ("CATÁLOGO / DETALHE DO PRODUTO" + "Detalhe do
            SKU"), que é o h1 da tela. O nome do produto é o título do cartão.
          */}
          <h2 className="sb-object-title">{titulo}</h2>

          {(badges.length > 0 || meta !== undefined) && (
            <div className="sb-object-badges">
              {badges.map((badge) => (
                <span key={badge.label} className="sb-status" style={TOM[badge.tom]}>
                  {badge.label}
                </span>
              ))}
              {meta !== undefined && <span className="sb-object-meta">{meta}</span>}
            </div>
          )}

          {/*
            A fileira fica DENTRO da coluna da identidade, abaixo dos selos, e
            não como faixa da largura do cartão: no frame ela é alinhada ao
            título (App.tsx:4097-4103), e uma faixa de ponta a ponta viraria a
            faixa de PÁGINA (`.sb-kpi-strip`), que é outro componente com outro
            significado.
          */}
          {metricas.length > 0 && (
            <div className="sb-object-metrics">
              {metricas.map((metrica) => (
                <div
                  className="sb-object-metric"
                  key={metrica.rotulo}
                  {...(metrica.nota === undefined ? {} : { title: metrica.nota })}
                >
                  <span className="sb-object-metric-label">{metrica.rotulo}</span>
                  <b className="sb-object-metric-value">{metrica.valor}</b>
                </div>
              ))}
            </div>
          )}
        </div>

        {acoes !== undefined && <div className="sb-object-actions">{acoes}</div>}
      </div>

      {abas !== undefined && abas.length > 0 && (
        <nav aria-label={rotuloAbas} className="sb-object-tabs">
          {abas.map((aba) => (
            <Link key={aba.href} href={aba.href} aria-current={aba.active ? "page" : undefined}>
              {aba.label}
            </Link>
          ))}
        </nav>
      )}

      {children !== undefined && <div className="sb-object-body">{children}</div>}
    </section>
  );
}
