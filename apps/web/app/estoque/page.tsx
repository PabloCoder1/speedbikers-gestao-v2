import { computeUsableStock } from "@sb/domain";
import Link from "next/link";
import type { ReactNode } from "react";

import { FilterMenu } from "../../components/filter-menu";
import { FilterPill } from "../../components/filter-pill";
import { Icone } from "../../components/icons";
import { KpiStrip, type KpiCellData } from "../../components/kpi-strip";
import { PageTitle } from "../../components/page-title";
import { Panel } from "../../components/panel";
import { Shell } from "../../components/shell";
import { formatBusinessDate, formatCount, formatCurrency } from "../../lib/format";
import { PAGE_SIZE, buildStockHref, resolveStockFilters, summarizeStockWindow } from "../../lib/stock-filters";
import { createClient } from "../../lib/supabase/server";
import { currentMembership } from "../../lib/request-membership";

export const metadata = { title: "Estoque — Speed Bikers Gestão" };

// A sessão vem de cookie: pré-renderizar no build mostraria dado de outra
// pessoa. Mesmo raciocínio de apps/web/app/compras/page.tsx.
export const dynamic = "force-dynamic";


interface StockRow {
  sku_id: string;
  sku: string;
  title: string | null;
  local_quantity: number;
  reservado: number;
  transito: number;
  full_quantity: number | null;
  supplier_brand: string | null;
  category: string | null;
  purchase_cost: number | null;
  created_at: string;
  last_movement_at: string | null;
  stock_is_virtual: boolean;
  stock_is_virtual_set_at: string | null;
  total_count: number;
}

function monogramaDeProduto(title: string | null, sku: string): string {
  const titulo = title?.trim();
  const fonte = titulo === undefined || titulo === "" ? sku : titulo;
  const palavras = fonte
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  return palavras
    .slice(0, 2)
    .map((palavra) => palavra[0])
    .join("")
    .toUpperCase();
}

/**
 * Estoque enriquecido (Fase 5C, D-139).
 *
 * A tela mostrava quatro colunas enquanto marca, categoria, custo, Full e
 * datas já existiam no banco e ninguém as lia — era literalmente o que o
 * `docs/PRODUCT_REQUIREMENTS.md` apontava.
 *
 * **Duas ausências são deliberadas e valem mais que as colunas novas:**
 *
 * 1. **Não há coluna Origem.** `is_imported` e `origin_code` carregam a origem
 *    FISCAL (preenchida por quem emite a nota), não a rota de compra. Medido:
 *    `is_imported` diz que 187 dos 228 SKUs NAVETEC são nacionais, contra a
 *    regra do negócio. Mostrar "Nacional" ali seria a tela afirmando com
 *    confiança algo falso (D-129, D-139).
 * 2. **Não há Valor de estoque.** `docs/METRICS.md` 5C.4 o bloqueia, e a razão
 *    mudou de lugar: a questão do sentinela foi respondida (D-127) e a
 *    ferramenta existe (D-133), mas **1.089 SKUs têm a assinatura sentinela e
 *    ZERO estão classificados**. Multiplicar quantidade por custo hoje daria
 *    número inflado com cara de preciso.
 */
export default async function EstoquePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const query = await searchParams;
  const supabase = await createClient();

  const membership = await currentMembership();
  const organizationId = membership.organizationId;

  if (organizationId === null) {
    return (
      <Shell>
        <h1 style={{ margin: "0 0 var(--sb-space-3)", fontSize: "1.375rem" }}>Estoque</h1>
        <p style={{ color: "var(--sb-text-soft)" }}>Sua conta não está associada a nenhuma organização.</p>
      </Shell>
    );
  }

  const filters = resolveStockFilters(query);

  // As duas leituras são INDEPENDENTES — em `Promise.all` elas custam uma ida
  // ao banco, não duas em fila. Sequenciais eram um waterfall sem motivo: a
  // lista de marcas não depende da página do pivô.
  const [balances, brandsResult, resumo] = await Promise.all([
    // O pivô, os filtros, a ordenação e a contagem vêm do Postgres (D-131,
    // enriquecido em D-139). A tela nunca lê a tabela inteira.
    supabase.rpc("get_stock_balances", {
      p_organization_id: organizationId,
      p_supplier_brand: filters.brand,
      p_category: filters.category,
      p_search: filters.search,
      p_only_negative: filters.onlyNegative,
      p_limit: PAGE_SIZE,
      p_offset: (filters.page - 1) * PAGE_SIZE,
    }),
    // Marcas disponíveis para o filtro, vindas do que existe de verdade —
    // lista fixa envelheceria no primeiro preenchimento novo em `/produtos`.
    //
    // D-194: a agregação é do BANCO. A forma anterior lia `supplier_brand` de
    // todos os SKUs e deduzia as distintas com `new Set(...)` — 3.550 linhas
    // para produzir 19 valores, e o teto de 1.000 do PostgREST (D-131) cortava
    // a lista: **10 das 19 marcas nunca apareciam no filtro**.
    supabase.rpc("get_supplier_brands", { p_organization_id: organizationId }),
    // A faixa recebe os MESMOS filtros da tabela: uma faixa que ignora o
    // recorte de baixo faz cabeçalho e corpo falarem de conjuntos diferentes
    // na mesma tela (o defeito que D-236 mediu em /cobertura).
    supabase
      .rpc("get_stock_summary", {
        p_organization_id: organizationId,
        p_supplier_brand: filters.brand,
        p_category: filters.category,
        p_search: filters.search,
        p_only_negative: filters.onlyNegative,
      })
      .maybeSingle(),
  ]);

  // A falha da lista de marcas não fica muda: filtro vazio por erro é o mesmo
  // silêncio que D-131 combate — a tela diria "nenhuma marca" sem distinguir
  // catálogo sem marca de leitura quebrada.
  const error = balances.error ?? brandsResult.error;

  const rows = (balances.data ?? []) as StockRow[];
  const totalCount = rows[0]?.total_count ?? 0;
  const windowInfo = summarizeStockWindow(filters.page, totalCount, rows.length);

  const brands = (brandsResult.data ?? [])
    .map((r) => r.supplier_brand)
    .filter((brand): brand is string => typeof brand === "string" && brand.trim() !== "");

  // Lote 1 do pente fino (18/09): a falha do resumo era lida como zero -- a
  // faixa dizia "Reservado 0" e "Full 0" como medida. Falhou, a célula diz
  // "—" e a tela avisa, como /estoque/movimentacoes já fazia (D-067).
  const resumoFalhou = resumo.error !== null;
  const total = resumoFalhou ? null : resumo.data;

  /*
    A faixa do frame `Inventory` tem SEIS células. A conferência célula a
    célula contra o que o sistema mede (D-249) reprovou três delas, e cada
    recusa aqui tem número medido atrás:

    * "Unidades local" e "Valor estimado" somariam SENTINELA. O saldo do ERP
      não é contagem física (D-127), e a classificação nunca foi feita —
      `stock_is_virtual_set_at` é nulo em 3.554 de 3.554 SKUs, então o
      `false` do banco é o DEFAULT da coluna, não o julgamento de ninguém.
      Cru, o Dev responde 5,8 milhões de unidades e R$ 376 milhões. A RPC soma
      só o que um humano confirmou como físico; hoje isso é zero, e a célula
      diz POR QUE é zero, com o caminho para resolver.
    * "Em trânsito" não é saldo zero: é ausência estrutural. Não existe UM
      `stock_movement` de TRANSITO — o tipo de local nunca foi escrito.

    As outras três (Reservado, Full, Em ruptura) têm dado real.
  */
  const naoClassificados = total?.skus_nao_classificados ?? 0;
  const confirmados = total?.skus_confirmados_fisicos ?? 0;

  /*
    "Ninguém classificou" e "classificaram, e todos são sentinela" são razões
    DIFERENTES para o mesmo travessão, e a primeira versão desta tela dizia
    "nenhum SKU classificado ainda — 0 pendentes" para o segundo caso: uma
    frase que se contradiz na própria linha. Só apareceu com a página aberta.
  */
  const razaoDaRecusa =
    naoClassificados > 0
      ? `${formatCount(naoClassificados)} SKU(s) ainda sem classificação de estoque virtual`
      : "todo o recorte tem saldo sentinela — nenhum SKU confirmado como físico";

  const celulas: readonly KpiCellData[] = [
    {
      label: "Unidades local",
      formula: "Soma de inventory_balances LOCAL, restrita aos SKUs confirmados como estoque físico.",
      value: confirmados === 0 ? "—" : formatCount(total?.unidades_local ?? 0),
      previous: null,
      ressalva: confirmados === 0 ? razaoDaRecusa : `sobre ${formatCount(confirmados)} SKU(s) confirmados como físicos`,
      href: "/produtos?estado=pendente&sinal=sentinela",
      tom: confirmados === 0 ? "atencao" : "neutro",
    },
    {
      label: "Reservado",
      formula: "Soma de inventory_balances RESERVADO — vem da reconciliação contra o UpSeller.",
      value: formatCount(total?.reservado ?? 0),
      previous: null,
      tom: "atencao",
    },
    {
      label: "Em trânsito",
      formula: "Soma de inventory_balances TRANSITO, alimentada pelo ciclo de pedidos de compra.",
      // Zero e ausência não se confundem (D-067): aqui o tipo de local nunca
      // foi escrito, então "0" seria afirmar que nada está a caminho.
      value: total?.transito_tem_registro === true ? formatCount(total.transito) : "—",
      previous: null,
      // `exactOptionalPropertyTypes`: a chave some de vez quando não há ressalva,
      // em vez de existir valendo `undefined`.
      ...(total?.transito_tem_registro === true ? {} : { ressalva: "nenhum movimento de trânsito registrado" }),
      tom: "neutro" as const,
    },
    {
      label: "Full",
      formula: "Última captura por bucket de variação, janela de 3 dias — a definição canônica de D-173/D-192.",
      value: formatCount(total?.full_quantity ?? 0),
      previous: null,
      href: "/full",
      tom: "ok",
    },
    {
      label: "Valor estimado",
      formula: "Soma de LOCAL x custo de compra, restrita aos SKUs confirmados como estoque físico.",
      value: confirmados === 0 ? "—" : formatCurrency(total?.valor_estimado ?? 0),
      previous: null,
      ressalva: confirmados === 0 ? razaoDaRecusa : `sobre ${formatCount(confirmados)} SKU(s) confirmados`,
      href: "/produtos?estado=pendente&sinal=sentinela",
      tom: confirmados === 0 ? "atencao" : "neutro",
    },
    {
      label: "SKUs no recorte",
      formula: "Quantos SKUs a tabela abaixo alcança com os filtros atuais.",
      value: formatCount(total?.skus_no_recorte ?? 0),
      previous: null,
      tom: "neutro",
    },
  ];

  const celulasExibidas: readonly KpiCellData[] = resumoFalhou
    ? celulas.map((celula) => ({ ...celula, value: "—", ressalva: "resumo indisponível agora" }))
    : celulas;

  const rotuloMarca = filters.brand ?? "Todas as marcas";
  const filtrosAtivos = [
    filters.brand === null ? null : `marca ${filters.brand}`,
    filters.category === null ? null : `categoria ${filters.category}`,
    filters.onlyNegative ? "somente saldo negativo" : null,
    filters.search === null ? null : `busca “${filters.search}”`,
  ].filter((item): item is string => item !== null);

  const contextoDoRecorte = filtrosAtivos.length === 0 ? "Todos os produtos" : filtrosAtivos.join(" · ");

  return (
    <Shell>
      {/* Sobrancelha e título do frame `Inventory` (ESTOQUE / POSIÇÃO). */}
      <PageTitle
        eyebrow="ESTOQUE / POSIÇÃO"
        title="Visão de estoque"
        subtitle={
          <>
            Saldos locais auditáveis, reservas e Full em uma única leitura — sem misturar as autoridades de cada
            estoque.
          </>
        }
        aside={
          <>
            <Link className="sb-button" href="/estoque/movimentacoes">
              <Icone nome="setas" tamanho={14} />
              Movimentações
            </Link>
            <Link className="sb-button sb-button-primary" href="/reposicao">
              <Icone nome="carrinho" tamanho={14} />
              Planejar reposição
            </Link>
          </>
        }
      />

      <KpiStrip ancora cells={celulasExibidas} />

      {resumoFalhou && (
        <p role="alert" className="sb-adjust-alert">
          Não foi possível carregar o resumo do estoque agora — os totais acima ficam em branco. A tabela abaixo
          continua valendo.
        </p>
      )}

      <section className="sb-stock-insights" aria-label="Leitura rápida do estoque">
        <article className="sb-stock-insight sb-stock-insight-primary">
          <span className="sb-stock-insight-icon" aria-hidden="true"><Icone nome="tendencia" tamanho={16} /></span>
          <div>
            <span className="sb-stock-insight-label">Cobertura física</span>
            <strong>{resumoFalhou ? "—" : formatCount(confirmados)} SKUs confirmados</strong>
            <p>Base confiável para valor e saldo local.</p>
          </div>
        </article>
        <article className="sb-stock-insight sb-stock-insight-warning">
          <span className="sb-stock-insight-icon" aria-hidden="true"><Icone nome="pulso" tamanho={16} /></span>
          <div>
            <span className="sb-stock-insight-label">Atenção operacional</span>
            <strong>{resumoFalhou ? "—" : formatCount(naoClassificados)} aguardando classificação</strong>
            <p>Resolva a pendência para liberar métricas físicas.</p>
          </div>
        </article>
        <article className="sb-stock-insight sb-stock-insight-neutral">
          <span className="sb-stock-insight-icon" aria-hidden="true"><Icone nome="caixa" tamanho={16} /></span>
          <div>
            <span className="sb-stock-insight-label">Recorte atual</span>
            <strong>{formatCount(total?.skus_no_recorte ?? totalCount)} SKUs monitorados</strong>
            <p>{windowInfo.label} · dados atualizados pelo ledger.</p>
          </div>
        </article>
      </section>

      <div className="sb-stock-workspace">
        <Panel
          title="Estoque por produto"
          subtitle={`${windowInfo.label} · ${contextoDoRecorte}`}
          aside={
            <>
              <FilterMenu
                rotulo={rotuloMarca}
                opcoes={[
                  {
                    href: buildStockHref(filters, { brand: null }),
                    ativo: filters.brand === null,
                    label: "Todas as marcas",
                  },
                  ...brands.map((brand) => ({
                    href: buildStockHref(filters, { brand }),
                    ativo: filters.brand === brand,
                    label: brand,
                  })),
                ]}
              />
              <FilterPill
                href={buildStockHref(filters, { onlyNegative: !filters.onlyNegative })}
                active={filters.onlyNegative}
                tone="danger"
              >
                Saldo negativo
              </FilterPill>
            </>
          }
        >
          <div className="sb-stock-toolbar">
            <form method="get" action="/estoque" className="sb-stock-search">
              {/* Hidden por dimensão ativa: GET nativo só envia campos do form (D-136). */}
              {filters.brand !== null && <input type="hidden" name="marca" value={filters.brand} />}
              {filters.category !== null && <input type="hidden" name="categoria" value={filters.category} />}
              {filters.onlyNegative && <input type="hidden" name="negativo" value="1" />}
              <span className="sb-stock-search-field">
                <Icone nome="lupa" tamanho={15} />
                <input
                  className="sb-input"
                  type="search"
                  name="busca"
                  defaultValue={filters.search ?? ""}
                  placeholder="Buscar por SKU ou nome do produto"
                  aria-label="Buscar por SKU ou nome do produto"
                />
              </span>
              <button type="submit" className="sb-button">
                Buscar
              </button>
              {filtrosAtivos.length > 0 && (
                <Link className="sb-text-button" href="/estoque">
                  Limpar filtros
                </Link>
              )}
            </form>

            <p>
              <strong>Como ler:</strong> local é o saldo físico; reservado já está comprometido; Full pertence ao
              Mercado Livre e nunca é somado silenciosamente ao local.
            </p>
          </div>

          {error !== null && (
            <p role="alert" className="sb-stock-message sb-stock-message-error">
              Não foi possível carregar: {error.message}
            </p>
          )}

          {error === null && (
            <>
              {rows.length === 0 && <p className="sb-empty">Nenhum SKU corresponde a estes filtros.</p>}
              {rows.length > 0 && (
                <div className="sb-stock-table-wrap">
                  <table className="sb-table sb-stock-table">
            <thead>
              <tr>
                {/*
                  Ordem do frame `Inventory`, menos duas colunas que o sistema
                  NÃO observa — ver o desvio registrado em DESIGN_IMPLEMENTATION:
                  `Fornecedor` (não existe vínculo fornecedor→SKU, D-174) e
                  `Origem` (`is_imported` é origem FISCAL e contradiz a rota de
                  compra em 187 dos 228 SKUs NAVETEC, D-129/D-139).

                  `Aproveitável` não está no frame e FICA: é métrica canônica
                  (D-146, METRICS §5D), e métrica canônica vence o Figma pela
                  própria regra de conflito do documento.
                */}
                <th>Produto</th>
                <th>Marca</th>
                <th>Categoria</th>
                <th className="sb-num">Custo</th>
                <th className="sb-num">Local</th>
                <th className="sb-num">Reservado</th>
                <th className="sb-num">Em trânsito</th>
                <th className="sb-num">Full</th>
                <th className="sb-num">Aproveitável</th>
                <th>Último movimento</th>
                <th className="sb-num">Ações</th>
              </tr>
            </thead>

            <tbody>
              {rows.map((row) => (
                <tr key={row.sku_id}>
                  <td>
                    <span className="sb-product-cell sb-stock-product">
                      <span className="sb-product-thumb" aria-hidden="true">
                        {monogramaDeProduto(row.title, row.sku)}
                      </span>
                      <span className="sb-stock-product-copy">
                        <Link className="sb-entity" href={`/skus/${row.sku_id}`}>
                          {row.title ?? "Produto sem título"}
                        </Link>
                        <span className="sb-mono">{row.sku}</span>
                      </span>
                    </span>
                  </td>
                  {/*
                    Marca VAZIA é estado legítimo, não falta de dado: só 36%
                    estão preenchidos, e o resto espera preenchimento humano em
                    `/produtos` (D-129/D-133). Travessão, nunca "—" alarmante.
                  */}
                  <td>{row.supplier_brand ?? "—"}</td>
                  <td>{row.category ?? "—"}</td>
                  <td className="sb-num">{formatCurrency(row.purchase_cost)}</td>
                  <td className="sb-num">
                    <span className={row.local_quantity < 0 ? "sb-stock-value sb-stock-value-danger" : "sb-stock-value"}>
                      {formatCount(row.local_quantity)}
                    </span>
                    {row.stock_is_virtual && (
                      <span className="sb-status sb-stock-virtual">virtual</span>
                    )}
                  </td>
                  <td className="sb-num">{formatCount(row.reservado)}</td>
                  <td className="sb-num">{formatCount(row.transito)}</td>
                  {/* Full nulo = SKU sem nada no Full, diferente de zero medido. */}
                  <td className="sb-num">{row.full_quantity === null ? "—" : formatCount(row.full_quantity)}</td>
                  <td className="sb-num">
                    {(() => {
                      /*
                        Aproveitável = LOCAL + FULL + TRÂNSITO, RESERVADO fora
                        (já comprometido; o Disponível do UpSeller já o
                        exclui). Definição normativa em docs/METRICS.md §5D
                        (D-146). SKU virtual recusa o total — somar sentinela
                        com Full real seria lixo com aparência de precisão.
                      */
                      const usable = computeUsableStock({
                        localQuantity: row.local_quantity,
                        fullQuantity: row.full_quantity ?? 0,
                        transitQuantity: row.transito,
                        reservedQuantity: row.reservado,
                        stockIsVirtual: row.stock_is_virtual,
                      });

                      if (usable.total === null) {
                        return (
                          <span style={{ color: "var(--sb-text-soft)", fontSize: "0.75rem" }}>
                            estoque virtual
                          </span>
                        );
                      }

                      return (
                        <span
                          title={`local ${String(usable.components.local)} + full ${String(usable.components.full)} + trânsito ${String(usable.components.transit)} (reservado ${String(usable.components.reservedExcluded)} fica fora)`}
                          style={{ fontWeight: 600 }}
                        >
                          {formatCount(usable.total)}
                        </span>
                      );
                    })()}
                  </td>
                  <td>
                    {row.last_movement_at === null ? "—" : formatBusinessDate(row.last_movement_at.slice(0, 10))}
                  </td>
                  <td>
                    <span className="sb-stock-row-actions">
                      <Link className="sb-button sb-button-sm" href={`/skus/${row.sku_id}`}>
                        Ver SKU
                      </Link>
                      <Link className="sb-text-button" href={`/estoque/${row.sku_id}/ajuste`}>
                        Ajustar
                      </Link>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </Panel>

        {error === null && windowInfo.totalPages > 1 && (
          <nav className="sb-stock-pagination" aria-label="Paginação do estoque">
            {filters.page > 1 && (
              <FilterPill href={buildStockHref(filters, { page: filters.page - 1 })} active={false}>
                ← Anterior
              </FilterPill>
            )}
            <span style={{ color: "var(--sb-text-soft)" }}>
              Página {filters.page} de {windowInfo.totalPages}
            </span>
            {filters.page < windowInfo.totalPages && (
              <FilterPill href={buildStockHref(filters, { page: filters.page + 1 })} active={false}>
                Próxima →
              </FilterPill>
            )}
          </nav>
        )}
      </div>
    </Shell>
  );
}
