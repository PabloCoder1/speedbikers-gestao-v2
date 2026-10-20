import Link from "next/link";
import { Fragment, type ReactNode } from "react";

import { CarregandoSeODemorar } from "./carregando-link";
import { TOM, type Tom } from "./tone";

/**
 * Faixa de indicadores do Figma (`.kpi-strip`).
 *
 * **É UM cartão dividido em células, não vários cartões lado a lado** — essa é
 * a diferença de composição que mais muda a leitura da tela: a faixa se lê como
 * um bloco só, e o olho percorre os números em vez de tropeçar em seis molduras.
 *
 * `ancora` pinta a primeira célula de navy, como no Figma. É OPCIONAL de
 * propósito: a tela renderizada mostrou que, com três faixas empilhadas, três
 * células navy transformam ênfase em ruído. Só a faixa principal a recebe.
 *
 * As linhas divisórias vêm do `gap` sobre um fundo de borda, e não de
 * `border-right` por célula. É o que faz a faixa continuar certa quando ela
 * quebra em duas linhas na tela estreita — com borda por célula, a última de
 * cada linha ficaria com traço sobrando.
 *
 * ## O que esta faixa carrega além do Figma, e por quê
 *
 * O `.kpi` do Figma tem três linhas: rótulo, valor e uma **variação
 * percentual**. Aqui a terceira linha é o **valor do período anterior**. A
 * variação só entra quando a tela a passa em `variacao` — ela foi definida em
 * D-394 (`docs/METRICS.md` 5I, com tom pela polaridade de cada indicador), e as
 * telas anteriores a isso continuam mostrando só os dois valores lado a lado.
 *
 * E cada célula mostra o **id da métrica** em monoespaçado, mais a **ressalva**
 * quando existe. A ressalva é exigência de `docs/METRICS.md` 5C.2 — "visível ao
 * lado do número, nunca só em tooltip" —, e o id é a rastreabilidade que
 * permite achar a definição canônica. Nenhum dos dois está no Figma; nenhum dos
 * dois sai.
 */
export interface KpiCellData {
  /**
   * Id catalogado em `metric_definitions` — a rastreabilidade da métrica.
   *
   * **Opcional de propósito.** Nem toda faixa mostra métrica de negócio: a
   * curadoria de `/produtos`, por exemplo, conta ESTADOS do catálogo ("não
   * classificados", "a revisar"), que não estão no catálogo de métricas. Pôr um
   * id ali seria apontar para uma definição que não existe — pior do que não
   * apontar. Sem id, a linha não sai.
   */
  readonly metricId?: string;
  readonly label: string;
  /** Fórmula canônica ou explicação da contagem, no `title` da célula. */
  readonly formula: string;
  readonly value: string;
  /** `null` quando a comparação não se aplica (a seção "hoje" não compara). */
  readonly previous: string | null;
  /** Ressalva obrigatória de METRICS 5C.2, quando a métrica tem uma. */
  readonly ressalva?: string;
  /**
   * O chip "ver lista" do `.ops-metric` do Figma — a terceira linha da célula
   * na variante de OPERAÇÃO da faixa (o frame `Listings` usa `<Status>ver
   * lista</Status>` em todas as seis).
   *
   * Aqui ele é um LINK de verdade, para o recorte que produziu o número. É a
   * diferença entre um enfeite e a promessa que a célula faz: se a contagem diz
   * 17 sem estoque, clicar tem de mostrar os 17 — e mostra, porque contagem e
   * lista saem da mesma consulta filtrada.
   */
  readonly href?: string;
  /** Tom do chip, como no frame: cada estado tem o seu. */
  readonly tom?: Tom;
  /**
   * PINTA A PRÓPRIA CÉLULA — rótulo e número —, e não o chip.
   *
   * Existe porque o frame da Administração desenha "Convites Pendentes" com
   * borda e número em âmbar enquanto os quatro vizinhos ficam em navy (D-297).
   * Numa faixa que é UM cartão dividido em células não há borda por célula para
   * tingir, e o que resta é a tinta do número, que é justamente o que o olho
   * procura.
   *
   * Separado de `tom` de propósito: `tom` veste o chip "ver lista", e seis telas
   * já o declaram em todas as células — reaproveitá-lo aqui pintaria faixa
   * inteira de colorido, que é ênfase em tudo, ou seja, ênfase em nada. Só quem
   * pede destaque recebe.
   */
  readonly destaque?: Tom;
  /**
   * A variação contra o período anterior ("↑ 12,8%", "↓ 2,1 p.p."), num chip
   * no tom que a polaridade do indicador deu (D-394). É chip, e não tinta no
   * texto, porque a célula âncora é navy: o fundo suave do tom é o que mantém
   * o contraste nas duas superfícies.
   */
  readonly variacao?: { readonly texto: string; readonly tom: Tom; readonly titulo: string };
}

/**
 * Uma célula que CHEGA DEPOIS do resto da faixa (D-509): um `<Suspense>` com um
 * componente async que devolve `<KpiCell>`, na posição dela. A faixa já nasce
 * com a coluna contada (`--sb-kpi-cols`), então a chegada não desloca nada.
 *
 * Existe para a leitura cara que alimenta uma célula só — a taxa de
 * cancelamento de `/vendas`, que custava 3,8 s a frio para um número entre
 * cinco. O `fallback` deve ser o `KpiCellCarregando` com o rótulo de verdade.
 */
export interface KpiCellTardia {
  readonly chave: string;
  readonly tardia: ReactNode;
}

export function KpiStrip({
  cells,
  ancora = false,
}: {
  cells: readonly (KpiCellData | KpiCellTardia)[];
  ancora?: boolean;
}): ReactNode {
  // Colunas FIXAS, como `.kpi-strip{repeat(5,1fr)}` do export: a faixa declara
  // quantas células tem e o CSS nunca deixa uma órfã. Faixas de 5 ou mais
  // descem a 3 colunas em 1150px (o degrau do `.ops-metrics`); todas descem a
  // 2 em 850px. A célula tardia conta desde o começo.
  const classes = ["sb-kpi-strip", ancora ? "sb-kpi-strip-ancora" : null, cells.length >= 5 ? "sb-kpi-strip-larga" : null]
    .filter((c): c is string => c !== null)
    .join(" ");

  return (
    <div className={classes} style={{ ["--sb-kpi-cols" as string]: String(cells.length) }}>
      {cells.map((cell) =>
        "tardia" in cell ? (
          <Fragment key={cell.chave}>{cell.tardia}</Fragment>
        ) : (
          // O id da métrica pode repetir na mesma faixa (os três cenários da
          // projeção são a mesma métrica, D-395); o rótulo não repete.
          <KpiCell key={`${cell.metricId ?? ""}:${cell.label}`} cell={cell} />
        ),
      )}
    </div>
  );
}

/** Uma célula da faixa — exportada para a célula tardia (D-509) devolver a MESMA marcação. */
export function KpiCell({ cell }: { cell: KpiCellData }): ReactNode {
  return (
    <div className="sb-kpi" title={cell.formula}>
      <span className="sb-kpi-label" style={cell.destaque === undefined ? undefined : { color: TOM[cell.destaque].color }}>
        {cell.label}
      </span>
      <strong className="sb-kpi-value" style={cell.destaque === undefined ? undefined : { color: TOM[cell.destaque].color }}>
        {cell.value}
      </strong>

      {cell.variacao !== undefined && (
        <span className="sb-kpi-var" style={TOM[cell.variacao.tom]} title={cell.variacao.titulo}>
          {cell.variacao.texto}
        </span>
      )}

      {cell.previous !== null && <span className="sb-kpi-prev">período anterior: {cell.previous}</span>}

      {cell.ressalva !== undefined && <span className="sb-kpi-note">{cell.ressalva}</span>}

      {cell.metricId !== undefined && <span className="sb-kpi-id">{cell.metricId}</span>}

      {cell.href !== undefined && (
        <Link className="sb-kpi-link" href={cell.href} style={TOM[cell.tom ?? "info"]}>
          ver lista
          <CarregandoSeODemorar />
        </Link>
      )}
    </div>
  );
}

/**
 * O lugar de uma célula que ainda não chegou (D-509). Tudo o que é ESTÁTICO sai
 * de verdade — rótulo, ressalva e id —, e o valor e o período anterior viram
 * traços com as MESMAS classes da célula pronta e um texto-modelo transparente:
 * a linha tem a altura exata, e a faixa não cresce quando o número chega.
 * Medido na `/vendas`: sem a ressalva no esqueleto, a faixa ia de 114 a 148 px
 * na chegada (CLS 0,011). Como o resto do carregamento (D-382), os traços só
 * aparecem depois de 350 ms.
 */
export function KpiCellCarregando({
  label,
  metricId,
  ressalva,
  reserva,
  comparacao = true,
  modelo = "00,0%",
}: {
  label: string;
  metricId?: string;
  /** A ressalva da célula pronta, quando ela tem uma: é texto fixo, não dado. */
  ressalva?: string;
  /**
   * O lugar do trecho da ressalva que DEPENDE do dado, com a forma dele e
   * transparente (D-620, a pedido do A3): a taxa de cada marketplace no "Todos"
   * de `/vendas`. Sem ele, a célula pronta fica mais alta que o esqueleto e a
   * faixa desloca o que vem abaixo.
   */
  reserva?: string;
  /** Sem comparação, a célula de verdade não tem a linha do período anterior. */
  comparacao?: boolean;
  /** Um valor com a forma do que vem ("00,0%", "R$ 00.000,00"), só para dar a largura do traço. */
  modelo?: string;
}): ReactNode {
  return (
    <div className="sb-kpi" aria-busy="true">
      <span className="sb-kpi-label">{label}</span>
      <span className="sb-sr-only" role="status">
        Carregando {label.toLowerCase()}…
      </span>
      <strong aria-hidden="true" className="sb-kpi-value sb-kpi-carregando">
        {modelo}
      </strong>
      {comparacao && (
        <span aria-hidden="true" className="sb-kpi-prev sb-kpi-carregando">
          período anterior: {modelo}
        </span>
      )}
      {ressalva !== undefined && (
        <span className="sb-kpi-note">
          {ressalva}
          {reserva !== undefined && (
            <span aria-hidden="true" className="sb-kpi-carregando">
              {reserva}
            </span>
          )}
        </span>
      )}
      {metricId !== undefined && <span className="sb-kpi-id">{metricId}</span>}
    </div>
  );
}
