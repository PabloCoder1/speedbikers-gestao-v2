import Link from "next/link";
import type { ReactNode } from "react";

import { FilterMenu } from "../../components/filter-menu";
import { KpiStrip, type KpiCellData } from "../../components/kpi-strip";
import { PageTitle } from "../../components/page-title";
import { Panel } from "../../components/panel";
import { Shell } from "../../components/shell";
import { formatCount, formatCurrency, formatDateTime } from "../../lib/format";
import {
  PAGE_SIZE,
  buildLinkIntegrityHref,
  resolveLinkIntegrityFilters,
  summarizeLinkIntegrityWindow,
  toRpcArgs,
} from "../../lib/link-integrity-filters";
import { currentMembership } from "../../lib/membership";
import { createClient } from "../../lib/supabase/server";
import { CandidateRow } from "./candidate-row";
import { ManualLinkForm } from "./manual-link-form";

export const metadata = { title: "Integridade de Catálogo — Speed Bikers Gestão" };

// A sessão vem de cookie: pré-renderizar no build mostraria dado de outra
// pessoa. Ver apps/web/app/importacoes/page.tsx para o mesmo raciocínio.
export const dynamic = "force-dynamic";

/**
 * Integridade de Catálogo (`/vinculacoes`), pelo frame `ProcessScreen
 * type="links"` — D21, D-259.
 *
 * **O frame REENQUADRA a tela, e é a mudança de composição da fatia.** Ela era
 * "Central de Vinculações": uma fila de `link_candidates`. O frame faz dela uma
 * visão de INTEGRIDADE sobre ANÚNCIOS — cinco células e uma tabela de anúncios
 * por estado de vínculo, em que "candidato" é um estado entre outros, não o
 * assunto. Os dados concordam com o frame: no Dev são 5.089 anúncios, 863 sem
 * vínculo e **0 candidatos**.
 *
 * **É a primeira tela de processo com faixa de KPIs desenhada** — `nfe`,
 * `suppliers` e `purchases` não têm cartão nenhum (D-253/D-255/D-256).
 *
 * ## As duas fontes de "vendeu", e por que a tela mostra as duas
 *
 * `get_link_integrity` conta venda a partir de `order_items` — fonte
 * INDEPENDENTE do pipeline de métricas, e por isso a mais confiável. A tabela
 * desta tela sai de `get_listings_dashboard`, que conta a partir de
 * `daily_listing_metrics`. No Dev as duas divergem: **349 contra 337**.
 *
 * Os 12 de diferença são anúncios que geraram pedido e o pipeline de métricas
 * não conhece — exatamente o que esta tela existe para expor.
 *
 * A célula usa o número da TABELA, para que clicar nela mostre as linhas que
 * ela promete (D-242) e cabeçalho e corpo não discordem (D-236). O número
 * independente aparece **declarado ao lado**, nomeando a diferença: mostrar só
 * um dos dois seria omissão.
 */

interface ListingRow {
  listing_id: string;
  item_id: string;
  title: string;
  account_label: string;
  sku: string | null;
  sku_id: string | null;
  link_state: string;
  units_sold: number;
  price: number;
  total_count: number;
}

const ESTADOS = [
  { chave: "todos", label: "Todos os estados" },
  { chave: "vinculados", label: "Vinculados" },
  { chave: "sem-vinculo", label: "Sem vínculo" },
] as const;

const VENDAS = [
  { chave: "todos", label: "Vendeu ou não" },
  { chave: "vendeu", label: "Vendeu em 30 dias" },
  { chave: "nao-vendeu", label: "Não vendeu" },
] as const;

const JANELA_DIAS = 30;

function estadoDoVinculo(estado: string): { rotulo: string; cor: string } {
  if (estado === "linked") return { rotulo: "Vinculado", cor: "var(--sb-success)" };
  if (estado === "linked_variation") return { rotulo: "Por variação", cor: "var(--sb-secondary)" };

  return { rotulo: "Sem vínculo", cor: "var(--sb-danger-ink)" };
}

export default async function VinculacoesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const supabase = await createClient();
  const query = await searchParams;
  const filters = resolveLinkIntegrityFilters(query);

  const membership = await currentMembership(supabase);
  const organizationId = membership.organizationId;

  if (organizationId === null) {
    return (
      <Shell>
        <PageTitle
          eyebrow="ESTOQUE / VINCULAÇÕES"
          title="Integridade de Catálogo"
          subtitle="Garantia de que os anúncios estão corretamente ligados aos SKUs internos do sistema."
        />
        <p className="sb-empty">Sua conta não está associada a nenhuma organização.</p>
      </Shell>
    );
  }

  const hoje = new Date();
  const desde = new Date(hoje.getTime() - JANELA_DIAS * 24 * 60 * 60 * 1000);
  const janela = {
    p_organization_id: organizationId,
    p_date_from: desde.toISOString().slice(0, 10),
    p_date_to: hoje.toISOString().slice(0, 10),
  };

  const recorte = toRpcArgs(filters);

  /*
    Cada célula lê o `total_count` da MESMA função que monta a lista, com
    `p_limit => 1` e o predicado dela — o padrão de D-242. Uma contagem própria
    seria um segundo dono do número (D-224), e é assim que faixa e tabela
    começam a discordar.

    São muitas idas, e juntas custam uma (D-185): o custo é POR CHAMADA e quase
    independente do que ela faz.
  */
  const contagem = (extra: Record<string, string>) =>
    supabase.rpc("get_listings_dashboard", { ...janela, p_limit: 1, p_offset: 0, ...extra });

  const [lista, cTotal, cVinculados, cSemVinculo, cVendidosSemVinculo, integridade, candidatos, contas, manuais] =
    await Promise.all([
      supabase.rpc("get_listings_dashboard", {
        ...janela,
        ...recorte,
        p_limit: PAGE_SIZE,
        p_offset: (filters.page - 1) * PAGE_SIZE,
        ...(filters.search !== null ? { p_search: filters.search } : {}),
      }),
      contagem({ p_link_state: "all" }),
      contagem({ p_link_state: "linked" }),
      contagem({ p_link_state: "unlinked" }),
      contagem({ p_link_state: "unlinked", p_sold: "with" }),
      // A fonte INDEPENDENTE (pedidos). Não alimenta as células — alimenta a
      // ressalva que declara a divergência.
      supabase.rpc("get_link_integrity", { p_organization_id: organizationId, p_days: JANELA_DIAS }),
      supabase
        .from("link_candidates")
        .select("id, sku_key, ref_kind, item_id, variation_id, user_product_id, created_at, ml_accounts(label)")
        .eq("status", "OPEN")
        .order("created_at", { ascending: true })
        .limit(200),
      supabase.from("ml_accounts").select("id, label").order("label"),
      supabase
        .from("sku_listing_links")
        .select("id, item_id, variation_id, confirmed_at, skus(sku), ml_accounts(label)")
        .eq("source", "MANUAL")
        .order("confirmed_at", { ascending: false, nullsFirst: false })
        .limit(10),
    ]);

  const rows = (lista.data ?? []) as unknown as ListingRow[];
  const totalDoRecorte = rows[0]?.total_count ?? 0;
  const window = summarizeLinkIntegrityWindow(filters.page, totalDoRecorte, rows.length);

  const conta = (r: { data: unknown }): number =>
    ((r.data ?? []) as { total_count?: number }[])[0]?.total_count ?? 0;

  const totalAnuncios = conta(cTotal);
  const vendidosSemVinculoTabela = conta(cVendidosSemVinculo);

  const porPedidos = ((integridade.data ?? []) as { vendidos_sem_vinculo: number; receita_sem_vinculo: number }[]);
  const vendidosPorPedido = porPedidos.reduce((soma, l) => soma + l.vendidos_sem_vinculo, 0);
  const receitaSemVinculo = porPedidos.reduce((soma, l) => soma + l.receita_sem_vinculo, 0);
  const divergencia = vendidosPorPedido - vendidosSemVinculoTabela;

  const abertos = candidatos.data ?? [];

  const celulas: readonly KpiCellData[] = [
    {
      label: "Anúncios sincronizados",
      formula: "Todos os anúncios do catálogo do Mercado Livre conhecidos pela sincronização.",
      value: formatCount(totalAnuncios),
      previous: null,
      href: buildLinkIntegrityHref(filters, { state: "todos", sold: "todos", page: 1 }),
      tom: "neutro",
    },
    {
      label: "Vinculados",
      formula: "Anúncios ligados a um SKU — por vínculo direto OU por variação.",
      value: formatCount(conta(cVinculados)),
      previous: null,
      href: buildLinkIntegrityHref(filters, { state: "vinculados", sold: "todos", page: 1 }),
      tom: "ok",
    },
    {
      label: "Sem vínculo",
      /*
        A ressalva não é decoração: contar `sku_id is null` daria mais que o
        dobro, porque o vínculo por VARIAÇÃO tem `sku_id` nulo e está ligado.
      */
      formula: "link_state = 'unlinked'. NÃO é sku_id nulo: o vínculo por variação também tem sku_id nulo (D-122).",
      value: formatCount(conta(cSemVinculo)),
      previous: null,
      ressalva: "vínculo por variação conta como vinculado",
      href: buildLinkIntegrityHref(filters, { state: "sem-vinculo", sold: "todos", page: 1 }),
      tom: "atencao",
    },
    {
      label: "Vendidos sem vínculo",
      formula: `Anúncios sem vínculo que venderam nos últimos ${String(JANELA_DIAS)} dias — receita entrando sem baixa de estoque.`,
      value: formatCount(vendidosSemVinculoTabela),
      previous: null,
      // A divergência entre as duas fontes é DECLARADA, não escondida.
      ...(divergencia > 0
        ? {
            ressalva: `${formatCount(divergencia)} a mais pela fonte independente (pedidos): ${formatCount(vendidosPorPedido)}`,
          }
        : {}),
      href: buildLinkIntegrityHref(filters, { state: "sem-vinculo", sold: "vendeu", page: 1 }),
      tom: "perigo",
    },
    {
      label: "Candidatos pendentes",
      formula: "Linhas da importação do ERP que citaram um SKU inexistente no catálogo e esperam resolução humana.",
      value: formatCount(abertos.length),
      previous: null,
      // Zero cru leria como "não há trabalho", que é afirmação diferente de
      // "toda linha resolveu" (a lição dos cartões de D-250).
      ...(abertos.length === 0 ? { ressalva: "nenhuma linha do ERP ficou sem SKU" } : {}),
      tom: "neutro",
    },
  ];

  const rotuloEstado = ESTADOS.find((e) => e.chave === filters.state)?.label ?? "Estado";
  const rotuloVenda = VENDAS.find((v) => v.chave === filters.sold)?.label ?? "Venda";

  return (
    <Shell>
      {/* `OpsHeader` do frame: sobrancelha, título e a linha de apoio. */}
      <PageTitle
        eyebrow="ESTOQUE / VINCULAÇÕES"
        title="Integridade de Catálogo"
        subtitle="Garantia de que os anúncios estão corretamente ligados aos SKUs internos do sistema."
      />

      <KpiStrip cells={celulas} ancora />

      {receitaSemVinculo > 0 && (
        <p style={{ margin: "0 0 var(--sb-space-3)", fontSize: "0.75rem", color: "var(--sb-danger-ink)" }}>
          <strong>{formatCurrency(receitaSemVinculo)}</strong> de receita em {String(JANELA_DIAS)} dias veio de
          anúncios sem vínculo — venda registrada sem baixa de estoque no SKU correspondente. O valor vem dos
          pedidos, não do pipeline de métricas.
        </p>
      )}

      {lista.error !== null && (
        <p role="alert" style={{ color: "var(--sb-danger)" }}>
          Não foi possível carregar os anúncios: {lista.error.message}
        </p>
      )}

      {lista.error === null && (
        <Panel
          title="Tabela de Vinculações"
          aside={
            <>
              <span style={{ fontSize: "0.6875rem", color: "var(--sb-text-soft)", whiteSpace: "nowrap" }}>
                {window.label}
              </span>

              {/* A busca do frame ("Buscar MLB ou SKU..."), como GET nativo. */}
              <form method="get" style={{ display: "flex", gap: "0.375rem", alignItems: "center" }}>
                {filters.state !== "todos" && <input type="hidden" name="estado" value={filters.state} />}
                {filters.sold !== "todos" && <input type="hidden" name="venda" value={filters.sold} />}
                <input
                  className="sb-input"
                  type="search"
                  name="busca"
                  defaultValue={filters.search ?? ""}
                  placeholder="Buscar MLB ou SKU…"
                  aria-label="Buscar por MLB, título ou SKU"
                  style={{ minWidth: "11rem" }}
                />
              </form>

              <FilterMenu
                rotulo={rotuloEstado}
                opcoes={ESTADOS.map((e) => ({
                  href: buildLinkIntegrityHref(filters, { state: e.chave }),
                  label: e.label,
                  ativo: filters.state === e.chave,
                }))}
              />

              <FilterMenu
                rotulo={rotuloVenda}
                opcoes={VENDAS.map((v) => ({
                  href: buildLinkIntegrityHref(filters, { sold: v.chave }),
                  label: v.label,
                  ativo: filters.sold === v.chave,
                }))}
              />
            </>
          }
        >
          {rows.length === 0 && <p className="sb-empty">{window.label}</p>}

          {rows.length > 0 && (
            <div style={{ overflowX: "auto" }}>
              <table className="sb-table">
                <thead>
                  <tr>
                    <th>Anúncio</th>
                    <th>MLB</th>
                    <th>Conta</th>
                    <th>SKU no sistema</th>
                    <th>Estado</th>
                    <th className="sb-num">Vendas ({JANELA_DIAS}d)</th>
                    <th className="sb-num">Preço</th>
                  </tr>
                </thead>

                <tbody>
                  {rows.map((row) => {
                    const estado = estadoDoVinculo(row.link_state);

                    return (
                      <tr key={row.listing_id}>
                        <td>
                          <Link className="sb-entity" href={`/anuncios/${row.item_id}`}>
                            {row.title}
                          </Link>
                        </td>
                        <td className="sb-mono">{row.item_id}</td>
                        <td>{row.account_label}</td>
                        {/*
                          Vínculo por variação NÃO tem `sku_id`, e mesmo assim
                          está ligado — mostrar "—" aqui sem o estado ao lado
                          faria a coluna contradizer a seguinte.
                        */}
                        <td className="sb-mono">
                          {row.sku_id === null ? "—" : <Link href={`/skus/${row.sku_id}`}>{row.sku}</Link>}
                        </td>
                        <td style={{ color: estado.cor, fontWeight: 600 }}>{estado.rotulo}</td>
                        <td
                          className="sb-num"
                          style={{
                            color:
                              row.units_sold > 0 && row.link_state === "unlinked"
                                ? "var(--sb-danger-ink)"
                                : undefined,
                            fontWeight: row.units_sold > 0 && row.link_state === "unlinked" ? 600 : undefined,
                          }}
                        >
                          {formatCount(row.units_sold)}
                        </td>
                        <td className="sb-num">{formatCurrency(row.price)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      )}

      {lista.error === null && window.totalPages > 1 && (
        <div style={{ display: "flex", gap: "var(--sb-space-2)", marginTop: "var(--sb-space-3)" }}>
          {filters.page > 1 && (
            <Link className="sb-button" href={buildLinkIntegrityHref(filters, { page: filters.page - 1 })}>
              ← Anterior
            </Link>
          )}
          {filters.page < window.totalPages && (
            <Link className="sb-button" href={buildLinkIntegrityHref(filters, { page: filters.page + 1 })}>
              Próxima →
            </Link>
          )}
        </div>
      )}

      {/*
        O que o frame NÃO mostra e a tela real tem: a fila de candidatos do ERP
        e a vinculação manual. Não são incompatíveis com o desenho — são
        funcionalidade que ele não desenhou. O Design Contract manda remover
        conteúdo incompatível, não funcionalidade ausente do frame; e o dead
        code pass é de frontend sem consumidor, o que não é o caso.
      */}
      <div style={{ marginTop: "var(--sb-space-5)" }}>
        <Panel
          title="Candidatos da importação do ERP"
          subtitle="Linhas da planilha que citaram um SKU inexistente no catálogo. Match exato resolve sozinho numa importação futura; esta fila é a confirmação humana do resto."
        >
          {candidatos.error !== null && (
            <p role="alert" style={{ color: "var(--sb-danger)", padding: "var(--sb-space-3)" }}>
              Não foi possível carregar os candidatos: {candidatos.error.message}
            </p>
          )}

          {candidatos.error === null && abertos.length === 0 && (
            <p className="sb-empty">
              Nenhum candidato pendente — toda linha do ERP encontrou o seu SKU. As linhas de outros canais de
              venda não entram nesta fila por desenho.
            </p>
          )}

          {candidatos.error === null && abertos.length > 0 && (
            <div style={{ overflowX: "auto" }}>
              <table className="sb-table">
                <thead>
                  <tr>
                    <th>SKU informado</th>
                    <th>Conta</th>
                    <th>Referência</th>
                    <th>Desde</th>
                    <th>Ação</th>
                  </tr>
                </thead>
                <tbody>
                  {abertos.map((c) => (
                    <tr key={c.id}>
                      <td className="sb-mono">{c.sku_key}</td>
                      <td>{c.ml_accounts.label}</td>
                      <td className="sb-mono">
                        {c.item_id ?? c.user_product_id ?? "—"}
                        {c.variation_id !== null && ` · var ${c.variation_id}`}
                      </td>
                      <td>{formatDateTime(c.created_at)}</td>
                      {/* `CandidateRow` é a CÉLULA de ação, não a linha. */}
                      <td>
                        <CandidateRow candidateId={c.id} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>

      <div style={{ marginTop: "var(--sb-space-4)" }}>
        <ManualLinkForm
          accounts={contas.data ?? []}
          {...(typeof query.conta === "string" ? { initialAccountId: query.conta } : {})}
          {...(typeof query.item === "string" ? { initialItemId: query.item } : {})}
        />

        {/*
          Leitura de volta: sem isto o operador vincula e não vê nada mudar em
          lugar nenhum — o vínculo criado sai da fila de candidatos e não
          aparece em parte alguma.
        */}
        {(manuais.data ?? []).length > 0 && (
          <p style={{ margin: "var(--sb-space-2) 0 0", fontSize: "0.6875rem", color: "var(--sb-text-soft)" }}>
            Últimos vínculos manuais:{" "}
            {(manuais.data ?? [])
              .map((m) => `${m.skus.sku} → ${m.item_id ?? "—"}`)
              .join(" · ")}
          </p>
        )}
      </div>
    </Shell>
  );
}
