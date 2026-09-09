import type { ReactNode } from "react";

import Link from "next/link";

import { FilterPill, FilterSubmit } from "../../components/filter-pill";
import { FilterMenu } from "../../components/filter-menu";
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
  buildPriceHref,
  priceDirectionLabel,
  resolvePriceFilters,
  summarizePagedWindow,
} from "../../lib/price-filters";
import { createClient } from "../../lib/supabase/server";
import { currentMembership } from "../../lib/membership";

export const metadata = { title: "Histórico de Preços — Speed Bikers Gestão" };

export const dynamic = "force-dynamic";

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

const LOOKBACK_DAYS = 30;

export default async function PrecosPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const filters = resolvePriceFilters(await searchParams);
  const supabase = await createClient();

  const [membership, accounts] = await Promise.all([
    currentMembership(supabase),
    supabase.from("ml_accounts").select("id, label").order("label"),
  ]);

  const organizationId = membership.organizationId;

  if (organizationId === null) {
    return (
      <Shell>
        <PageTitle eyebrow="INTELIGÊNCIA / PREÇOS" title="Histórico de Preços" />
        <p className="sb-empty">Sua conta não está associada a nenhuma organização.</p>
      </Shell>
    );
  }

  // Conta desconhecida (ou de outra organização) na URL vira "sem filtro"
  // antes de tocar a RPC — mesma regra dos conjuntos fechados.
  const accountIds = new Set((accounts.data ?? []).map((row) => row.id));
  const account = filters.account !== null && accountIds.has(filters.account) ? filters.account : null;

  // O usuário filtra por DIA; o evento tem hora. `ate` é inclusivo na tela e
  // vira o início do dia seguinte na consulta — o intervalo é `[de, ate)`.
  const now = new Date();
  const defaultFrom = new Date(now.getTime() - (LOOKBACK_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);
  const dateFrom = filters.dateFrom ?? defaultFrom;
  const dateTo = filters.dateTo;

  const { data, error } = await supabase.rpc("get_price_changes", {
    p_organization_id: organizationId,
    p_date_from: `${dateFrom}T00:00:00Z`,
    p_date_to:
      dateTo === null
        ? new Date(now.getTime() + 86_400_000).toISOString()
        : new Date(new Date(`${dateTo}T00:00:00Z`).getTime() + 86_400_000).toISOString(),
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

  return (
    <Shell>
      <PageTitle
        eyebrow="INTELIGÊNCIA / PREÇOS"
        title="Histórico de Preços"
        subtitle="Histórico das alterações de preço observadas nos anúncios."
      />

      <KpiStrip cells={celulas} />

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
        <div className="sb-note" style={{ margin: "var(--sb-space-3) 1.25rem 0" }}>
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

        <form
          method="get"
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: "0.375rem",
            margin: "var(--sb-space-3) 1.25rem",
            fontSize: "0.8125rem",
          }}
        >
          {/* GET nativo só envia os campos do form — preservar as dimensões de menu. */}
          {filters.direction !== null && <input type="hidden" name="direcao" value={filters.direction} />}
          {account !== null && <input type="hidden" name="conta" value={account} />}
          <input
            className="sb-input"
            type="search"
            name="busca"
            defaultValue={filters.search ?? ""}
            placeholder="Buscar SKU, MLB ou título"
            aria-label="Buscar por MLB, SKU ou título" style={{ minWidth: "14rem" }}
          />
          {/*
            O frame não desenha filtro de data — mas ele EXISTE e recorta de
            verdade. O Design Contract manda remover conteúdo incompatível com
            o frame, não funcionalidade que ele deixou de desenhar.
          */}
          <input
            className="sb-input"
            type="date"
            name="de"
            defaultValue={filters.dateFrom ?? undefined}
            aria-label="Data inicial"
          />
          <span style={{ color: "var(--sb-text-soft)" }}>até</span>
          <input
            className="sb-input"
            type="date"
            name="ate"
            defaultValue={filters.dateTo ?? undefined}
            aria-label="Data final"
          />
          <FilterSubmit>Filtrar</FilterSubmit>
        </form>

        {error !== null && (
          <p role="alert" style={{ margin: "0 1.25rem var(--sb-space-3)", color: "var(--sb-danger)" }}>
            Não foi possível carregar as mudanças de preço: {error.message}
          </p>
        )}

        {error === null && rows.length === 0 && <p className="sb-empty">{janela.label}</p>}

        {error === null && rows.length > 0 && (
          <div style={{ overflowX: "auto" }}>
            <table className="sb-table">
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
                      <td style={{ whiteSpace: "nowrap" }}>{formatDateTime(row.occurred_at)}</td>

                      {/*
                        O frame junta título, SKU e MLB numa célula só. A conta
                        entra na mesma linha de apoio: ela está nos DADOS do
                        frame (`row[4]`) e ele apenas não a pinta — e sem ela,
                        com "Todas as contas", não dá para saber de quem é a
                        alteração.
                      */}
                      <td>
                        {row.title ?? (
                          <span style={{ color: "var(--sb-text-soft)" }}>anúncio fora do catálogo</span>
                        )}
                        <div className="sb-mono">
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

                      <td className="sb-num" style={{ textDecoration: "line-through", color: "var(--sb-text-soft)" }}>
                        {formatCurrency(row.price_before)}
                      </td>
                      <td className="sb-num" style={{ fontWeight: 600 }}>
                        {formatCurrency(row.price_after)}
                      </td>
                      <td className="sb-num" style={{ color: cor }}>
                        {subiu ? "+" : ""}
                        {formatCurrency(row.delta)}
                      </td>
                      <td className="sb-num" style={{ color: cor, fontWeight: 600 }}>
                        {row.delta_ratio === null ? "—" : `${subiu ? "+" : ""}${formatPercent(row.delta_ratio)}`}
                      </td>

                      {/*
                        A coluna que o frame acrescenta, e ela conserta algo: a
                        variação era distinguida por COR e sinal. O rótulo é a
                        pista textual que a casa exige de todo estado.
                      */}
                      <td>
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

      {error === null && janela.totalPages > 1 && (
        <div style={{ display: "flex", gap: "var(--sb-space-2)", marginTop: "var(--sb-space-3)" }}>
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
        </div>
      )}
    </Shell>
  );
}
