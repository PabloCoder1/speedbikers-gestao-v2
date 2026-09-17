import Link from "next/link";
import { Suspense, type ReactNode } from "react";

import { FilterMenu } from "../../components/filter-menu";
import { KpiStrip, type KpiCellData } from "../../components/kpi-strip";
import { PageTitle } from "../../components/page-title";
import { Panel } from "../../components/panel";
import { Shell } from "../../components/shell";
import { formatCount, formatCurrency } from "../../lib/format";
import {
  PAGE_SIZE,
  buildLinkIntegrityHref,
  resolveLinkIntegrityFilters,
  summarizeLinkIntegrityWindow,
  toRpcArgs,
  type LinkIntegrityFilters,
} from "../../lib/link-integrity-filters";
import { currentMembership } from "../../lib/request-membership";
import { createClient } from "../../lib/supabase/server";

import { FilaCandidatos, TabelaVinculos, VincularPorMlb, type LinhaAnuncio } from "./vinculos-interativos";

export const metadata = { title: "Integridade de Catálogo — Speed Bikers Gestão" };

// A sessão vem de cookie: pré-renderizar no build mostraria dado de outra
// pessoa. Ver apps/web/app/importacoes/page.tsx para o mesmo raciocínio.
export const dynamic = "force-dynamic";

/**
 * Integridade de Catálogo (`/vinculacoes`), pelo frame `ProcessScreen
 * type="links"` — D21, D-259; refeita em D-374.
 *
 * ## D-374: vincular num popup, e a página que não espera a leitura lenta
 *
 * O dono: "sempre que clicamos para vincular algo a tela leva-nos lá para
 * baixo". O "Vincular" de cada linha era um link para esta mesma página com
 * `#vincular-a-mao`: refazia as oito leituras e rolava até o formulário no fim.
 * Agora o vínculo é um popup sobre a tabela (`vincular-dialog.tsx`) que:
 * - abre com a SUGESTÃO do SKU tirada dos pedidos do anúncio (`seller_sku`
 *   casado com o catálogo — 505 dos 867 sem vínculo no Dev);
 * - grava sem refazer a página na mesma resposta, muda a linha na hora e
 *   recarrega os números em segundo plano;
 * - oferece "Vincular e próximo".
 *
 * **O que segurava a página.** `get_link_integrity` mede ~250 ms quente e
 * **2,6 s a frio** (Dev, authenticated), e a página inteira esperava por ela —
 * mas ela só alimenta a comparação entre contas e a ressalva de divergência.
 * Foi para `ComparacaoContas`, dentro de `Suspense`: a tabela chega com as
 * leituras de `get_listings_dashboard` (~120–150 ms cada, em paralelo) e a
 * comparação chega depois.
 *
 * ## As duas fontes de "vendeu", e por que a tela mostra as duas
 *
 * `get_link_integrity` conta venda a partir de `order_items` — fonte
 * INDEPENDENTE do pipeline de métricas. A tabela sai de
 * `get_listings_dashboard`, que conta a partir de `daily_listing_metrics`. As
 * células usam o número da TABELA, para que clicar nelas mostre as linhas que
 * prometem (D-242); o número independente aparece declarado no painel de
 * comparação, nomeando a diferença.
 */

/** Uma linha de `get_link_integrity` — a fonte INDEPENDENTE, por conta. */
interface LinkIntegrityRow {
  ml_account_id: string;
  account_label: string;
  listings_total: number;
  com_vinculo: number;
  sem_vinculo: number;
  pct_vinculado: number;
  candidatos_abertos: number;
  vendidos_sem_vinculo: number;
  receita_sem_vinculo: number;
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

export default async function VinculacoesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const supabase = await createClient();
  const query = await searchParams;
  const filters = resolveLinkIntegrityFilters(query);

  /*
    As contas vêm ANTES do resto, e não junto: a lista e as contagens precisam
    do id da conta escolhida, e a URL traz o SLUG. Mesma ordem de `/anuncios`
    (D-242) — duas idas em série, não seis.
  */
  const [membership, contas] = await Promise.all([
    currentMembership(),
    // Só as contas que o usuário alcança — a RLS de `ml_accounts` decide.
    supabase.from("ml_accounts").select("id, slug, label").order("label"),
  ]);

  const organizationId = membership.organizationId;
  const accounts = contas.data ?? [];
  // Slug desconhecido cai em "todas as contas" em silêncio, como em `/anuncios`.
  const contaEscolhida = accounts.find((a) => a.slug === filters.accountSlug) ?? null;

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
    // A conta entra na JANELA: vale para a lista E para as contagens (D-236).
    p_ml_account_id: contaEscolhida?.id ?? null,
  };

  /*
    Cada célula lê o `total_count` da MESMA função que monta a lista, com
    `p_limit => 1` e o predicado dela — o padrão de D-242. Juntas custam uma ida
    (D-185).
  */
  const contagem = (extra: Record<string, string>) =>
    supabase.rpc("get_listings_dashboard", { ...janela, p_limit: 1, p_offset: 0, ...extra });

  // As duas leituras por tabela seguem o MESMO recorte de conta.
  const candidatosBase = supabase
    .from("link_candidates")
    .select("id, sku_key, ref_kind, item_id, variation_id, user_product_id, created_at, ml_accounts(label)")
    .eq("status", "OPEN");

  const manuaisBase = supabase
    .from("sku_listing_links")
    .select("id, item_id, variation_id, confirmed_at, skus(sku), ml_accounts(label)")
    .eq("source", "MANUAL");

  const naConta = <T extends { eq: (coluna: "ml_account_id", valor: string) => T }>(consulta: T): T =>
    contaEscolhida === null ? consulta : consulta.eq("ml_account_id", contaEscolhida.id);

  const [lista, cTotal, cVinculados, cSemVinculo, cVendidosSemVinculo, candidatos, manuais] = await Promise.all([
    supabase.rpc("get_listings_dashboard", {
      ...janela,
      ...toRpcArgs(filters),
      p_limit: PAGE_SIZE,
      p_offset: (filters.page - 1) * PAGE_SIZE,
      ...(filters.search !== null ? { p_search: filters.search } : {}),
    }),
    contagem({ p_link_state: "all" }),
    contagem({ p_link_state: "linked" }),
    contagem({ p_link_state: "unlinked" }),
    contagem({ p_link_state: "unlinked", p_sold: "with" }),
    naConta(candidatosBase).order("created_at", { ascending: true }).limit(200),
    naConta(manuaisBase).order("confirmed_at", { ascending: false, nullsFirst: false }).limit(8),
  ]);

  const rows = lista.data ?? [];
  const totalDoRecorte = rows[0]?.total_count ?? 0;
  const window = summarizeLinkIntegrityWindow(filters.page, totalDoRecorte, rows.length);

  const conta = (r: { data: unknown }): number =>
    ((r.data ?? []) as { total_count?: number }[])[0]?.total_count ?? 0;

  const abertos = candidatos.data ?? [];

  const linhas: LinhaAnuncio[] = rows.map((r) => ({
    listingId: r.listing_id,
    itemId: r.item_id,
    title: r.title,
    mlAccountId: r.ml_account_id,
    accountLabel: r.account_label,
    // O tipo gerado diz `string`, mas vínculo por variação tem `sku_id` nulo e
    // está ligado (D-122): a leitura assume o nulo que o banco devolve.
    sku: (r as { sku: string | null }).sku,
    skuId: (r as { sku_id: string | null }).sku_id,
    linkState: r.link_state,
    unitsSold: r.units_sold,
    price: r.price,
    fullQuantity: r.full_quantity,
  }));

  const contasOpcoes = accounts.map((a) => ({ id: a.id, label: a.label }));

  const celulas: readonly KpiCellData[] = [
    {
      label: "Anúncios sincronizados",
      formula: "Todos os anúncios do catálogo do Mercado Livre conhecidos pela sincronização.",
      value: formatCount(conta(cTotal)),
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
      // Contar `sku_id is null` daria mais que o dobro: o vínculo por variação tem `sku_id` nulo.
      formula: "link_state = 'unlinked'. NÃO é sku_id nulo: o vínculo por variação também tem sku_id nulo (D-122).",
      value: formatCount(conta(cSemVinculo)),
      previous: null,
      ressalva: "vínculo por variação conta como vinculado",
      href: buildLinkIntegrityHref(filters, { state: "sem-vinculo", sold: "todos", page: 1 }),
      tom: "atencao",
    },
    {
      label: "Vendidos sem vínculo",
      formula: `Anúncios sem vínculo que venderam nos últimos ${String(JANELA_DIAS)} dias — receita entrando sem baixa de estoque. A fonte independente (pedidos) aparece na comparação entre contas.`,
      value: formatCount(conta(cVendidosSemVinculo)),
      previous: null,
      href: buildLinkIntegrityHref(filters, { state: "sem-vinculo", sold: "vendeu", page: 1 }),
      tom: "perigo",
    },
    {
      label: "Candidatos pendentes",
      formula: "Linhas da importação do ERP que citaram um SKU inexistente no catálogo e esperam resolução humana.",
      value: formatCount(abertos.length),
      previous: null,
      // Zero cru leria como "não há trabalho" (a lição dos cartões de D-250).
      ...(abertos.length === 0 ? { ressalva: "nenhuma linha do ERP ficou sem SKU" } : {}),
      tom: "neutro",
    },
  ];

  const rotuloEstado = ESTADOS.find((e) => e.chave === filters.state)?.label ?? "Estado";
  const rotuloVenda = VENDAS.find((v) => v.chave === filters.sold)?.label ?? "Venda";
  const rotuloConta = contaEscolhida?.label ?? "Todas as contas";
  const filtroAtivo =
    filters.state !== "todos" || filters.sold !== "todos" || filters.accountSlug !== null || filters.search !== null;

  return (
    <Shell>
      <PageTitle
        eyebrow="ESTOQUE / VINCULAÇÕES"
        title="Integridade de Catálogo"
        subtitle="Garantia de que os anúncios estão corretamente ligados aos SKUs internos do sistema."
        aside={<VincularPorMlb contas={contasOpcoes} />}
      />

      <KpiStrip cells={celulas} ancora />

      {lista.error !== null && (
        <p role="alert" className="sb-note sb-note-perigo">
          Não foi possível carregar os anúncios: {lista.error.message}
        </p>
      )}

      {lista.error === null && (
        <Panel
          title="Tabela de Vinculações"
          subtitle={
            <>
              {window.label} Clique em <b>Vincular</b> para escolher o SKU sem sair da tabela — o popup já traz a
              sugestão dos pedidos do anúncio.
            </>
          }
          aside={
            <>
              {/* A busca do frame ("Buscar MLB ou SKU..."), como GET nativo. */}
              <form method="get" className="sb-vnc-busca-form" role="search">
                {filters.state !== "todos" && <input type="hidden" name="estado" value={filters.state} />}
                {filters.sold !== "todos" && <input type="hidden" name="venda" value={filters.sold} />}
                {/* Sem isto, buscar descartaria a conta escolhida — o GET manda só o que está no formulário. */}
                {contaEscolhida !== null && <input type="hidden" name="conta" value={contaEscolhida.slug} />}
                <input
                  className="sb-input"
                  type="search"
                  name="busca"
                  defaultValue={filters.search ?? ""}
                  placeholder="Buscar MLB, título ou SKU…"
                  aria-label="Buscar por MLB, título ou SKU"
                />
              </form>

              <FilterMenu
                rotulo={rotuloConta}
                opcoes={[
                  { href: buildLinkIntegrityHref(filters, { accountSlug: null }), label: "Todas as contas", ativo: contaEscolhida === null },
                  ...accounts.map((a) => ({
                    href: buildLinkIntegrityHref(filters, { accountSlug: a.slug }),
                    label: a.label,
                    ativo: contaEscolhida?.id === a.id,
                  })),
                ]}
              />

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

              {filtroAtivo && (
                <Link className="sb-button" href="/vinculacoes">
                  Limpar
                </Link>
              )}
            </>
          }
        >
          {rows.length === 0 ? (
            <p className="sb-empty">{window.label}</p>
          ) : (
            <TabelaVinculos
              linhas={linhas}
              contas={contasOpcoes}
              abrirItem={typeof query.item === "string" ? query.item : null}
              janelaDias={JANELA_DIAS}
            />
          )}

          {window.totalPages > 1 && (
            <nav className="sb-vnc-paginas" aria-label="Páginas">
              {filters.page > 1 && (
                <Link className="sb-button" href={buildLinkIntegrityHref(filters, { page: filters.page - 1 })}>
                  ‹ Anterior
                </Link>
              )}
              <span>
                Página {filters.page} de {window.totalPages}
              </span>
              {filters.page < window.totalPages && (
                <Link className="sb-button" href={buildLinkIntegrityHref(filters, { page: filters.page + 1 })}>
                  Próxima ›
                </Link>
              )}
            </nav>
          )}
        </Panel>
      )}

      <div className="sb-vnc-duas">
        <Panel
          title="Candidatos da importação do ERP"
          subtitle="Linhas da planilha que citaram um SKU inexistente no catálogo. Match exato resolve sozinho numa importação futura; esta fila é a confirmação humana do resto."
        >
          {candidatos.error !== null ? (
            <p role="alert" className="sb-note sb-note-perigo">
              Não foi possível carregar os candidatos: {candidatos.error.message}
            </p>
          ) : (
            <FilaCandidatos
              contas={contasOpcoes}
              candidatos={abertos.map((c) => ({
                id: c.id,
                skuKey: c.sku_key,
                accountLabel: c.ml_accounts.label,
                referencia: `${c.item_id ?? c.user_product_id ?? "—"}${c.variation_id !== null ? ` · var ${c.variation_id}` : ""}`,
                createdAt: c.created_at,
              }))}
            />
          )}
        </Panel>

        {/* Leitura de volta: o operador vê o que acabou de vincular à mão. */}
        <Panel title="Últimos vínculos manuais" subtitle="Os mais recentes feitos por pessoas, nesta conta ou em todas.">
          {(manuais.data ?? []).length === 0 ? (
            <p className="sb-empty">Nenhum vínculo manual ainda.</p>
          ) : (
            <ul className="sb-vnc-recentes">
              {(manuais.data ?? []).map((m) => (
                <li key={m.id}>
                  <b className="sb-mono">{m.skus.sku}</b>
                  <span aria-hidden="true">←</span>
                  <Link className="sb-mono" href={`/anuncios/${m.item_id ?? ""}`}>
                    {m.item_id ?? "—"}
                  </Link>
                  {m.variation_id !== null && <small className="sb-mono">var {m.variation_id}</small>}
                  <small>{m.ml_accounts.label}</small>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      {/*
        A comparação chega DEPOIS da tabela: é a única parte que depende de
        `get_link_integrity` (2,6 s a frio no Dev).
      */}
      <Suspense
        fallback={
          <div className="sb-vnc-espera" role="status">
            <span className="sb-vnc-girando" aria-hidden="true" /> Carregando a comparação entre contas…
          </div>
        }
      >
        <ComparacaoContas
          organizationId={organizationId}
          contaEscolhidaId={contaEscolhida?.id ?? null}
          slugs={accounts.map((a) => [a.id, a.slug] as const)}
          filters={filters}
          vendidosSemVinculoTabela={conta(cVendidosSemVinculo)}
        />
      </Suspense>
    </Shell>
  );
}

/**
 * COMPARAÇÃO ENTRE CONTAS (D-128, restaurada em D-313), agora em streaming.
 *
 * NÃO obedece ao filtro de conta de propósito: comparar é o serviço deste
 * painel. A fonte é a INDEPENDENTE (`get_link_integrity`, a partir de
 * `order_items`), e por isso ele também declara a divergência com a tabela e a
 * receita que entrou sem vínculo.
 */
async function ComparacaoContas({
  organizationId,
  contaEscolhidaId,
  slugs,
  filters,
  vendidosSemVinculoTabela,
}: {
  organizationId: string;
  contaEscolhidaId: string | null;
  slugs: readonly (readonly [string, string])[];
  filters: LinkIntegrityFilters;
  vendidosSemVinculoTabela: number;
}): Promise<ReactNode> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_link_integrity", {
    p_organization_id: organizationId,
    p_days: JANELA_DIAS,
  });

  if (error !== null) {
    return (
      <p role="alert" className="sb-note sb-note-perigo">
        Não foi possível carregar a comparação entre contas: {error.message}
      </p>
    );
  }

  const porPedidos = data as LinkIntegrityRow[];

  if (porPedidos.length === 0) return null;

  const slugDaConta = new Map(slugs);
  const doRecorte = contaEscolhidaId === null ? porPedidos : porPedidos.filter((l) => l.ml_account_id === contaEscolhidaId);
  const vendidosPorPedido = doRecorte.reduce((soma, l) => soma + l.vendidos_sem_vinculo, 0);
  const receitaSemVinculo = doRecorte.reduce((soma, l) => soma + l.receita_sem_vinculo, 0);
  const divergencia = vendidosPorPedido - vendidosSemVinculoTabela;

  return (
    <Panel
      title="Comparação entre contas"
      subtitle={`Uma linha por conta, sem o filtro acima — comparar é o serviço deste painel. As colunas de catálogo usam a MESMA definição de vínculo da faixa (D-122); a última vem dos pedidos dos últimos ${String(JANELA_DIAS)} dias, a fonte independente. Clique numa conta para recortar a tabela.`}
    >
      {(receitaSemVinculo > 0 || divergencia > 0) && (
        <p className="sb-vnc-receita">
          {receitaSemVinculo > 0 && (
            <>
              <b>{formatCurrency(receitaSemVinculo)}</b> de receita em {String(JANELA_DIAS)} dias veio de anúncios sem
              vínculo — venda sem baixa de estoque no SKU.
            </>
          )}
          {divergencia > 0 && (
            <>
              {" "}
              Pelos pedidos são <b>{formatCount(vendidosPorPedido)}</b> anúncios vendidos sem vínculo,{" "}
              {formatCount(divergencia)} a mais que a tabela: o pipeline de métricas ainda não os conhece.
            </>
          )}
        </p>
      )}

      <div className="sb-vnc-tabela-rolagem">
        <table className="sb-table">
          <thead>
            <tr>
              <th>Conta</th>
              <th className="sb-num">Anúncios</th>
              <th className="sb-num">Vinculados</th>
              <th className="sb-num">Sem vínculo</th>
              <th className="sb-num">% vinculado</th>
              <th className="sb-num">Candidatos</th>
              <th className="sb-num">Vendidos sem vínculo</th>
            </tr>
          </thead>

          <tbody>
            {porPedidos.map((linha) => {
              const slug = slugDaConta.get(linha.ml_account_id) ?? null;
              const selecionada = contaEscolhidaId === linha.ml_account_id;

              return (
                <tr key={linha.ml_account_id} className={selecionada ? "sb-vnc-conta-foco" : undefined}>
                  <td>
                    {slug === null ? (
                      linha.account_label
                    ) : (
                      <Link
                        className="sb-entity"
                        aria-current={selecionada ? "true" : undefined}
                        href={buildLinkIntegrityHref(filters, { accountSlug: selecionada ? null : slug, page: 1 })}
                      >
                        {linha.account_label}
                      </Link>
                    )}
                    {selecionada && <small className="sb-vnc-mudo"> · em foco</small>}
                  </td>
                  <td className="sb-num">{formatCount(linha.listings_total)}</td>
                  <td className="sb-num">{formatCount(linha.com_vinculo)}</td>
                  <td className="sb-num">{formatCount(linha.sem_vinculo)}</td>
                  <td className="sb-num">
                    {/* Sem anúncio nenhum não há percentual — "0%" afirmaria que nenhum está vinculado. */}
                    {linha.listings_total === 0 ? (
                      "—"
                    ) : (
                      <span className="sb-vnc-pct">
                        <span className="sb-vnc-pct-barra" aria-hidden="true">
                          <i style={{ width: `${String(Math.min(100, Math.max(0, linha.pct_vinculado)))}%` }} />
                        </span>
                        {String(linha.pct_vinculado)}%
                      </span>
                    )}
                  </td>
                  <td className="sb-num">{formatCount(linha.candidatos_abertos)}</td>
                  <td className="sb-num">
                    {linha.vendidos_sem_vinculo > 0 ? (
                      <b className="sb-vnc-vendas-alerta">{formatCount(linha.vendidos_sem_vinculo)}</b>
                    ) : (
                      formatCount(0)
                    )}
                    <small className="sb-vnc-bloco">{formatCurrency(linha.receita_sem_vinculo)}</small>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/*
        A divergência que D-117 mediu: a fila de candidatos só conhece a
        planilha do UpSeller.
      */}
      {porPedidos.some((l) => l.vendidos_sem_vinculo > 0 && l.candidatos_abertos === 0) && (
        <p className="sb-vnc-receita">
          <b>Divergência:</b> há conta com anúncio que vendeu sem vínculo e fila de candidatos vazia. O gerador de
          candidatos só conhece a planilha do UpSeller — esses saem pelo <b>Vincular</b> da tabela.
        </p>
      )}
    </Panel>
  );
}
