import type { ReactNode } from "react";

import Link from "next/link";

import { CarregandoSeODemorar } from "../../components/carregando-link";
import { FilterPill, FilterSubmit } from "../../components/filter-pill";
import { FilterMenu } from "../../components/filter-menu";
import { Icone } from "../../components/icons";
import { KpiStrip, type KpiCellData } from "../../components/kpi-strip";
import { PageTitle } from "../../components/page-title";
import { Panel } from "../../components/panel";
import { Shell } from "../../components/shell";
import {
  formatBusinessDate,
  formatCount,
  formatCurrency,
  formatDateTime,
  formatPercent,
} from "../../lib/format";
import { listingStatusLabel } from "../../lib/labels";
import {
  PAGE_SIZE,
  PRICE_DIRECTIONS,
  buildPriceExportHref,
  buildPriceHref,
  priceDirectionLabel,
  resolvePriceFilters,
  resolvePriceWindow,
  summarizePagedWindow,
} from "../../lib/price-filters";
import { createClient } from "../../lib/supabase/server";
import { currentMembership } from "../../lib/request-membership";

export const metadata = { title: "Histórico de Preços — Speed Bikers Gestão" };

export const dynamic = "force-dynamic";

function recorteLabel(filters: ReturnType<typeof resolvePriceFilters>): string {
  const partes = [
    filters.direction === null ? null : priceDirectionLabel(filters.direction),
    filters.account === null ? null : "uma conta selecionada",
    filters.search === null ? null : `busca “${filters.search}”`,
    filters.dateFrom === null ? null : `desde ${filters.dateFrom.split("-").reverse().join("/")}`,
    filters.dateTo === null ? null : `até ${filters.dateTo.split("-").reverse().join("/")}`,
  ].filter((parte): parte is string => parte !== null);

  return partes.length === 0 ? "Todos os anúncios" : partes.join(" · ");
}

/**
 * Histórico de Preços (`/precos`) pelo frame `IntelligenceScreen
 * type="pricing"` (D24, D-264) — faixa de quatro cartões + painel com a tabela
 * das alterações observadas.
 *
 * **A recusa central: o aviso do frame promete o que não existe.** Ele traz,
 * já escrito, "Dados Insuficientes para Análise Causal" — e a premissa é
 * verdadeira, a tela dizia isso desde D-172. Mas ele conclui que "o sistema
 * apresentará tendências quando o volume de dados estabilizar (geralmente após
 * 7 dias da mudança)", e **nada implementa isso**. Prometer comportamento
 * futuro com prazo é pior do que não prometer: o operador espera uma semana
 * por uma tela que não vai mudar. O bloco entra com a composição do frame e
 * sem a promessa.
 *
 * **"Exportar Relatório" também fica fora.** Exportação existe no produto, mas
 * como rota por documento (`/compras/[id]/export/xlsx`); aqui seria
 * funcionalidade nova, não composição — e botão que não faz nada é pior do que
 * botão nenhum. Registrado como candidata a fatia própria.
 *
 * **O que o frame corrige e entrou:** a coluna **Direção**. A variação era
 * distinguida por cor e sinal; o rótulo AUMENTO/REDUÇÃO é a pista textual que
 * a casa já exige de todo estado ("cor nunca é a única pista"). As cores
 * seguem sendo as daqui — violeta para alta, não o verde do frame: verde
 * afirmaria que subir preço é bom, e uma redução pode ser promoção deliberada.
 * O sistema não tem opinião sobre a direção, só a registra.
 */

export default async function PrecosPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const filters = resolvePriceFilters(await searchParams);
  const supabase = await createClient();

  const [membership, accounts] = await Promise.all([
    currentMembership(),
    supabase.from("ml_accounts").select("id, label").order("label"),
  ]);

  const organizationId = membership.organizationId;

  if (organizationId === null) {
    return (
      <Shell>
        <PageTitle
          eyebrow="INTELIGÊNCIA / PREÇOS"
          title="Histórico de Preços"
          subtitle="Histórico e análise das alterações de preço observadas nos anúncios."
        />
        <Panel title="Acesso indisponível">
          <div className="sb-price-empty">
            <span className="sb-price-empty-icon" aria-hidden="true">
              <Icone nome="etiqueta" tamanho={20} />
            </span>
            <div>
              <strong>Sua conta ainda não pertence a uma organização.</strong>
              <p>Peça a um administrador para concluir o vínculo antes de consultar o histórico de preços.</p>
            </div>
          </div>
        </Panel>
      </Shell>
    );
  }

  // Conta desconhecida (ou de outra organização) na URL vira "sem filtro"
  // antes de tocar a RPC — mesma regra dos conjuntos fechados.
  const accountIds = new Set((accounts.data ?? []).map((row) => row.id));
  const account = filters.account !== null && accountIds.has(filters.account) ? filters.account : null;

  /*
    A janela mudou de casa em D-292: `resolvePriceWindow` é o ÚNICO dono da
    conversão "dia civil → intervalo `[de, ate)`", porque a exportação precisa
    da MESMA conta. Duas cópias produziriam uma planilha de um período e uma
    tela de outro, com o mesmo link.
  */
  const now = new Date();
  const janelaConsulta = resolvePriceWindow(filters, now);

  const { data, error } = await supabase.rpc("get_price_changes", {
    p_organization_id: organizationId,
    p_date_from: janelaConsulta.from,
    p_date_to: janelaConsulta.to,
    p_ml_account_id: account,
    p_direction: filters.direction,
    p_search: filters.search,
    p_limit: PAGE_SIZE,
    p_offset: (filters.page - 1) * PAGE_SIZE,
  });

  const rows = data ?? [];
  const resumo = rows[0] ?? null;

  /*
    Recorte sem linha nenhuma tem, de verdade, quatro zeros — os cartões contam
    O MESMO conjunto que a tabela mostra, então assumir zero aqui não é
    ausência disfarçada de desconhecido (D-067). É o contrário de `/acoes`
    (D-263), onde o painel contava o inbox INTEIRO e por isso precisou de uma
    linha-sentinela para não sumir com as contagens.
  */
  const totalCount = resumo?.total_count ?? 0;
  const aumentos = resumo?.increases ?? 0;
  const reducoes = resumo?.decreases ?? 0;
  const anunciosAfetados = resumo?.listings_affected ?? 0;

  /*
    A data vem do BANCO, já como dia civil de `America/Sao_Paulo`. Era
    `SERIES_START_LABEL = "24/08/2026"`, cravado no código: verdadeiro para a
    única organização com dado e errado para a segunda, porque a série de cada
    uma começa quando a sincronização dela começou (classe D-234).

    `null` quando a organização não tem nenhum evento de preço — e aí a frase
    não inventa data.
  */
  const serieComeca = resumo?.series_start ?? null;

  const janela = summarizePagedWindow({
    page: filters.page,
    totalCount,
    rowsOnPage: rows.length,
    pageSize: PAGE_SIZE,
    noun: { singular: "mudança de preço", plural: "mudanças de preço" },
    emptyLabel: "Nenhuma mudança de preço encontrada com estes filtros.",
  });

  const semDirecao = buildPriceHref(filters, { direction: null, page: 1 });

  const celulas: KpiCellData[] = [
    {
      label: "Alterações",
      formula: "Eventos `listing.price.changed` com preço anterior e novo, no recorte atual dos filtros.",
      value: formatCount(totalCount),
      previous: null,
      href: semDirecao,
      tom: "neutro",
    },
    {
      label: "Aumentos",
      formula: "Alterações em que o preço novo é maior que o anterior.",
      value: formatCount(aumentos),
      previous: null,
      href: buildPriceHref(filters, { direction: "up", page: 1 }),
      tom: "neutro",
    },
    {
      label: "Reduções",
      formula: "Alterações em que o preço novo é menor que o anterior.",
      value: formatCount(reducoes),
      previous: null,
      href: buildPriceHref(filters, { direction: "down", page: 1 }),
      /*
        NEUTRO, como os outros três — e o frame discorda: ele dá borda verde a
        Aumentos e vermelha a Reduções. Isso afirma que subir preço é bom e
        baixar é ruim, e o sistema não tem essa opinião: uma redução pode ser
        promoção deliberada, um aumento pode ser repasse de custo que afunda a
        conversão. A tela REGISTRA a direção; quem julga é quem tem contexto.
      */
      tom: "neutro",
    },
    {
      /*
        SEM chip "ver lista", e é a diferença entre promessa e enfeite (D-242):
        os três de cima levam a um recorte que mostra exatamente aquelas
        linhas. Não existe filtro que devolva "os 186 anúncios" — cada um pode
        ter várias alterações —, então um chip aqui mentiria sobre o destino.
      */
      label: "Anúncios afetados",
      formula: "Anúncios distintos com ao menos uma alteração no recorte — um anúncio pode ter várias.",
      value: formatCount(anunciosAfetados),
      previous: null,
      tom: "neutro",
    },
  ];

  const rotuloConta =
    account === null
      ? "Todas as contas"
      : ((accounts.data ?? []).find((row) => row.id === account)?.label ?? "Conta");
  const filtrosAtivos = [filters.direction, account, filters.search, filters.dateFrom, filters.dateTo].filter(
    (value) => value !== null,
  ).length;
  const recorte = recorteLabel({ ...filters, account });

  return (
    <Shell>
      <PageTitle
        eyebrow="INTELIGÊNCIA / PREÇOS"
        title="Histórico de Preços"
        subtitle="Histórico das alterações de preço observadas nos anúncios."
        aside={
          /*
            O "Exportar Relatório" do frame, entregue em D-292 — D-264 o
            recusou como botão sem função e o registrou como candidata.

            É `<a>`, não `<Link>`: o destino devolve um arquivo com
            `Content-Disposition: attachment`, e o roteador do Next trataria
            isso como navegação. E ele leva os filtros ATUAIS — exporta o que
            está na tela, nunca "tudo".
          */
          <a className="sb-button" href={buildPriceExportHref(filters)} download>
            Exportar XLSX
          </a>
        }
      />

      <KpiStrip cells={celulas} />

      <div className="sb-price-workspace">
      <Panel
        title="Alterações observadas"
        subtitle={janela.label}
        aside={
          <>
            <FilterMenu
              rotulo={filters.direction === null ? "Direção" : priceDirectionLabel(filters.direction)}
              opcoes={[
                { href: semDirecao, label: "Todas", ativo: filters.direction === null },
                ...PRICE_DIRECTIONS.map((direction) => ({
                  href: buildPriceHref(filters, { direction, page: 1 }),
                  label: priceDirectionLabel(direction),
                  ativo: filters.direction === direction,
                })),
              ]}
            />
            <FilterMenu
              rotulo={rotuloConta}
              opcoes={[
                {
                  href: buildPriceHref(filters, { account: null, page: 1 }),
                  label: "Todas as contas",
                  ativo: account === null,
                },
                ...(accounts.data ?? []).map((row) => ({
                  href: buildPriceHref(filters, { account: row.id, page: 1 }),
                  label: row.label,
                  ativo: account === row.id,
                })),
              ]}
            />
          </>
        }
      >
        {/*
          O `.notice` do frame. A PREMISSA dele é verdadeira e a tela já dizia
          isso desde D-172; o que ficou de fora é a promessa — o frame conclui
          que o sistema "apresentará tendências ... após 7 dias da mudança", e
          nada calcula isso. A frase abaixo diz por que não dá, sem prazo.
        */}
        <div className="sb-note sb-price-note">
          <span>DADOS INSUFICIENTES PARA ANÁLISE CAUSAL</span>
          <p>
            Esta tela mostra <strong>o que mudou</strong>, não o efeito da mudança. Afirmar impacto exigiria
            comparar a venda em janelas equivalentes dos dois lados de cada alteração, e a série ainda não tem
            os dois lados.{" "}
            {serieComeca !== null && <>O registro começa em {formatBusinessDate(serieComeca)}. </>}
            A varredura de anúncios roda a cada 6h, então uma mudança feita e desfeita entre duas varreduras
            não deixa registro — <strong>ausência de linha não é preço estável</strong>.
          </p>
        </div>

        <form method="get" action="/precos" className="sb-price-toolbar" aria-label="Filtrar histórico de preços">
          {/* GET nativo só envia os campos do form — preservar as dimensões de menu. */}
          {filters.direction !== null && <input type="hidden" name="direcao" value={filters.direction} />}
          {account !== null && <input type="hidden" name="conta" value={account} />}
          <label className="sb-price-field sb-price-search">
            <span>Buscar</span>
            <span className="sb-price-input-shell">
              <Icone nome="lupa" tamanho={14} />
              <input
                className="sb-input"
                type="search"
                name="busca"
                defaultValue={filters.search ?? ""}
                placeholder="SKU, MLB ou título"
                aria-label="Buscar por MLB, SKU ou título"
              />
            </span>
          </label>
          {/*
            O frame não desenha filtro de data — mas ele EXISTE e recorta de
            verdade. O Design Contract manda remover conteúdo incompatível com
            o frame, não funcionalidade que ele deixou de desenhar.
          */}
          <div className="sb-price-dates" role="group" aria-label="Período do preço">
            <label className="sb-price-field">
              <span>De</span>
              <input className="sb-input" type="date" name="de" defaultValue={filters.dateFrom ?? undefined} />
            </label>
            <label className="sb-price-field">
              <span>Até</span>
              <input className="sb-input" type="date" name="ate" defaultValue={filters.dateTo ?? undefined} />
            </label>
          </div>
          <div className="sb-price-toolbar-actions">
            {filtrosAtivos > 0 && (
              <Link className="sb-button" href="/precos">
                Limpar {filtrosAtivos === 1 ? "filtro" : `${String(filtrosAtivos)} filtros`}
                <CarregandoSeODemorar />
              </Link>
            )}
            <FilterSubmit>Aplicar filtros</FilterSubmit>
          </div>
        </form>

        {error !== null && (
          <div className="sb-price-error" role="alert">
            <span className="sb-price-error-icon" aria-hidden="true">
              <Icone nome="pulso" tamanho={18} />
            </span>
            <div>
              <strong>Não foi possível carregar o histórico agora.</strong>
              <p>Seus filtros foram preservados. Tente novamente; nenhum preço foi alterado.</p>
            </div>
            <Link className="sb-button" href={buildPriceHref(filters, { page: filters.page })}>
              Tentar novamente
              <CarregandoSeODemorar />
            </Link>
          </div>
        )}

        {error === null && rows.length === 0 && (
          <div className="sb-price-empty">
            <span className="sb-price-empty-icon" aria-hidden="true">
              <Icone nome="tendencia" tamanho={20} />
            </span>
            <div>
              <strong>Nenhuma alteração de preço encontrada.</strong>
              <p>
                {filtrosAtivos > 0
                  ? "Revise ou remova os filtros para ampliar a busca."
                  : "Quando um anúncio tiver uma alteração observada, ela aparecerá aqui."}
              </p>
            </div>
            {filtrosAtivos > 0 && <Link className="sb-button" href="/precos">Limpar filtros</Link>}
          </div>
        )}

        {error === null && rows.length > 0 && (
          <div className="sb-price-table-wrap">
            <table className="sb-table sb-price-table">
              <thead>
                <tr>
                  <th>Data / Hora</th>
                  <th>Anúncio</th>
                  <th className="sb-num">Preço anterior</th>
                  <th className="sb-num">Preço atual</th>
                  <th className="sb-num">Variação R$</th>
                  <th className="sb-num">Variação %</th>
                  <th>Direção</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const subiu = row.delta > 0;
                  // Violeta para alta, vermelho para baixa — NÃO o verde do
                  // frame. Verde afirmaria que subir preço é bom, e uma
                  // redução pode ser promoção deliberada.
                  const cor = subiu ? "var(--sb-secondary)" : "var(--sb-danger)";

                  return (
                    <tr key={row.event_id}>
                      <td data-label="Data e hora">
                        <time dateTime={row.occurred_at}>{formatDateTime(row.occurred_at)}</time>
                      </td>

                      {/*
                        O frame junta título, SKU e MLB numa célula só. A conta
                        entra na mesma linha de apoio: ela está nos DADOS do
                        frame (`row[4]`) e ele apenas não a pinta — e sem ela,
                        com "Todas as contas", não dá para saber de quem é a
                        alteração.
                      */}
                      <td data-label="Anúncio" className="sb-price-product">
                        <strong className="sb-price-title">
                          {row.title ?? <span className="sb-price-missing">anúncio fora do catálogo</span>}
                        </strong>
                        <div className="sb-mono sb-price-meta">
                          {row.sku_id !== null && row.sku !== null ? (
                            <Link href={`/skus/${row.sku_id}`}>{row.sku}</Link>
                          ) : (
                            <span>sem vínculo</span>
                          )}
                          {" · "}
                          <Link href={`/anuncios/${row.item_id}`}>{row.item_id}</Link>
                          {row.status !== null && ` · ${listingStatusLabel(row.status)}`}
                          {` · ${row.account_label}`}
                        </div>
                      </td>

                      <td data-label="Preço anterior" className="sb-num sb-price-before">
                        {formatCurrency(row.price_before)}
                      </td>
                      <td data-label="Preço atual" className="sb-num sb-price-current">
                        {formatCurrency(row.price_after)}
                      </td>
                      <td data-label="Variação R$" className="sb-num">
                        <span className="sb-price-delta" style={{ color: cor }}>
                        {subiu ? "+" : ""}
                        {formatCurrency(row.delta)}
                        </span>
                      </td>
                      <td data-label="Variação %" className="sb-num">
                        <span className="sb-price-delta" style={{ color: cor }}>
                        {row.delta_ratio === null ? "—" : `${subiu ? "+" : ""}${formatPercent(row.delta_ratio)}`}
                        </span>
                      </td>

                      {/*
                        A coluna que o frame acrescenta, e ela conserta algo: a
                        variação era distinguida por COR e sinal. O rótulo é a
                        pista textual que a casa exige de todo estado.
                      */}
                      <td data-label="Direção">
                        <span className="sb-status" style={{ color: cor, borderColor: cor }}>
                          {subiu ? "AUMENTO" : "REDUÇÃO"}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <div className="sb-price-recap" aria-label="Recorte atual">
        <span>RECORTE</span>
        <strong>{recorte}</strong>
        <small>{formatCount(totalCount)} {totalCount === 1 ? "alteração" : "alterações"} encontradas</small>
      </div>
      </div>

      {error === null && janela.totalPages > 1 && (
        <nav className="sb-price-pagination" aria-label="Paginação do histórico de preços">
          {filters.page > 1 && (
            <FilterPill href={buildPriceHref(filters, { page: filters.page - 1 })} active={false}>
              ← Anterior
            </FilterPill>
          )}
          {filters.page < janela.totalPages && (
            <FilterPill href={buildPriceHref(filters, { page: filters.page + 1 })} active={false}>
              Próxima →
            </FilterPill>
          )}
        </nav>
      )}
    </Shell>
  );
}
