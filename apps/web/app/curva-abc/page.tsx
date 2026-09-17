import Link from "next/link";
import type { ReactNode } from "react";

import { FilterMenu } from "../../components/filter-menu";
import { FilterGroup, FilterPill } from "../../components/filter-pill";
import { PageTitle } from "../../components/page-title";
import { Panel } from "../../components/panel";
import { Shell } from "../../components/shell";
import {
  ABC_CRITERIA,
  ABC_PERIODS,
  PAGE_SIZE,
  buildAbcHref,
  resolveAbcFilters,
  summarizeAbcWindow,
} from "../../lib/abc-filters";
import { formatCount, formatCurrency, formatPercent } from "../../lib/format";
import { createClient } from "../../lib/supabase/server";
import { currentMembership } from "../../lib/request-membership";

export const metadata = { title: "Curva ABC — Speed Bikers Gestão" };

// A sessão vem de cookie: pré-renderizar no build mostraria dado de outra
// pessoa. Mesmo raciocínio das demais telas.
export const dynamic = "force-dynamic";

/**
 * Curva ABC com escopo, critério e período (Fase 5C, D-140).
 *
 * **O escopo de conta RECALCULA a curva, não a filtra.** Medido em
 * 2026-08-29: 743 SKUs vendem em mais de uma conta e 476 (64,1%) mudam de
 * classe conforme a conta. O parâmetro entra nas duas pontas do RPC —
 * conjunto e denominador —, nunca em JavaScript.
 *
 * 🔴 **A versão anterior mostrava 1.000 de 1.492 SKUs e somava as classes em
 * JavaScript sobre esse resultado truncado**: exibia classe C = 298 quando o
 * real era 790, e o filtro "sem Full" via 699 de 1.180. Sétima ocorrência da
 * classe de D-131, e a primeira em que o estrago foi uma ESTATÍSTICA e não
 * uma lista. As contagens agora são janela sobre o conjunto filtrado inteiro,
 * calculadas no Postgres.
 */
interface AbcRow {
  sku_id: string;
  sku: string;
  title: string | null;
  metric_value: number;
  metric_share: number;
  cumulative_share: number;
  abc_class: "A" | "B" | "C";
  full_quantity: number;
  total_count: number;
  class_a_count: number;
  class_a_value: number;
  class_b_value: number;
  class_c_value: number;
  /** Quantos SKUs do recorte estão SEM Full — pareia com o filtro que já existe. */
  without_full_count: number;
  class_b_count: number;
  class_c_count: number;
}

export default async function CurvaAbcPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const query = await searchParams;
  const supabase = await createClient();

  // As contas não dependem da organização: a RLS já as restringe, e o `select`
  // de `organization_members` existe para o guarda de "sem organização", não
  // para filtrar. As duas leituras saem juntas desde D-195; a RPC abaixo
  // continua depois, porque ela SIM precisa da conta escolhida.
  const [membership, accountsResult] = await Promise.all([
    currentMembership(),
    supabase.from("ml_accounts").select("id, slug, label").order("label"),
  ]);

  const organizationId = membership.organizationId;

  if (organizationId === null) {
    return (
      <Shell>
        <h1 style={{ margin: "0 0 var(--sb-space-3)", fontSize: "1.375rem" }}>Curva ABC</h1>
        <p style={{ color: "var(--sb-text-soft)" }}>Sua conta não está associada a nenhuma organização.</p>
      </Shell>
    );
  }

  const filters = resolveAbcFilters(query);

  const accounts = accountsResult.data ?? [];
  // Slug desconhecido cai em "consolidado" em silêncio — mesmo tratamento de
  // `/vendas` e `/anuncios`.
  const selectedAccount = accounts.find((a) => a.slug === filters.accountSlug) ?? null;

  const now = new Date();
  const dateTo = now.toISOString().slice(0, 10);
  const dateFrom = new Date(now.getTime() - (filters.days - 1) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  // A lista de marcas vem do BANCO, nunca das linhas da página (D-194):
  // montá-la a partir do resultado paginado fazia 10 das 19 marcas nunca
  // aparecerem no filtro. Sai no MESMO round trip da curva — as duas dependem
  // da organização e não dependem uma da outra.
  const [curva, brandsResult] = await Promise.all([
    supabase.rpc("get_sku_abc_curve", {
    p_organization_id: organizationId,
    p_date_from: dateFrom,
    p_date_to: dateTo,
    p_ml_account_id: selectedAccount?.id ?? null,
    p_criterion: filters.criterion.key,
    p_only_without_full: filters.onlyWithoutFull,
    // Entra na MESMA ponta que a conta: a curva é recalculada DENTRO da marca
    // (participações somam 100% dela), não é a fatia da marca na curva global.
    p_supplier_brand: filters.brand,
    p_limit: PAGE_SIZE,
    p_offset: (filters.page - 1) * PAGE_SIZE,
    }),
    supabase.rpc("get_supplier_brands", { p_organization_id: organizationId }),
  ]);

  const { data, error } = curva;
  // Falha da lista não fica muda: filtro vazio por erro é indistinguível de
  // "não há marca", e a tela mostraria o segundo dizendo o primeiro (D-194).
  const brands = (brandsResult.data ?? []).map((r) => r.supplier_brand);

  const rows = (data ?? []) as AbcRow[];
  const first = rows[0];
  const totalCount = first?.total_count ?? 0;
  const windowInfo = summarizeAbcWindow(filters.page, totalCount, rows.length);
  const formatValue = filters.criterion.format === "currency" ? formatCurrency : formatCount;
  const totalDasClasses =
    first === undefined ? 0 : first.class_a_value + first.class_b_value + first.class_c_value;

  // Conta e marca são recortes independentes e componíveis, e a frase precisa
  // dizer isso numa só oração: "recalculada dentro de X, recalculada dentro de
  // Y" saiu da primeira versão e lia mal na tela. "Recalculada" é a palavra
  // certa e não é enfeite — as classes A/B/C são refeitas DENTRO do recorte,
  // não é a fatia do recorte na curva global.
  const recortes = [selectedAccount?.label, filters.brand].filter((r): r is string => r !== undefined && r !== null);
  const escopo = recortes.length === 0 ? ", consolidado" : `, recalculada dentro de ${recortes.join(" e ")}`;
  const filtrosAtivos =
    filters.accountSlug !== null ||
    filters.brand !== null ||
    filters.criterion.key !== ABC_CRITERIA[0].key ||
    filters.days !== 90 ||
    filters.onlyWithoutFull;

  return (
    <Shell>
      {/* Sobrancelha e título do frame `Abc` (ESTOQUE / CLASSIFICAÇÃO). */}
      <PageTitle
        eyebrow="ESTOQUE / CLASSIFICAÇÃO"
        title="Curva ABC"
        subtitle="Onde receita, volume e disponibilidade se concentram."
        aside={
          <>
            <FilterMenu
              rotulo={selectedAccount?.label ?? "Todas as contas"}
              opcoes={[
                {
                  href: buildAbcHref(filters, { accountSlug: null }),
                  label: "Todas as contas",
                  ativo: selectedAccount === null,
                },
                ...accounts.map((account) => ({
                  href: buildAbcHref(filters, { accountSlug: account.slug }),
                  label: account.label,
                  ativo: selectedAccount?.id === account.id,
                })),
              ]}
            />
            <FilterMenu
              rotulo={filters.brand ?? "Todas as marcas"}
              opcoes={[
                {
                  href: buildAbcHref(filters, { brand: null }),
                  label: "Todas as marcas",
                  ativo: filters.brand === null,
                },
                ...brands.map((brand) => ({
                  href: buildAbcHref(filters, { brand }),
                  label: brand,
                  ativo: filters.brand === brand,
                })),
              ]}
            />
          </>
        }
      />

      <section className="sb-abc-controls" aria-label="Configuração da análise">
        <div className="sb-abc-controls-head">
          <div>
            <span className="sb-eyebrow">ANÁLISE ATUAL</span>
            <p>
              Últimos {filters.days} dias, por {filters.criterion.label.toLowerCase()}
              {escopo}.
            </p>
          </div>
          {filtrosAtivos && (
            <Link className="sb-button" href="/curva-abc">
              Limpar filtros
            </Link>
          )}
        </div>

        <div className="sb-abc-filter-grid">
          <FilterGroup label="Critério">
            {ABC_CRITERIA.map((criterion) => (
              <FilterPill
                key={criterion.key}
                href={buildAbcHref(filters, { criterion })}
                active={filters.criterion.key === criterion.key}
              >
                {criterion.label}
              </FilterPill>
            ))}
          </FilterGroup>

          <FilterGroup label="Período">
            {ABC_PERIODS.map((days) => (
              <FilterPill key={days} href={buildAbcHref(filters, { days })} active={filters.days === days}>
                {days} dias
              </FilterPill>
            ))}
          </FilterGroup>
        </div>
      </section>

      {/*
        Os três cartões de classe do frame `Abc`. O valor por classe vem de
        JANELA no banco, calculada antes do limit (D-251): somar em JavaScript
        daria o valor da PÁGINA, não do recorte — a classe de defeito que
        D-131 mediu.

        A participação é razão entre dois totais já fornecidos, não agregação:
        `classe ÷ (A+B+C)`.
      */}
      {first !== undefined && (
        <div className="sb-abc-cards">
          {(
            [
              { classe: "A", limite: "até 80%", valor: first.class_a_value, skus: first.class_a_count },
              { classe: "B", limite: "de 80% a 95%", valor: first.class_b_value, skus: first.class_b_count },
              { classe: "C", limite: "acima de 95%", valor: first.class_c_value, skus: first.class_c_count },
            ] as const
          ).map((c) => (
              <section
                className={`sb-abc-card sb-abc-card-${c.classe.toLowerCase()}`}
                key={c.classe}
                aria-label={`Classe ${c.classe}`}
              >
                <div className="sb-abc-card-head">
                  <span>CLASSE {c.classe}</span>
                  <small>{c.limite} do acumulado</small>
                </div>
                <strong>{formatValue(c.valor)}</strong>
                <p>
                  {totalDasClasses === 0
                    ? "sem base para percentual"
                    : `${formatPercent(c.valor / totalDasClasses)} do resultado`}
                </p>
                <div className="sb-abc-card-foot">
                  <b>
                    {formatCount(c.skus)} {c.skus === 1 ? "SKU" : "SKUs"}
                  </b>
                  <small>nesta classe</small>
                </div>
                <i
                  aria-hidden="true"
                  style={{ width: totalDasClasses === 0 ? "0%" : `${String((c.valor / totalDasClasses) * 100)}%` }}
                />
              </section>
            ))}
        </div>
      )}

      {/*
        Os filtros rápidos do frame, e a diferença entre eles é a fatia toda.

        "Sem Full" PERTENCE à curva: `p_only_without_full` já existe, e o
        número da barra ao lado é o mesmo conjunto.

        "Em ruptura" e "Baixa cobertura" NÃO pertencem: são estados
        operacionais com dono (`get_purchase_suggestions`, D-150), com a
        política de reposição inteira por trás. Reimplementá-los aqui seria a
        segunda definição de "ruptura" na mesma base, e as duas telas
        discordariam no primeiro ajuste de política. Viram LINK para a tela
        dona, que sabe responder (D-224).
      */}
      {first !== undefined && (
        <div className="sb-abc-bars">
          <section className="sb-abc-full-card">
            <div className="sb-abc-insight-head">
              <div>
                <span className="sb-eyebrow">DISPONIBILIDADE FULL</span>
                <b>Sem estoque no Full</b>
              </div>
              <strong>{formatCount(first.without_full_count)}</strong>
            </div>
            <div className="sb-abc-progress" aria-hidden="true">
              <i style={{ width: `${String(Math.min(100, Math.round((first.without_full_count / Math.max(first.total_count, 1)) * 100)))}%` }} />
            </div>
            <p>
              {formatCount(first.without_full_count)} de {formatCount(first.total_count)} SKUs do recorte.
            </p>
            <FilterPill
              href={buildAbcHref(filters, { onlyWithoutFull: !filters.onlyWithoutFull })}
              active={filters.onlyWithoutFull}
            >
              {filters.onlyWithoutFull ? "Mostrando somente sem Full" : "Ver somente sem Full"}
            </FilterPill>
          </section>

          <section className="sb-note sb-abc-risk-card">
            <span>RISCO OPERACIONAL</span>
            <p>
              Ruptura e cobertura baixa seguem a política de reposição. Consulte a fila operacional para agir
              sobre esses estados.
            </p>
            <div className="sb-abc-risk-links">
              <Link href="/reposicao?estado=RUPTURA">Ver rupturas →</Link>
              <Link href="/reposicao?estado=COBERTURA_BAIXA">Ver cobertura baixa →</Link>
            </div>
          </section>
        </div>
      )}

      {error !== null && (
        <p role="alert" style={{ color: "var(--sb-danger)" }}>
          Não foi possível carregar: {error.message}
        </p>
      )}

      {error === null && (
        <Panel
          title={filters.onlyWithoutFull ? "SKUs sem estoque no Full" : "SKUs por participação"}
          subtitle={windowInfo.label}
          aside={
            <span className="sb-abc-table-context">
              {filters.criterion.label} · {filters.days} dias
            </span>
          }
        >
          {rows.length === 0 && <p className="sb-empty">Nenhum SKU com venda no período e escopo escolhidos.</p>}

          {rows.length > 0 && (
            <div className="sb-abc-table-wrap">
              <table className="sb-table">
                <thead>
                  <tr>
                    <th>Classe</th>
                    <th>Produto / SKU</th>
                    <th className="sb-num">{filters.criterion.label}</th>
                    <th className="sb-num">% do total</th>
                    <th className="sb-num">% acumulado</th>
                    <th className="sb-num">Estoque Full</th>
                  </tr>
                </thead>

                <tbody>
                  {rows.map((row) => (
                    <tr key={row.sku_id}>
                      <td>
                        <span className={`sb-abc-class sb-abc-class-${row.abc_class.toLowerCase()}`}>
                          {row.abc_class}
                        </span>
                      </td>
                      <td>
                        <Link className="sb-entity" href={`/skus/${row.sku_id}`}>
                          {row.title ?? "Produto sem título"}
                        </Link>
                        <div className="sb-mono">{row.sku}</div>
                      </td>
                      <td className="sb-num">{formatValue(row.metric_value)}</td>
                      <td className="sb-num">
                        <div className="sb-abc-share">
                          <i aria-hidden="true" style={{ width: `${String(Math.min(100, row.metric_share))}%` }} />
                          <span>{row.metric_share}%</span>
                        </div>
                      </td>
                      <td className="sb-num">{row.cumulative_share}%</td>
                      <td className="sb-num">
                        {row.full_quantity === 0 ? (
                          <span className="sb-abc-full-empty">Sem Full</span>
                        ) : (
                          formatCount(row.full_quantity)
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      )}

      {error === null && windowInfo.totalPages > 1 && (
        <nav className="sb-abc-pagination" aria-label="Paginação da Curva ABC">
          {filters.page > 1 && (
            <FilterPill href={buildAbcHref(filters, { page: filters.page - 1 })} active={false}>
              ← Anterior
            </FilterPill>
          )}
          <span>Página {filters.page} de {windowInfo.totalPages}</span>
          {filters.page < windowInfo.totalPages && (
            <FilterPill href={buildAbcHref(filters, { page: filters.page + 1 })} active={false}>
              Próxima →
            </FilterPill>
          )}
        </nav>
      )}
    </Shell>
  );
}
