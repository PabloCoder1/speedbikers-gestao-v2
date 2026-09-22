import Link from "next/link";
import type { ReactNode } from "react";

import { CarregandoSeODemorar } from "../../../components/carregando-link";
import { FilterMenu } from "../../../components/filter-menu";
import { Icone } from "../../../components/icons";
import { KpiStrip, type KpiCellData } from "../../../components/kpi-strip";
import { PageTitle } from "../../../components/page-title";
import { Panel } from "../../../components/panel";
import { Shell } from "../../../components/shell";
import { formatCount, formatDateTime } from "../../../lib/format";
import {
  LOCATION_KINDS,
  MOVEMENT_TYPES,
  PAGE_SIZE,
  SOURCE_TYPES,
  buildMovementHref,
  resolveMovementFilters,
  summarizePagedWindow,
} from "../../../lib/movement-filters";
import {
  formatQtyDelta,
  locationKindLabel,
  movementSourceHref,
  movementSourceLabel,
  movementTypeLabel,
} from "../../../lib/movement-labels";
import { currentMembership } from "../../../lib/request-membership";
import { createClient } from "../../../lib/supabase/server";

export const metadata = { title: "Movimentações de Estoque — Speed Bikers Gestão" };

export const dynamic = "force-dynamic";

interface MovementRow {
  id: string;
  occurred_at: string;
  movement_type: string;
  location_kind: string;
  qty_delta: number;
  sku_id: string;
  sku: string;
  sku_title: string | null;
  source_type: string | null;
  source_id: string | null;
  reason: string | null;
  created_by_name: string | null;
  total_count: number;
}

function recorteLabel(filters: ReturnType<typeof resolveMovementFilters>): string {
  const partes = [
    filters.movementType === null ? null : movementTypeLabel(filters.movementType),
    filters.locationKind === null ? null : locationKindLabel(filters.locationKind),
    filters.sourceType === null ? null : movementSourceLabel(filters.sourceType, null),
    filters.search === null ? null : `busca “${filters.search}”`,
    filters.dateFrom === null ? null : `desde ${filters.dateFrom.split("-").reverse().join("/")}`,
    filters.dateTo === null ? null : `até ${filters.dateTo.split("-").reverse().join("/")}`,
  ].filter((parte): parte is string => parte !== null);

  return partes.length === 0 ? "Todos os movimentos" : partes.join(" · ");
}

export default async function MovimentacoesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const query = await searchParams;
  const filters = resolveMovementFilters(query);
  const [supabase, membership] = await Promise.all([createClient(), currentMembership()]);
  const organizationId = membership.organizationId;

  if (organizationId === null) {
    return (
      <Shell>
        <PageTitle
          eyebrow="ESTOQUE / OPERAÇÃO"
          title="Movimentações"
          subtitle="Histórico auditável de entradas, saídas e ajustes de estoque."
        />
        <Panel title="Acesso indisponível">
          <div className="sb-mov-empty">
            <span className="sb-mov-empty-icon" aria-hidden="true">
              <Icone nome="armazem" tamanho={20} />
            </span>
            <div>
              <strong>Sua conta ainda não pertence a uma organização.</strong>
              <p>Peça a um administrador para concluir o vínculo antes de consultar o histórico de estoque.</p>
            </div>
          </div>
        </Panel>
      </Shell>
    );
  }

  const recorte = {
    p_organization_id: organizationId,
    p_search: filters.search,
    p_movement_type: filters.movementType,
    p_location_kind: filters.locationKind,
    p_source_type: filters.sourceType,
    p_date_from: filters.dateFrom,
    p_date_to: filters.dateTo,
  };

  // As leituras são independentes e usam exatamente o mesmo recorte. A tabela
  // continua útil se apenas a faixa falhar; nesse caso os números viram ausência
  // explícita, nunca zeros inventados.
  const [ledger, resumo] = await Promise.all([
    supabase.rpc("get_stock_movements", {
      ...recorte,
      p_limit: PAGE_SIZE,
      p_offset: (filters.page - 1) * PAGE_SIZE,
    }),
    supabase.rpc("get_stock_movements_summary", recorte).maybeSingle(),
  ]);

  const rows = (ledger.data ?? []) as MovementRow[];
  const total = resumo.error === null ? resumo.data : null;
  const resumoDisponivel = total !== null;
  const totalCount = rows[0]?.total_count ?? total?.movimentacoes ?? 0;
  const window = summarizePagedWindow({
    page: filters.page,
    totalCount,
    rowsOnPage: rows.length,
    pageSize: PAGE_SIZE,
    noun: { singular: "movimento", plural: "movimentos" },
    emptyLabel: "Nenhum movimento encontrado com estes filtros.",
  });
  const filtrosAtivos = [
    filters.search,
    filters.movementType,
    filters.locationKind,
    filters.sourceType,
    filters.dateFrom,
    filters.dateTo,
  ].filter((valor) => valor !== null).length;
  const paginaForaDoRecorte = ledger.error === null && totalCount > 0 && rows.length === 0;
  const indisponivel = "Indicador indisponível; o extrato abaixo continua utilizável.";

  const celulas: readonly KpiCellData[] = [
    {
      label: "Movimentações no recorte",
      formula: "Linhas do ledger que passam pelos filtros atuais — contagem, nunca soma de quantidade.",
      value: resumoDisponivel ? formatCount(total.movimentacoes) : "—",
      previous: null,
      ...(resumoDisponivel ? {} : { ressalva: indisponivel }),
      tom: "neutro",
    },
    {
      label: "Entradas",
      formula: "Movimentações com delta positivo. O sinal decide, não o tipo.",
      value: resumoDisponivel ? formatCount(total.entradas) : "—",
      previous: null,
      ...(resumoDisponivel ? {} : { ressalva: indisponivel }),
      tom: "ok",
    },
    {
      label: "Saídas",
      formula: "Movimentações com delta negativo, pelo mesmo critério de sinal.",
      value: resumoDisponivel ? formatCount(total.saidas) : "—",
      previous: null,
      ...(resumoDisponivel ? {} : { ressalva: indisponivel }),
      tom: "atencao",
    },
    {
      label: "SKUs tocados",
      formula: "SKUs distintos presentes no recorte atual.",
      value: resumoDisponivel ? formatCount(total.skus_tocados) : "—",
      previous: null,
      ...(resumoDisponivel ? {} : { ressalva: indisponivel }),
      tom: "neutro",
    },
  ];

  return (
    <Shell>
      <PageTitle
        eyebrow="ESTOQUE / OPERAÇÃO"
        title="Movimentações"
        subtitle="Entenda quando, por que e por quem cada saldo de estoque foi alterado."
        aside={
          <Link className="sb-button" href="/estoque">
            <Icone nome="caixa" tamanho={14} />
            Ver posição de estoque
          </Link>
        }
      />

      <KpiStrip cells={celulas} />

      <div className="sb-mov-context" role="note">
        <span aria-hidden="true">
          <Icone nome="livro" tamanho={15} />
        </span>
        <p>
          <strong>Extrato somente leitura.</strong> Cada linha é um registro auditável. Estoque Local, Reservado e
          em Trânsito pertence à organização inteira — por isso não existe filtro por conta Mercado Livre.
        </p>
      </div>

      <div className="sb-mov-workspace">
      <Panel
        title="Ledger de estoque"
        subtitle={`${window.label} · ${recorteLabel(filters)}`}
        aside={
          <>
            <FilterMenu
              rotulo={`Tipo: ${filters.movementType === null ? "Todos" : movementTypeLabel(filters.movementType)}`}
              opcoes={[
                {
                  href: buildMovementHref(filters, { movementType: null }),
                  ativo: filters.movementType === null,
                  label: "Todos os tipos",
                },
                ...MOVEMENT_TYPES.map((type) => ({
                  href: buildMovementHref(filters, { movementType: type }),
                  ativo: filters.movementType === type,
                  label: movementTypeLabel(type),
                })),
              ]}
            />
            <FilterMenu
              rotulo={`Local: ${filters.locationKind === null ? "Todos" : locationKindLabel(filters.locationKind)}`}
              opcoes={[
                {
                  href: buildMovementHref(filters, { locationKind: null }),
                  ativo: filters.locationKind === null,
                  label: "Todos os locais",
                },
                ...LOCATION_KINDS.map((kind) => ({
                  href: buildMovementHref(filters, { locationKind: kind }),
                  ativo: filters.locationKind === kind,
                  label: locationKindLabel(kind),
                })),
              ]}
            />
            <FilterMenu
              rotulo={`Origem: ${filters.sourceType === null ? "Todas" : movementSourceLabel(filters.sourceType, null)}`}
              opcoes={[
                {
                  href: buildMovementHref(filters, { sourceType: null }),
                  ativo: filters.sourceType === null,
                  label: "Todas as origens",
                },
                ...SOURCE_TYPES.map((source) => ({
                  href: buildMovementHref(filters, { sourceType: source }),
                  ativo: filters.sourceType === source,
                  label: movementSourceLabel(source, null),
                })),
              ]}
            />
          </>
        }
      >
        <form method="get" action="/estoque/movimentacoes" className="sb-mov-toolbar" aria-label="Filtrar movimentações">
          {filters.movementType !== null && <input type="hidden" name="tipo" value={filters.movementType} />}
          {filters.locationKind !== null && <input type="hidden" name="local" value={filters.locationKind} />}
          {filters.sourceType !== null && <input type="hidden" name="origem" value={filters.sourceType} />}

          <label className="sb-mov-field sb-mov-search">
            <span>Buscar</span>
            <span className="sb-mov-input-shell">
              <Icone nome="lupa" tamanho={14} />
              <input
                className="sb-input"
                type="search"
                name="busca"
                defaultValue={filters.search ?? ""}
                placeholder="SKU, título ou referência exata"
              />
            </span>
          </label>

          <div className="sb-mov-dates" role="group" aria-label="Período do movimento">
            <label className="sb-mov-field">
              <span>De</span>
              <input className="sb-input" type="date" name="de" defaultValue={filters.dateFrom ?? undefined} />
            </label>
            <label className="sb-mov-field">
              <span>Até</span>
              <input className="sb-input" type="date" name="ate" defaultValue={filters.dateTo ?? undefined} />
            </label>
          </div>

          <div className="sb-mov-toolbar-actions">
            {filtrosAtivos > 0 && (
              <Link className="sb-button" href="/estoque/movimentacoes">
                Limpar {filtrosAtivos === 1 ? "filtro" : `${String(filtrosAtivos)} filtros`}
                <CarregandoSeODemorar />
              </Link>
            )}
            <button className="sb-button sb-button-primary" type="submit">
              Aplicar filtros
            </button>
          </div>
        </form>

        {resumo.error !== null && ledger.error === null && (
          <p className="sb-mov-message sb-mov-message-warning" role="status">
            Os indicadores estão temporariamente indisponíveis, mas o histórico abaixo foi carregado normalmente.
          </p>
        )}

        {ledger.error !== null && (
          <div className="sb-mov-error" role="alert">
            <span className="sb-mov-error-icon" aria-hidden="true">
              <Icone nome="pulso" tamanho={18} />
            </span>
            <div>
              <strong>Não foi possível carregar o histórico agora.</strong>
              <p>Seus filtros foram preservados. Tente novamente; nenhum dado de estoque foi alterado.</p>
            </div>
            <Link className="sb-button" href={buildMovementHref(filters, { page: filters.page })}>
              Tentar novamente
              <CarregandoSeODemorar />
            </Link>
          </div>
        )}

        {ledger.error === null && rows.length === 0 && (
          <div className="sb-mov-empty">
            <span className="sb-mov-empty-icon" aria-hidden="true">
              <Icone nome="setas" tamanho={20} />
            </span>
            <div>
              <strong>{paginaForaDoRecorte ? "Esta página não faz mais parte do recorte." : "Nenhum movimento encontrado."}</strong>
              <p>
                {paginaForaDoRecorte
                  ? "O histórico pode ter mudado desde a última visita. Volte à primeira página para continuar."
                  : filtrosAtivos > 0
                    ? "Revise ou remova os filtros para ampliar a busca."
                    : "Assim que o estoque receber uma entrada, saída ou ajuste, o registro aparecerá aqui."}
              </p>
            </div>
            {(filtrosAtivos > 0 || paginaForaDoRecorte) && (
              <Link
                className="sb-button"
                href={paginaForaDoRecorte ? buildMovementHref(filters, { page: 1 }) : "/estoque/movimentacoes"}
              >
                {paginaForaDoRecorte ? "Ir para a primeira página" : "Limpar filtros"}
                <CarregandoSeODemorar />
              </Link>
            )}
          </div>
        )}

        {ledger.error === null && rows.length > 0 && (
          <div className="sb-mov-table-wrap">
            <table className="sb-table sb-mov-table">
              <thead>
                <tr>
                  <th>Data e hora</th>
                  <th>Produto / SKU</th>
                  <th>Movimento</th>
                  <th>Local</th>
                  <th className="sb-num">Quantidade</th>
                  <th>Origem</th>
                  <th>Referência</th>
                  <th>Motivo</th>
                  <th>Responsável</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const entrada = row.qty_delta > 0;
                  const responsavel = row.created_by_name ?? "Sistema";
                  const motivo = row.reason ?? (row.created_by_name === null ? "Rotina automática" : "Sem motivo informado");

                  return (
                    <tr key={row.id}>
                      <td data-label="Data e hora">
                        <time dateTime={row.occurred_at}>{formatDateTime(row.occurred_at)}</time>
                      </td>
                      <td data-label="Produto / SKU" className="sb-mov-product">
                        <Link className="sb-entity" href={`/skus/${row.sku_id}`}>
                          {row.sku_title ?? row.sku}
                        </Link>
                        <span className="sb-mono">{row.sku}</span>
                      </td>
                      <td data-label="Movimento">
                        <strong className="sb-mov-primary-text">{movementTypeLabel(row.movement_type)}</strong>
                      </td>
                      <td data-label="Local">
                        <span className="sb-mov-location">{locationKindLabel(row.location_kind)}</span>
                      </td>
                      <td data-label="Quantidade" className="sb-num">
                        <span className={`sb-mov-delta ${entrada ? "sb-mov-delta-positive" : "sb-mov-delta-negative"}`}>
                          <span className="sb-sr-only">{entrada ? "Entrada: " : "Saída: "}</span>
                          {formatQtyDelta(row.qty_delta)}
                        </span>
                      </td>
                      <td data-label="Origem">
                        <strong className="sb-mov-primary-text">{movementSourceLabel(row.source_type, null)}</strong>
                      </td>
                      <td data-label="Referência">
                        {/* Pedido de compra e nota fiscal abrem a tela deles (lote 3 do pente fino). */}
                        {movementSourceHref(row.source_type, row.source_id) === null ? (
                          <span className="sb-mov-secondary-text sb-mono sb-mov-reference">{row.source_id ?? "Sem referência externa"}</span>
                        ) : (
                          <Link
                            className="sb-mov-secondary-text sb-mono sb-mov-reference"
                            href={movementSourceHref(row.source_type, row.source_id) ?? ""}
                          >
                            {row.source_type === "PURCHASE_ORDER" ? "Abrir pedido de compra" : "Abrir nota fiscal"}
                          </Link>
                        )}
                      </td>
                      <td data-label="Motivo">
                        <span className="sb-mov-secondary-text sb-mov-reason">{motivo}</span>
                      </td>
                      <td data-label="Responsável">
                        <strong className="sb-mov-primary-text">{responsavel}</strong>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {ledger.error === null && rows.length > 0 && window.totalPages > 1 && (
          <nav className="sb-mov-pagination" aria-label="Paginação do histórico">
            <span>
              Página <strong>{formatCount(filters.page)}</strong> de {formatCount(window.totalPages)}
            </span>
            <div>
              {filters.page > 1 && (
                <Link className="sb-button" href={buildMovementHref(filters, { page: filters.page - 1 })} rel="prev">
                  ‹ Anterior
                  <CarregandoSeODemorar />
                </Link>
              )}
              {filters.page < window.totalPages && (
                <Link className="sb-button" href={buildMovementHref(filters, { page: filters.page + 1 })} rel="next">
                  Próxima ›
                  <CarregandoSeODemorar />
                </Link>
              )}
            </div>
          </nav>
        )}
      </Panel>
      </div>
    </Shell>
  );
}
